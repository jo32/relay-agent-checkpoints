import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "../../../lib/principal";
import {
  authenticateApiToken,
  checkpointIdExists,
  CheckpointPublicationRecord,
  findCheckpoint,
  getRuntimeEnv,
  hasCheckpointScopes,
  insertCheckpoint,
  insertPublicationForExistingCheckpoint,
  insertPublicCheckpoint,
  listCheckpoints,
  StoredCheckpointRecord,
  toOwnerCheckpointDto,
} from "../../../db/checkpoints";
import {
  CHECKPOINT_UPLOAD_OPERATIONS,
  CheckpointUploadOperation,
  MAX_ARCHIVE_BYTES,
} from "../../../lib/checkpoint-objects";
import {
  hasValidEncryptedHeader,
  MAX_ENCRYPTED_HEADER_BYTES,
} from "../../../lib/encrypted-checkpoint";
import {
  AgentMetadataError,
  resolveAgentMetadata,
} from "../../../lib/agent-metadata";
import {
  hasGzipHeader,
  PUBLIC_CHECKPOINT_CONTENT_TYPE,
  PUBLIC_CHECKPOINT_FORMAT_VERSION,
  PublicCheckpointError,
  resolvePublicCheckpointMetadata,
  validatePublicCheckpointArchive,
} from "../../../lib/public-checkpoint";

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
  const credential = await authenticateApiToken(request);
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
  const operationInput = cleanText(form.get("operation"), 40) || "create-private";
  if (!CHECKPOINT_UPLOAD_OPERATIONS.includes(operationInput as CheckpointUploadOperation)) {
    return NextResponse.json({ error: "Checkpoint upload operation is invalid." }, { status: 400 });
  }
  const operation = operationInput as CheckpointUploadOperation;
  if (
    !hasCheckpointScopes(credential, "checkpoints:write") ||
    (operation !== "create-private" &&
      !hasCheckpointScopes(credential, "checkpoints:publish"))
  ) {
    return NextResponse.json(
      { error: "This Relay agent credential lacks the required checkpoint scope." },
      { status: 403 },
    );
  }

  const archive = form.get("archive");
  const requestedId = cleanText(form.get("checkpointId"), 90);
  const checksum = cleanText(form.get("checksum"), 100).toLowerCase();
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
  if (!/^sha256:[a-f0-9]{64}$/.test(checksum)) {
    return NextResponse.json({ error: "A valid archive checksum is required." }, { status: 400 });
  }
  if (!/^cp_[a-z0-9_-]{6,80}$/i.test(requestedId)) {
    return NextResponse.json(
      { error: "Checkpoints require a valid client-generated ID." },
      { status: 400 },
    );
  }

  const bytes = new Uint8Array(await archive.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const actualChecksum = `sha256:${toHex(new Uint8Array(digest))}`;
  if (actualChecksum !== checksum) {
    return NextResponse.json(
      { error: "The archive checksum does not match the uploaded file." },
      { status: 400 },
    );
  }

  if (operation === "create-private") {
    return storeDirectPrivateCheckpoint(
      archive,
      bytes,
      digest,
      requestedId,
      checksum,
      encryptionVersion,
      cipher,
      form,
      credential,
    );
  }
  return storeDirectPublicCheckpoint(
    archive,
    bytes,
    digest,
    requestedId,
    checksum,
    encryptionVersion,
    cipher,
    form,
    credential,
    operation,
  );
}

async function storeDirectPrivateCheckpoint(
  archive: File,
  bytes: Uint8Array,
  digest: ArrayBuffer,
  id: string,
  checksum: string,
  encryptionVersion: number,
  cipher: string,
  form: FormData,
  credential: NonNullable<Awaited<ReturnType<typeof authenticateApiToken>>>,
) {
  let agentMetadata;
  try {
    agentMetadata = resolveAgentMetadata(id, {
      agentName: form.get("agentName"),
      agentDescription: form.get("agentDescription"),
      agentMetadataMode: form.get("agentMetadataMode"),
    });
  } catch (error) {
    return agentMetadataResponse(error);
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
  if (
    !hasValidEncryptedHeader(
      bytes.subarray(0, MAX_ENCRYPTED_HEADER_BYTES + 13),
      id,
    )
  ) {
    return NextResponse.json(
      { error: "Checkpoint encryption header is invalid or does not match its ID." },
      { status: 400 },
    );
  }
  if (await checkpointIdExists(id)) {
    return NextResponse.json({ error: "This checkpoint already exists." }, { status: 409 });
  }

  const objectKey = `objects/${crypto.randomUUID()}.relay`;
  const createdAt = new Date().toISOString();
  const checkpoint: StoredCheckpointRecord = {
    id,
    ownerKey: credential.tenantId,
    tenantId: credential.tenantId,
    createdByUserId: credential.userId,
    workspaceName: "Private workspace",
    label: "Encrypted checkpoint",
    sourceAgent: "Local checkpoint skill",
    ...agentMetadata,
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
  };
  const storage = getRuntimeEnv().CHECKPOINTS;
  try {
    await storage.put(objectKey, bytes, {
      sha256: digest,
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
    await insertCheckpoint(checkpoint);
  } catch (error) {
    await storage.delete(objectKey).catch(() => undefined);
    console.error("Unable to store checkpoint", error);
    return NextResponse.json(
      { error: "The checkpoint could not be stored. Please try again." },
      { status: 503 },
    );
  }
  const stored = await findCheckpoint(id, credential.tenantId);
  return NextResponse.json(
    { checkpoint: stored ? toOwnerCheckpointDto(stored) : checkpoint },
    { status: 201 },
  );
}

async function storeDirectPublicCheckpoint(
  archive: File,
  bytes: Uint8Array,
  digest: ArrayBuffer,
  id: string,
  checksum: string,
  encryptionVersion: number,
  cipher: string,
  form: FormData,
  credential: NonNullable<Awaited<ReturnType<typeof authenticateApiToken>>>,
  operation: Exclude<CheckpointUploadOperation, "create-private">,
) {
  if (
    archive.type !== PUBLIC_CHECKPOINT_CONTENT_TYPE ||
    encryptionVersion !== 0 ||
    cipher !== "none"
  ) {
    return NextResponse.json(
      { error: "Public checkpoints must be an unencrypted gzip/tar archive." },
      { status: 400 },
    );
  }
  if (
    form.has("publicFormatVersion") &&
    cleanInteger(form.get("publicFormatVersion")) !== PUBLIC_CHECKPOINT_FORMAT_VERSION
  ) {
    return NextResponse.json(
      { error: "Public checkpoint format version is invalid." },
      { status: 400 },
    );
  }
  let publicMetadata;
  try {
    publicMetadata = resolvePublicCheckpointMetadata({
      publicTitle: form.get("publicTitle"),
      publicDescription: form.get("publicDescription"),
    });
  } catch (error) {
    return publicMetadataResponse(error);
  }
  if (
    !hasGzipHeader(bytes) ||
    !(await validatePublicCheckpointArchive(archive.stream(), {
      checkpointId: id,
      title: publicMetadata.publicTitle,
      description: publicMetadata.publicDescription,
    }))
  ) {
    return NextResponse.json(
      { error: "Public checkpoint is not a valid gzip/tar archive." },
      { status: 400 },
    );
  }

  let agentMetadata;
  let sourceCiphertextChecksum: string | null = null;
  if (operation === "create-public") {
    try {
      agentMetadata = resolveAgentMetadata(id, {
        agentName: form.get("agentName"),
        agentDescription: form.get("agentDescription"),
        agentMetadataMode: form.get("agentMetadataMode"),
      });
    } catch (error) {
      return agentMetadataResponse(error);
    }
    if (await checkpointIdExists(id)) {
      return NextResponse.json({ error: "This checkpoint already exists." }, { status: 409 });
    }
  } else {
    sourceCiphertextChecksum = cleanText(
      form.get("sourceCiphertextChecksum"),
      100,
    ).toLowerCase();
    if (!/^sha256:[a-f0-9]{64}$/.test(sourceCiphertextChecksum)) {
      return NextResponse.json(
        { error: "The source ciphertext checksum is required." },
        { status: 400 },
      );
    }
    const source = await findCheckpoint(id, credential.tenantId);
    if (
      !source ||
      !credential.userId ||
      source.createdByUserId !== credential.userId
    ) {
      return NextResponse.json({ error: "Checkpoint not found." }, { status: 404 });
    }
    if (
      source.encryptionVersion < 2 ||
      source.checksum.toLowerCase() !== sourceCiphertextChecksum
    ) {
      return NextResponse.json(
        { error: "The source ciphertext checksum does not match." },
        { status: 409 },
      );
    }
    if (source.publication) {
      const samePublication =
        source.publication.checksum.toLowerCase() === checksum &&
        source.publication.title === publicMetadata.publicTitle &&
        source.publication.description === publicMetadata.publicDescription &&
        source.publication.sourceCiphertextChecksum === sourceCiphertextChecksum;
      return samePublication
        ? NextResponse.json(
            { checkpoint: toOwnerCheckpointDto(source) },
            { headers: { "cache-control": "no-store" } },
          )
        : NextResponse.json(
            { error: "This checkpoint already has a different immutable publication." },
            { status: 409 },
          );
    }
    agentMetadata = {
      agentName: source.agentName,
      agentDescription: source.agentDescription,
      agentMetadataMode: source.agentMetadataMode,
    };
  }

  const objectKey = `public/objects/${crypto.randomUUID()}.tar.gz`;
  const publishedAt = new Date().toISOString();
  const publication: CheckpointPublicationRecord = {
    checkpointId: id,
    tenantId: credential.tenantId,
    objectKey,
    checksum,
    sizeBytes: archive.size,
    formatVersion: PUBLIC_CHECKPOINT_FORMAT_VERSION,
    sourceCiphertextChecksum,
    publicTitle: publicMetadata.publicTitle,
    publicDescription: publicMetadata.publicDescription,
    publishedAt,
    publishedByUserId: credential.userId,
  };
  const storage = getRuntimeEnv().CHECKPOINTS;
  try {
    await storage.put(objectKey, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: digest,
      httpMetadata: {
        contentType: PUBLIC_CHECKPOINT_CONTENT_TYPE,
        contentDisposition: `attachment; filename="${id}.tar.gz"`,
      },
      customMetadata: {
        checkpointId: id,
        checksum,
        cipher: "none",
        encryptionVersion: "0",
        publicFormatVersion: String(PUBLIC_CHECKPOINT_FORMAT_VERSION),
      },
    });
    if (operation === "create-public") {
      await insertPublicCheckpoint(
        {
          id,
          ownerKey: credential.tenantId,
          tenantId: credential.tenantId,
          createdByUserId: credential.userId,
          workspaceName: "Public workspace",
          label: publicMetadata.publicTitle,
          sourceAgent: "Local checkpoint skill",
          ...agentMetadata,
          status: "ready",
          createdAt: publishedAt,
          sizeBytes: archive.size,
          fileCount: 0,
          excludedCount: 0,
          parentId: null,
          handoff: "",
          objectKey,
          checksum,
          encryptionVersion: 0,
          cipher: "none",
        },
        publication,
      );
    } else {
      const result = await insertPublicationForExistingCheckpoint(publication);
      if (result !== "created") {
        throw new PublicationConflictError(result);
      }
    }
  } catch (error) {
    await storage.delete(objectKey).catch(() => undefined);
    if (error instanceof PublicationConflictError) {
      const status = error.result === "not-found" ? 404 : 409;
      return NextResponse.json(
        {
          error:
            error.result === "not-found"
              ? "Checkpoint not found."
              : error.result === "source-mismatch"
                ? "The source ciphertext checksum does not match."
                : "This checkpoint already has an immutable publication.",
        },
        { status },
      );
    }
    console.error("Unable to store public checkpoint", error);
    return NextResponse.json(
      { error: "The public checkpoint could not be stored. Please try again." },
      { status: 503 },
    );
  }

  const checkpoint = await findCheckpoint(id, credential.tenantId);
  if (!checkpoint) {
    return NextResponse.json({ error: "Checkpoint not found." }, { status: 503 });
  }
  return NextResponse.json(
    { checkpoint: toOwnerCheckpointDto(checkpoint) },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}

class PublicationConflictError extends Error {
  constructor(
    readonly result: Exclude<
      Awaited<ReturnType<typeof insertPublicationForExistingCheckpoint>>,
      "created"
    >,
  ) {
    super(result);
  }
}

function agentMetadataResponse(error: unknown) {
  if (error instanceof AgentMetadataError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  throw error;
}

function publicMetadataResponse(error: unknown) {
  if (error instanceof PublicCheckpointError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  throw error;
}

function cleanText(value: FormDataEntryValue | null, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanInteger(value: FormDataEntryValue | null) {
  const parsed = Number.parseInt(typeof value === "string" ? value : "0", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function toHex(value: Uint8Array) {
  return [...value]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
