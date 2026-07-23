import { NextRequest, NextResponse } from "next/server";
import {
  authenticateApiToken,
  checkpointIdExists,
  findCheckpoint,
  getRuntimeEnv,
  hasCheckpointScopes,
} from "@/db/checkpoints";
import {
  CheckpointUploadOperation,
  CheckpointUploadSession,
  CHECKPOINT_UPLOAD_OPERATIONS,
  MAX_ARCHIVE_BYTES,
  UPLOAD_CHUNK_BYTES,
  uploadSessionKey,
} from "@/lib/checkpoint-objects";
import {
  AgentMetadataError,
  resolveAgentMetadata,
} from "@/lib/agent-metadata";
import {
  PUBLIC_CHECKPOINT_FORMAT_VERSION,
  PublicCheckpointError,
  resolvePublicCheckpointMetadata,
} from "@/lib/public-checkpoint";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const credential = await authenticateApiToken(request);
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
  const operationInput = cleanText(input.operation, 40) || "create-private";
  if (!CHECKPOINT_UPLOAD_OPERATIONS.includes(operationInput as CheckpointUploadOperation)) {
    return NextResponse.json({ error: "Checkpoint upload operation is invalid." }, { status: 400 });
  }
  const operation = operationInput as CheckpointUploadOperation;
  const requiredScopes =
    operation === "create-private"
      ? (["checkpoints:write"] as const)
      : (["checkpoints:write", "checkpoints:publish"] as const);
  if (!hasCheckpointScopes(credential, ...requiredScopes)) {
    return NextResponse.json(
      { error: "This Relay agent credential lacks the required checkpoint scope." },
      { status: 403 },
    );
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
  if (sizeBytes < 1 || sizeBytes > MAX_ARCHIVE_BYTES) {
    return NextResponse.json(
      { error: "Checkpoint archives are limited to 100 MB." },
      { status: 413 },
    );
  }

  let agentMetadata;
  let publicMetadata:
    | ReturnType<typeof resolvePublicCheckpointMetadata>
    | undefined;
  let sourceCiphertextChecksum: string | null = null;
  if (operation === "create-private") {
    if (encryptionVersion !== 2 || cipher !== "AES-256-GCM") {
      return NextResponse.json(
        { error: "Relay accepts only locally encrypted checkpoint format v2." },
        { status: 400 },
      );
    }
    try {
      agentMetadata = resolveAgentMetadata(checkpointId, input);
    } catch (error) {
      return agentMetadataResponse(error);
    }
    if (await checkpointIdExists(checkpointId)) {
      return NextResponse.json({ error: "This checkpoint already exists." }, { status: 409 });
    }
  } else {
    if (encryptionVersion !== 0 || cipher !== "none") {
      return NextResponse.json(
        { error: "Public checkpoints must be an unencrypted gzip/tar archive." },
        { status: 400 },
      );
    }
    if (
      input.publicFormatVersion !== undefined &&
      cleanInteger(input.publicFormatVersion) !== PUBLIC_CHECKPOINT_FORMAT_VERSION
    ) {
      return NextResponse.json(
        { error: "Public checkpoint format version is invalid." },
        { status: 400 },
      );
    }
    try {
      publicMetadata = resolvePublicCheckpointMetadata(input);
    } catch (error) {
      return publicMetadataResponse(error);
    }

    if (operation === "create-public") {
      try {
        agentMetadata = resolveAgentMetadata(checkpointId, input);
      } catch (error) {
        return agentMetadataResponse(error);
      }
      if (await checkpointIdExists(checkpointId)) {
        return NextResponse.json({ error: "This checkpoint already exists." }, { status: 409 });
      }
    } else {
      sourceCiphertextChecksum = cleanText(
        input.sourceCiphertextChecksum,
        100,
      ).toLowerCase();
      if (!/^sha256:[a-f0-9]{64}$/.test(sourceCiphertextChecksum)) {
        return NextResponse.json(
          { error: "The source ciphertext checksum is required." },
          { status: 400 },
        );
      }
      const source = await findCheckpoint(checkpointId, credential.tenantId);
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
        return NextResponse.json(
          { error: "This checkpoint is already public." },
          { status: 409 },
        );
      }
      agentMetadata = {
        agentName: source.agentName,
        agentDescription: source.agentDescription,
        agentMetadataMode: source.agentMetadataMode,
      };
    }
  }

  const uploadId = crypto.randomUUID().replaceAll("-", "");
  const objectPrefix =
    operation === "create-private"
      ? `objects/${crypto.randomUUID()}`
      : `public/objects/${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  const session: CheckpointUploadSession = {
    version: 1,
    operation,
    uploadId,
    tenantId: credential.tenantId,
    userId: credential.userId,
    checkpointId,
    checksum,
    encryptionVersion: operation === "create-private" ? 2 : 0,
    cipher: operation === "create-private" ? "AES-256-GCM" : "none",
    ...agentMetadata,
    ...(publicMetadata
      ? {
          ...publicMetadata,
          publicFormatVersion: PUBLIC_CHECKPOINT_FORMAT_VERSION,
          sourceCiphertextChecksum,
        }
      : {}),
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
      operation,
      checkpointId,
      chunkSize: session.chunkSize,
      partCount: session.partCount,
      sizeBytes,
      agent: {
        name: session.agentName,
        description: session.agentDescription,
        mode: session.agentMetadataMode,
      },
      ...(publicMetadata
        ? {
            publication: {
              title: publicMetadata.publicTitle,
              description: publicMetadata.publicDescription,
              formatVersion: PUBLIC_CHECKPOINT_FORMAT_VERSION,
              sourceCiphertextChecksum,
            },
          }
        : {}),
      expiresAt: session.expiresAt,
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
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

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}
