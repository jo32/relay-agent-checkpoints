import { NextRequest, NextResponse } from "next/server";
import {
  authenticateApiToken,
  CheckpointPublicationRecord,
  checkpointIdExists,
  findCheckpoint,
  getRuntimeEnv,
  hasCheckpointScopes,
  insertCheckpoint,
  insertPublicationForExistingCheckpoint,
  insertPublicCheckpoint,
  StoredCheckpointRecord,
  toOwnerCheckpointDto,
} from "@/db/checkpoints";
import {
  claimUploadCompletion,
  checkpointArtifactMetadata,
  checkpointUploadOperation,
  ChunkedCheckpointManifest,
  completionLeaseRetryAfterSeconds,
  hasActiveCompletionLease,
  isPublicUploadSession,
  LoadedCheckpointUploadSession,
  loadUploadSessionRecord,
  streamChunkObjects,
  transitionUploadSession,
  uploadPartKey,
  validateCheckpointChunks,
} from "@/lib/checkpoint-objects";
import {
  hasValidEncryptedHeader,
  MAX_ENCRYPTED_HEADER_BYTES,
} from "@/lib/encrypted-checkpoint";
import {
  hasGzipHeader,
  PUBLIC_CHECKPOINT_FORMAT_VERSION,
  validatePublicCheckpointArchive,
} from "@/lib/public-checkpoint";
import { isLocalPreviewEnabled } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ uploadId: string }> },
) {
  const credential = await authenticateApiToken(request);
  if (!credential) {
    return NextResponse.json(
      { error: "A valid Relay agent credential is required." },
      { status: 401 },
    );
  }
  const { uploadId } = await context.params;
  const storage = getRuntimeEnv().CHECKPOINTS;
  const loaded = await loadUploadSessionRecord(storage, uploadId);
  if (!loaded || loaded.session.tenantId !== credential.tenantId) {
    return NextResponse.json({ error: "Upload session not found." }, { status: 404 });
  }
  const session = loaded.session;
  const publicUpload = isPublicUploadSession(session);
  if (
    !hasCheckpointScopes(credential, "checkpoints:write") ||
    (publicUpload && !hasCheckpointScopes(credential, "checkpoints:publish"))
  ) {
    return NextResponse.json(
      { error: "This Relay agent credential lacks the required checkpoint scope." },
      { status: 403 },
    );
  }

  const operation = checkpointUploadOperation(session);
  const artifactMetadata = checkpointArtifactMetadata(session);
  const idempotent = await completedCheckpoint(session, credential.tenantId);
  if (session.status === "completed") {
    if (idempotent && publicationMatchesSession(idempotent, session)) {
      await deleteTemporaryParts(storage, session);
      return NextResponse.json(
        { checkpoint: toOwnerCheckpointDto(idempotent) },
        { headers: { "cache-control": "no-store" } },
      );
    }
    return NextResponse.json(
      { error: "Completed checkpoint does not match this upload session." },
      { status: 409 },
    );
  }
  if (idempotent && publicationMatchesSession(idempotent, session)) {
    await markCompleted(storage, loaded);
    await deleteTemporaryParts(storage, session);
    return NextResponse.json(
      { checkpoint: toOwnerCheckpointDto(idempotent) },
      { headers: { "cache-control": "no-store" } },
    );
  }
  if (session.status === "aborting") {
    return NextResponse.json(
      { error: "Checkpoint upload is already being finalized." },
      { status: 409 },
    );
  }
  if (hasActiveCompletionLease(session)) {
    return activeCompletionResponse(session);
  }
  if (
    session.status === "pending" &&
    session.expiresAt <= new Date().toISOString()
  ) {
    return NextResponse.json({ error: "Upload session expired." }, { status: 410 });
  }

  let validated;
  try {
    validated = await validateCheckpointChunks(
      storage,
      session,
      publicUpload ? 3 : MAX_ENCRYPTED_HEADER_BYTES + 13,
    );
  } catch (error) {
    console.error("Unable to validate checkpoint chunks", error);
    return NextResponse.json(
      { error: "Checkpoint upload could not be validated." },
      { status: 503 },
    );
  }
  if (!validated) {
    return NextResponse.json(
      { error: "One or more upload parts are missing or invalid." },
      { status: 409 },
    );
  }
  if (validated.checksum !== session.checksum.toLowerCase()) {
    return NextResponse.json(
      { error: "The archive checksum does not match the uploaded chunks." },
      { status: 400 },
    );
  }

  if (operation === "create-private") {
    if (!hasValidEncryptedHeader(validated.firstBytes, session.checkpointId)) {
      return NextResponse.json(
        { error: "Checkpoint encryption header is invalid or does not match its ID." },
        { status: 400 },
      );
    }
    if (await checkpointIdExists(session.checkpointId)) {
      return NextResponse.json({ error: "This checkpoint already exists." }, { status: 409 });
    }
  } else {
    if (!hasGzipHeader(validated.firstBytes)) {
      return NextResponse.json(
        { error: "Public checkpoint gzip header is invalid." },
        { status: 400 },
      );
    }
    const validArchive = await validatePublicCheckpointArchive(
      streamChunkObjects(storage, validated.chunks),
      {
        checkpointId: session.checkpointId,
        title: session.publicTitle!,
        description: session.publicDescription!,
        artifactType: artifactMetadata.artifactType,
        skillName: artifactMetadata.skillName,
        skillDescription: artifactMetadata.skillDescription,
      },
    );
    if (!validArchive) {
      return NextResponse.json(
        { error: "Public checkpoint is not a valid gzip/tar archive." },
        { status: 400 },
      );
    }
    if (operation === "create-public" && (await checkpointIdExists(session.checkpointId))) {
      return NextResponse.json({ error: "This checkpoint already exists." }, { status: 409 });
    }
    if (operation === "publish-existing") {
      const source = await findCheckpoint(session.checkpointId, credential.tenantId);
      if (
        !source ||
        !credential.userId ||
        source.createdByUserId !== credential.userId
      ) {
        return NextResponse.json({ error: "Checkpoint not found." }, { status: 404 });
      }
      if (
        source.encryptionVersion < 2 ||
        source.checksum.toLowerCase() !==
          session.sourceCiphertextChecksum?.toLowerCase()
      ) {
        return NextResponse.json(
          { error: "The source ciphertext checksum does not match." },
          { status: 409 },
        );
      }
      if (source.publication) {
        return NextResponse.json(
          { error: "This checkpoint already has a different immutable publication." },
          { status: 409 },
        );
      }
    }
  }

  const latest = await loadUploadSessionRecord(storage, uploadId);
  if (!latest || latest.session.tenantId !== credential.tenantId) {
    return NextResponse.json({ error: "Upload session not found." }, { status: 404 });
  }
  const alreadyCompleted = await completedCheckpoint(
    latest.session,
    credential.tenantId,
  );
  if (
    alreadyCompleted &&
    publicationMatchesSession(alreadyCompleted, latest.session)
  ) {
    await markCompleted(storage, latest);
    await deleteTemporaryParts(storage, latest.session);
    return NextResponse.json(
      { checkpoint: toOwnerCheckpointDto(alreadyCompleted) },
      { headers: { "cache-control": "no-store" } },
    );
  }
  if (
    latest.session.status !== "pending" &&
    latest.session.status !== "completing"
  ) {
    return NextResponse.json(
      { error: "Checkpoint upload is already being finalized." },
      { status: 409 },
    );
  }
  if (
    latest.session.status === "pending" &&
    latest.session.expiresAt <= new Date().toISOString()
  ) {
    return NextResponse.json({ error: "Upload session expired." }, { status: 410 });
  }
  if (hasActiveCompletionLease(latest.session)) {
    return activeCompletionResponse(latest.session);
  }
  const completionFault = localCompletionFault(request);
  const claimed = await claimUploadCompletion(
    storage,
    latest,
    completionFault === "before-durable-active"
      ? 1000
      : completionFault
        ? 0
        : undefined,
  );
  if (!claimed) {
    return NextResponse.json(
      { error: "Checkpoint upload state changed; retry completion." },
      { status: 409 },
    );
  }

  const manifest: ChunkedCheckpointManifest = {
    version: 1,
    checkpointId: session.checkpointId,
    ...artifactMetadata,
    sizeBytes: session.sizeBytes,
    chunks: validated.chunks,
  };
  const publishedAt = new Date().toISOString();
  const publication =
    publicUpload && session.publicTitle && session.publicDescription
      ? ({
          checkpointId: session.checkpointId,
          tenantId: credential.tenantId,
          objectKey: session.objectKey,
          checksum: validated.checksum,
          sizeBytes: session.sizeBytes,
          formatVersion: PUBLIC_CHECKPOINT_FORMAT_VERSION,
          sourceCiphertextChecksum:
            operation === "publish-existing"
              ? session.sourceCiphertextChecksum ?? null
              : null,
          publicTitle: session.publicTitle,
          publicDescription: session.publicDescription,
          publishedAt,
          publishedByUserId: credential.userId,
        } satisfies CheckpointPublicationRecord)
      : null;

  try {
    if (
      completionFault === "before-durable" ||
      completionFault === "before-durable-active"
    ) {
      return simulatedCompletionInterruption();
    }
    const storedManifest = await storage.put(
      session.objectKey,
      JSON.stringify(manifest),
      {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json" },
        customMetadata: {
          checkpointId: session.checkpointId,
          checksum: session.checksum,
          cipher: session.cipher,
          encryptionVersion: String(session.encryptionVersion),
          operation,
          artifactType: artifactMetadata.artifactType,
          ...(artifactMetadata.artifactType === "skill"
            ? { skillName: artifactMetadata.skillName! }
            : {}),
          ...(publicUpload
            ? {
                contentType: "application/vnd.relay.public-checkpoint+gzip",
                publicFormatVersion: String(PUBLIC_CHECKPOINT_FORMAT_VERSION),
              }
            : {}),
        },
      },
    );
    if (!storedManifest) {
      const existingManifest = await storage.get(session.objectKey);
      if (!existingManifest || (await existingManifest.text()) !== JSON.stringify(manifest)) {
        await releaseCompletion(storage, claimed);
        return NextResponse.json(
          { error: "Checkpoint upload completion conflicted with another request." },
          { status: 409 },
        );
      }
    }

    if (operation === "create-private") {
      await insertCheckpoint(privateCheckpointRecord(session, publishedAt));
    } else if (operation === "create-public" && publication) {
      await insertPublicCheckpoint(
        directPublicCheckpointRecord(session, publishedAt),
        publication,
      );
    } else if (operation === "publish-existing" && publication) {
      const result = await insertPublicationForExistingCheckpoint(publication);
      if (result !== "created") {
        const existing = await findCheckpoint(session.checkpointId, credential.tenantId);
        if (
          result === "exists" &&
          existing &&
          publicationMatchesSession(existing, session)
        ) {
          await markCompleted(storage, claimed);
          await deleteTemporaryParts(storage, session);
          return NextResponse.json(
            { checkpoint: toOwnerCheckpointDto(existing) },
            { headers: { "cache-control": "no-store" } },
          );
        }
        await storage.delete(session.objectKey).catch(() => undefined);
        await releaseCompletion(storage, claimed);
        const status = result === "not-found" ? 404 : 409;
        const error =
          result === "not-found"
            ? "Checkpoint not found."
            : result === "source-mismatch"
              ? "The source ciphertext checksum does not match."
              : "This checkpoint already has a different immutable publication.";
        return NextResponse.json({ error }, { status });
      }
    } else {
      throw new Error("Public upload metadata is incomplete.");
    }
    if (completionFault === "after-durable") {
      return simulatedCompletionInterruption();
    }
  } catch (error) {
    let existing: Awaited<ReturnType<typeof findCheckpoint>>;
    try {
      existing = await findCheckpoint(
        session.checkpointId,
        credential.tenantId,
      );
    } catch (lookupError) {
      // The D1 write may have committed even if its response failed. Keep the
      // sealed candidate and completion claim until a retry can verify D1.
      console.error(
        "Unable to verify checkpoint after completion failure",
        lookupError,
      );
      return NextResponse.json(
        { error: "Checkpoint upload completion could not be verified." },
        { status: 503 },
      );
    }
    if (existing && publicationMatchesSession(existing, session)) {
      await markCompleted(storage, claimed);
      await deleteTemporaryParts(storage, session);
      return NextResponse.json(
        { checkpoint: toOwnerCheckpointDto(existing) },
        { headers: { "cache-control": "no-store" } },
      );
    }
    await storage.delete(session.objectKey).catch(() => undefined);
    await releaseCompletion(storage, claimed);
    console.error("Unable to complete checkpoint upload", error);
    return NextResponse.json(
      { error: "Checkpoint upload could not be completed." },
      { status: 503 },
    );
  }

  const checkpoint = await findCheckpoint(
    session.checkpointId,
    credential.tenantId,
  );
  if (!checkpoint) {
    return NextResponse.json(
      { error: "Completed checkpoint was not found." },
      { status: 503 },
    );
  }
  await markCompleted(storage, claimed);
  await deleteTemporaryParts(storage, session);
  return NextResponse.json(
    { checkpoint: toOwnerCheckpointDto(checkpoint) },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}

async function completedCheckpoint(
  session: Parameters<typeof checkpointUploadOperation>[0],
  tenantId: string,
) {
  const checkpoint = await findCheckpoint(session.checkpointId, tenantId);
  if (!checkpoint) return null;
  const operation = checkpointUploadOperation(session);
  if (operation === "create-private") {
    return checkpoint.objectKey === session.objectKey &&
      checkpoint.checksum.toLowerCase() === session.checksum.toLowerCase()
      ? checkpoint
      : null;
  }
  return checkpoint.publication ? checkpoint : null;
}

function publicationMatchesSession(
  checkpoint: NonNullable<Awaited<ReturnType<typeof findCheckpoint>>>,
  session: Parameters<typeof checkpointUploadOperation>[0],
) {
  const operation = checkpointUploadOperation(session);
  const artifactMetadata = checkpointArtifactMetadata(session);
  const artifactMatches =
    checkpoint.artifactType === artifactMetadata.artifactType &&
    checkpoint.skillName === artifactMetadata.skillName &&
    checkpoint.skillDescription === artifactMetadata.skillDescription;
  if (operation === "create-private") {
    return (
      artifactMatches &&
      checkpoint.visibility === "private" &&
      checkpoint.objectKey === session.objectKey &&
      checkpoint.checksum.toLowerCase() === session.checksum.toLowerCase()
    );
  }
  return (
    artifactMatches &&
    checkpoint.publication?.checksum.toLowerCase() === session.checksum.toLowerCase() &&
    checkpoint.publication.title === session.publicTitle &&
    checkpoint.publication.description === session.publicDescription &&
    checkpoint.publication.sourceCiphertextChecksum ===
      (operation === "publish-existing"
        ? session.sourceCiphertextChecksum ?? null
        : null)
  );
}

function privateCheckpointRecord(
  session: Parameters<typeof checkpointUploadOperation>[0],
  createdAt: string,
): StoredCheckpointRecord {
  const artifact = checkpointArtifactMetadata(session);
  return {
    id: session.checkpointId,
    ownerKey: session.tenantId,
    tenantId: session.tenantId,
    createdByUserId: session.userId,
    workspaceName: "Private workspace",
    label: "Encrypted checkpoint",
    sourceAgent: "Local checkpoint skill",
    ...artifact,
    agentName: session.agentName,
    agentDescription: session.agentDescription,
    agentMetadataMode: session.agentMetadataMode,
    status: "ready",
    createdAt,
    sizeBytes: session.sizeBytes,
    fileCount: 0,
    excludedCount: 0,
    parentId: null,
    handoff: "",
    objectKey: session.objectKey,
    checksum: session.checksum,
    encryptionVersion: 2,
    cipher: "AES-256-GCM",
  };
}

function directPublicCheckpointRecord(
  session: Parameters<typeof checkpointUploadOperation>[0],
  createdAt: string,
): StoredCheckpointRecord {
  const artifact = checkpointArtifactMetadata(session);
  return {
    id: session.checkpointId,
    ownerKey: session.tenantId,
    tenantId: session.tenantId,
    createdByUserId: session.userId,
    workspaceName: "Public workspace",
    label: session.publicTitle ?? "Public checkpoint",
    sourceAgent: "Local checkpoint skill",
    ...artifact,
    agentName: session.agentName,
    agentDescription: session.agentDescription,
    agentMetadataMode: session.agentMetadataMode,
    status: "ready",
    createdAt,
    sizeBytes: session.sizeBytes,
    fileCount: 0,
    excludedCount: 0,
    parentId: null,
    handoff: "",
    objectKey: session.objectKey,
    checksum: session.checksum,
    encryptionVersion: 0,
    cipher: "none",
  };
}

async function markCompleted(
  storage: R2Bucket,
  loaded: LoadedCheckpointUploadSession,
) {
  try {
    const completed = await transitionUploadSession(
      storage,
      loaded,
      "completed",
    );
    if (!completed) {
      console.error("Unable to mark completed checkpoint upload session: state changed");
    }
  } catch (error) {
    // The durable checkpoint/publication is authoritative. A retry recovers
    // idempotently even if this best-effort session marker could not be saved.
    console.error("Unable to mark completed checkpoint upload session", error);
  }
}

async function releaseCompletion(
  storage: R2Bucket,
  loaded: LoadedCheckpointUploadSession,
) {
  try {
    await transitionUploadSession(storage, loaded, "pending");
  } catch (error) {
    console.error("Unable to release checkpoint completion claim", error);
  }
}

async function deleteTemporaryParts(
  storage: R2Bucket,
  session: Parameters<typeof checkpointUploadOperation>[0],
) {
  try {
    await storage.delete(
      Array.from(
        { length: session.partCount },
        (_, index) => uploadPartKey(session, index + 1),
      ),
    );
  } catch (error) {
    // Sealed chunks are authoritative; leftover upload parts are harmless and
    // can be collected later.
    console.error("Unable to remove temporary checkpoint upload parts", error);
  }
}

function activeCompletionResponse(
  session: Parameters<typeof checkpointUploadOperation>[0],
) {
  const retryAfter = completionLeaseRetryAfterSeconds(session);
  return NextResponse.json(
    { error: "Checkpoint upload completion is already in progress." },
    {
      status: 409,
      headers: {
        "cache-control": "no-store",
        ...(retryAfter ? { "retry-after": String(retryAfter) } : {}),
      },
    },
  );
}

function localCompletionFault(
  request: Request,
):
  | "before-durable"
  | "before-durable-active"
  | "after-durable"
  | null {
  if (!isLocalPreviewEnabled()) return null;
  const value = request.headers.get("x-relay-test-interrupt-completion");
  return value === "before-durable" ||
    value === "before-durable-active" ||
    value === "after-durable"
    ? value
    : null;
}

function simulatedCompletionInterruption() {
  return NextResponse.json(
    { error: "Simulated interrupted checkpoint completion." },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}
