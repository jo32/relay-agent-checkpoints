import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "../../../lib/principal";
import {
  authenticateApiToken,
  checkpointIdExists,
  getRuntimeEnv,
  insertCheckpoint,
  listCheckpoints,
} from "../../../db/checkpoints";
import { MAX_ARCHIVE_BYTES } from "../../../lib/checkpoint-objects";
import {
  hasValidEncryptedHeader,
  MAX_ENCRYPTED_HEADER_BYTES,
} from "../../../lib/encrypted-checkpoint";

export const dynamic = "force-dynamic";

const ENCRYPTION_VERSION = 2;
const CHECKPOINT_CIPHER = "AES-256-GCM";

export async function GET(request: NextRequest) {
  try {
    const tokenPrincipal = await authenticateApiToken(request, "checkpoints:read");
    const browserPrincipal = tokenPrincipal ? null : await getCurrentPrincipal();
    if (!tokenPrincipal && !browserPrincipal) {
      return NextResponse.json({ error: "Sign in to view checkpoints." }, { status: 401 });
    }
    return NextResponse.json({
      checkpoints: await listCheckpoints(
        tokenPrincipal?.tenantId ?? browserPrincipal!.tenantId,
      ),
    });
  } catch (error) {
    console.error("Unable to list checkpoints", error);
    return NextResponse.json(
      { error: "Checkpoint storage is not available yet." },
      { status: 503 },
    );
  }
}

export async function POST(request: NextRequest) {
  const credential = await authenticateApiToken(request, "checkpoints:write");
  if (!credential) {
    return NextResponse.json(
      { error: "A valid Relay agent credential is required." },
      { status: 401 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected a checkpoint archive." }, { status: 400 });
  }

  const archive = form.get("archive");
  const requestedId = cleanText(form.get("checkpointId"), 90);
  const checksum = cleanText(form.get("checksum"), 100);
  const encryptionVersion = cleanInteger(form.get("encryptionVersion"));
  const cipher = cleanText(form.get("cipher"), 40);

  if (!(archive instanceof File) || archive.size === 0) {
    return NextResponse.json({ error: "A checkpoint archive is required." }, { status: 400 });
  }
  if (archive.size > MAX_ARCHIVE_BYTES) {
    return NextResponse.json(
      { error: "Checkpoint archives are limited to 100 MB in this preview." },
      { status: 413 },
    );
  }
  if (
    archive.type !== "application/vnd.relay.checkpoint" ||
    encryptionVersion !== ENCRYPTION_VERSION ||
    cipher !== CHECKPOINT_CIPHER
  ) {
    return NextResponse.json(
      { error: "Relay accepts only locally encrypted checkpoint format v2." },
      { status: 400 },
    );
  }
  if (!/^sha256:[a-f0-9]{64}$/i.test(checksum)) {
    return NextResponse.json({ error: "A valid archive checksum is required." }, { status: 400 });
  }

  if (!/^cp_[a-z0-9_-]{6,80}$/i.test(requestedId)) {
    return NextResponse.json(
      { error: "Encrypted checkpoints require a valid client-generated ID." },
      { status: 400 },
    );
  }
  const headerBytes = new Uint8Array(
    await archive.slice(0, MAX_ENCRYPTED_HEADER_BYTES + 13).arrayBuffer(),
  );
  if (!hasValidEncryptedHeader(headerBytes, requestedId)) {
    return NextResponse.json(
      { error: "Checkpoint encryption header is invalid or does not match its ID." },
      { status: 400 },
    );
  }

  const id = requestedId;
  const objectKey = `objects/${crypto.randomUUID()}.relay`;
  const createdAt = new Date().toISOString();
  if (await checkpointIdExists(id)) {
    return NextResponse.json(
      { error: "This checkpoint already exists." },
      { status: 409 },
    );
  }

  let storage: R2Bucket | null = null;
  try {
    storage = getRuntimeEnv().CHECKPOINTS;
    await storage.put(objectKey, archive.stream(), {
      httpMetadata: {
        contentType: "application/vnd.relay.checkpoint",
        contentDisposition: `attachment; filename="${id}.relay"`,
      },
      customMetadata: {
        checkpointId: id,
        checksum,
        cipher,
        encryptionVersion: String(encryptionVersion),
      },
    });

    await insertCheckpoint({
      id,
      ownerKey: credential.tenantId,
      tenantId: credential.tenantId,
      createdByUserId: credential.userId,
      workspaceName: "Private workspace",
      label: "Encrypted checkpoint",
      sourceAgent: "Local checkpoint skill",
      status: "ready",
      createdAt,
      sizeBytes: archive.size,
      fileCount: 0,
      excludedCount: 0,
      parentId: null,
      handoff: "",
      objectKey,
      checksum,
      encryptionVersion,
      cipher,
    });
  } catch (error) {
    if (storage) await storage.delete(objectKey).catch(() => undefined);
    console.error("Unable to store checkpoint", error);
    return NextResponse.json(
      { error: "The checkpoint could not be stored. Please try again." },
      { status: 503 },
    );
  }

  return NextResponse.json(
    {
      checkpoint: {
        id,
        workspaceName: "Private workspace",
        label: "Encrypted checkpoint",
        sourceAgent: "Local checkpoint skill",
        status: "ready",
        createdAt,
        sizeBytes: archive.size,
        fileCount: 0,
        excludedCount: 0,
        parentId: null,
        handoff: "",
        checksum,
        encryptionVersion,
        cipher,
      },
    },
    { status: 201 },
  );
}

function cleanText(value: FormDataEntryValue | null, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanInteger(value: FormDataEntryValue | null) {
  const parsed = Number.parseInt(typeof value === "string" ? value : "0", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
