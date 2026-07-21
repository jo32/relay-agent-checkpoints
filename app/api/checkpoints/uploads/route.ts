import { NextRequest, NextResponse } from "next/server";
import {
  authenticateApiToken,
  checkpointIdExists,
  getRuntimeEnv,
} from "@/db/checkpoints";
import {
  CheckpointUploadSession,
  MAX_ARCHIVE_BYTES,
  UPLOAD_CHUNK_BYTES,
  uploadSessionKey,
} from "@/lib/checkpoint-objects";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const credential = await authenticateApiToken(request, "checkpoints:write");
  if (!credential) {
    return NextResponse.json(
      { error: "A valid Relay agent credential is required." },
      { status: 401 },
    );
  }

  let input: Record<string, unknown>;
  try {
    input = await request.json<Record<string, unknown>>();
  } catch {
    return NextResponse.json({ error: "Expected upload metadata as JSON." }, { status: 400 });
  }
  const checkpointId = cleanText(input.checkpointId, 90);
  const checksum = cleanText(input.checksum, 100).toLowerCase();
  const encryptionVersion = cleanInteger(input.encryptionVersion);
  const cipher = cleanText(input.cipher, 40);
  const sizeBytes = cleanInteger(input.sizeBytes);
  if (!/^cp_[a-z0-9_-]{6,80}$/i.test(checkpointId)) {
    return NextResponse.json({ error: "Checkpoint ID is invalid." }, { status: 400 });
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(checksum)) {
    return NextResponse.json({ error: "Archive checksum is invalid." }, { status: 400 });
  }
  if (encryptionVersion !== 2 || cipher !== "AES-256-GCM") {
    return NextResponse.json(
      { error: "Relay accepts only locally encrypted checkpoint format v2." },
      { status: 400 },
    );
  }
  if (sizeBytes < 1 || sizeBytes > MAX_ARCHIVE_BYTES) {
    return NextResponse.json(
      { error: "Checkpoint archives are limited to 100 MB." },
      { status: 413 },
    );
  }
  if (await checkpointIdExists(checkpointId)) {
    return NextResponse.json({ error: "This checkpoint already exists." }, { status: 409 });
  }

  const uploadId = crypto.randomUUID().replaceAll("-", "");
  const objectPrefix = `objects/${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  const session: CheckpointUploadSession = {
    version: 1,
    uploadId,
    tenantId: credential.tenantId,
    userId: credential.userId,
    checkpointId,
    checksum,
    encryptionVersion: 2,
    cipher: "AES-256-GCM",
    sizeBytes,
    chunkSize: UPLOAD_CHUNK_BYTES,
    partCount: Math.ceil(sizeBytes / UPLOAD_CHUNK_BYTES),
    objectPrefix,
    objectKey: `${objectPrefix}/manifest.json`,
    createdAt,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    status: "pending",
  };
  try {
    await getRuntimeEnv().CHECKPOINTS.put(
      uploadSessionKey(uploadId),
      JSON.stringify(session),
      { httpMetadata: { contentType: "application/json" } },
    );
  } catch (error) {
    console.error("Unable to initialize checkpoint upload", error);
    return NextResponse.json({ error: "Upload could not be initialized." }, { status: 503 });
  }

  return NextResponse.json(
    {
      uploadId,
      checkpointId,
      chunkSize: session.chunkSize,
      partCount: session.partCount,
      sizeBytes,
      expiresAt: session.expiresAt,
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}
