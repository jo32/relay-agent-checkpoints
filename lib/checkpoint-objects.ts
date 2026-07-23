import type { AgentMetadataMode } from "./agent-metadata";
import {
  MAX_PUBLIC_DESCRIPTION_CHARACTERS,
  MAX_PUBLIC_TITLE_CHARACTERS,
  PUBLIC_CHECKPOINT_FORMAT_VERSION,
} from "./public-checkpoint";
import { Sha256Accumulator } from "./sha256";

export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 1024 * 1024;
export const MAX_UPLOAD_PARTS = Math.ceil(MAX_ARCHIVE_BYTES / UPLOAD_CHUNK_BYTES);
export const COMPLETION_LEASE_MS = 5 * 60 * 1000;

export type ChunkRecord = {
  key: string;
  size: number;
  sha256: string;
};

export type ChunkedCheckpointManifest = {
  version: 1;
  checkpointId: string;
  sizeBytes: number;
  chunks: ChunkRecord[];
};

export const CHECKPOINT_UPLOAD_OPERATIONS = [
  "create-private",
  "create-public",
  "publish-existing",
] as const;
export type CheckpointUploadOperation =
  (typeof CHECKPOINT_UPLOAD_OPERATIONS)[number];

export type CheckpointUploadSession = {
  version: 1;
  /**
   * Sessions created before public checkpoints did not include this field.
   * Missing operation is therefore interpreted as create-private.
   */
  operation?: CheckpointUploadOperation;
  uploadId: string;
  tenantId: string;
  userId: string | null;
  checkpointId: string;
  checksum: string;
  encryptionVersion: 0 | 2;
  cipher: "none" | "AES-256-GCM";
  agentName: string;
  agentDescription: string;
  agentMetadataMode: AgentMetadataMode;
  publicTitle?: string;
  publicDescription?: string;
  publicFormatVersion?: 1;
  sourceCiphertextChecksum?: string | null;
  sizeBytes: number;
  chunkSize: number;
  partCount: number;
  objectPrefix: string;
  objectKey: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "completing" | "completed" | "aborting";
  completionLeaseId?: string;
  completionLeaseExpiresAt?: string;
};

export type LoadedCheckpointUploadSession = {
  session: CheckpointUploadSession;
  etag: string;
};

export type ValidatedCheckpointChunks = {
  chunks: ChunkRecord[];
  checksum: string;
  firstBytes: Uint8Array;
};

export function uploadSessionKey(uploadId: string): string {
  return `uploads/${uploadId}/session.json`;
}

export function uploadPartKey(session: CheckpointUploadSession, partNumber: number): string {
  return `${session.objectPrefix}/part-${String(partNumber).padStart(4, "0")}`;
}

export async function loadUploadSession(
  storage: R2Bucket,
  uploadId: string,
): Promise<CheckpointUploadSession | null> {
  return (await loadUploadSessionRecord(storage, uploadId))?.session ?? null;
}

export async function loadUploadSessionRecord(
  storage: R2Bucket,
  uploadId: string,
): Promise<LoadedCheckpointUploadSession | null> {
  if (!/^[a-f0-9]{32}$/i.test(uploadId)) return null;
  const object = await storage.get(uploadSessionKey(uploadId));
  if (!object) return null;
  try {
    const session = await object.json<CheckpointUploadSession>();
    return isUploadSession(session, uploadId)
      ? { session, etag: object.etag }
      : null;
  } catch {
    return null;
  }
}

export async function transitionUploadSession(
  storage: R2Bucket,
  loaded: LoadedCheckpointUploadSession,
  status: CheckpointUploadSession["status"],
): Promise<LoadedCheckpointUploadSession | null> {
  const session = {
    ...loaded.session,
    status,
    completionLeaseId: undefined,
    completionLeaseExpiresAt: undefined,
  };
  return storeUploadSession(storage, loaded, session);
}

export async function claimUploadCompletion(
  storage: R2Bucket,
  loaded: LoadedCheckpointUploadSession,
  leaseMs = COMPLETION_LEASE_MS,
): Promise<LoadedCheckpointUploadSession | null> {
  const now = Date.now();
  const session = {
    ...loaded.session,
    status: "completing" as const,
    completionLeaseId: crypto.randomUUID(),
    completionLeaseExpiresAt: new Date(now + Math.max(0, leaseMs)).toISOString(),
  };
  return storeUploadSession(storage, loaded, session);
}

export function hasActiveCompletionLease(
  session: CheckpointUploadSession,
  now = Date.now(),
) {
  if (
    session.status !== "completing" ||
    typeof session.completionLeaseId !== "string" ||
    !session.completionLeaseId
  ) {
    return false;
  }
  const expiresAt = Date.parse(session.completionLeaseExpiresAt ?? "");
  return Number.isFinite(expiresAt) && expiresAt > now;
}

export function completionLeaseRetryAfterSeconds(
  session: CheckpointUploadSession,
  now = Date.now(),
) {
  const expiresAt = Date.parse(session.completionLeaseExpiresAt ?? "");
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return 0;
  return Math.max(1, Math.ceil((expiresAt - now) / 1000));
}

async function storeUploadSession(
  storage: R2Bucket,
  loaded: LoadedCheckpointUploadSession,
  session: CheckpointUploadSession,
): Promise<LoadedCheckpointUploadSession | null> {
  const object = await storage.put(
    uploadSessionKey(session.uploadId),
    JSON.stringify(session),
    {
      onlyIf: { etagMatches: loaded.etag },
      httpMetadata: { contentType: "application/json" },
    },
  );
  return object ? { session, etag: object.etag } : null;
}

export async function openCheckpointArchive(
  storage: R2Bucket,
  objectKey: string,
  expectedSize: number,
): Promise<{ body: ReadableStream; size: number } | null> {
  if (!objectKey.endsWith("/manifest.json")) {
    const object = await storage.get(objectKey);
    return object ? { body: object.body, size: object.size } : null;
  }

  const object = await storage.get(objectKey);
  if (!object) return null;
  let manifest: ChunkedCheckpointManifest;
  try {
    manifest = await object.json<ChunkedCheckpointManifest>();
  } catch {
    return null;
  }
  if (!isChunkedManifest(manifest, objectKey, expectedSize)) return null;
  return {
    body: streamChunkObjects(storage, manifest.chunks),
    size: manifest.sizeBytes,
  };
}

export function checkpointUploadOperation(
  session: CheckpointUploadSession,
): CheckpointUploadOperation {
  return session.operation ?? "create-private";
}

export function isPublicUploadSession(session: CheckpointUploadSession) {
  return checkpointUploadOperation(session) !== "create-private";
}

export async function validateCheckpointChunks(
  storage: R2Bucket,
  session: CheckpointUploadSession,
  firstByteLimit: number,
): Promise<ValidatedCheckpointChunks | null> {
  const chunks: ChunkRecord[] = [];
  const aggregate = new Sha256Accumulator();
  const firstBytes = new Uint8Array(Math.max(0, firstByteLimit));
  let firstByteLength = 0;

  for (let partNumber = 1; partNumber <= session.partCount; partNumber += 1) {
    const uploadKey = uploadPartKey(session, partNumber);
    const object = await storage.get(uploadKey);
    const expectedSize =
      partNumber < session.partCount
        ? session.chunkSize
        : session.sizeBytes - session.chunkSize * (session.partCount - 1);
    const recordedChecksum = object?.customMetadata?.sha256?.toLowerCase() ?? "";
    if (
      !object ||
      object.size !== expectedSize ||
      !/^sha256:[a-f0-9]{64}$/.test(recordedChecksum)
    ) {
      return null;
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.length !== expectedSize) return null;
    const chunkDigest = await crypto.subtle.digest("SHA-256", bytes);
    const actualChunkChecksum = `sha256:${toHex(new Uint8Array(chunkDigest))}`;
    if (actualChunkChecksum !== recordedChecksum) return null;

    const key = `${session.objectPrefix}/sealed/part-${String(partNumber).padStart(4, "0")}`;
    const stored = await storage.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: chunkDigest,
      customMetadata: {
        checkpointId: session.checkpointId,
        partNumber: String(partNumber),
        sha256: actualChunkChecksum,
        sealed: "true",
      },
    });
    let sealedBytes = bytes;
    if (!stored) {
      const existing = await storage.get(key);
      if (
        !existing ||
        existing.size !== expectedSize ||
        existing.customMetadata?.sha256?.toLowerCase() !== actualChunkChecksum
      ) {
        return null;
      }
      sealedBytes = new Uint8Array(await existing.arrayBuffer());
      const sealedDigest = await crypto.subtle.digest("SHA-256", sealedBytes);
      if (`sha256:${toHex(new Uint8Array(sealedDigest))}` !== actualChunkChecksum) {
        return null;
      }
    }

    aggregate.update(sealedBytes);
    if (firstByteLength < firstBytes.length) {
      const take = Math.min(firstBytes.length - firstByteLength, sealedBytes.length);
      firstBytes.set(sealedBytes.subarray(0, take), firstByteLength);
      firstByteLength += take;
    }
    chunks.push({
      key,
      size: bytes.length,
      sha256: actualChunkChecksum,
    });
  }

  return {
    chunks,
    checksum: `sha256:${aggregate.hexDigest()}`,
    firstBytes: firstBytes.subarray(0, firstByteLength),
  };
}

function isUploadSession(
  value: CheckpointUploadSession,
  uploadId: string,
): boolean {
  const operation = value?.operation ?? "create-private";
  const validPrivateFormat =
    operation === "create-private" &&
    value.encryptionVersion === 2 &&
    value.cipher === "AES-256-GCM";
  const validPublicFormat =
    (operation === "create-public" || operation === "publish-existing") &&
    value.encryptionVersion === 0 &&
    value.cipher === "none" &&
    value.publicFormatVersion === PUBLIC_CHECKPOINT_FORMAT_VERSION &&
    validBoundedText(value.publicTitle, MAX_PUBLIC_TITLE_CHARACTERS) &&
    validBoundedText(
      value.publicDescription,
      MAX_PUBLIC_DESCRIPTION_CHARACTERS,
    ) &&
    (operation === "publish-existing"
      ? /^sha256:[a-f0-9]{64}$/i.test(value.sourceCiphertextChecksum ?? "")
      : value.sourceCiphertextChecksum == null);
  const validCompletionLease =
    (value.completionLeaseId === undefined &&
      value.completionLeaseExpiresAt === undefined) ||
    (
      typeof value.completionLeaseId === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        value.completionLeaseId,
      ) &&
      typeof value.completionLeaseExpiresAt === "string" &&
      Number.isFinite(Date.parse(value.completionLeaseExpiresAt))
    );
  return (
    value?.version === 1 &&
    CHECKPOINT_UPLOAD_OPERATIONS.includes(operation) &&
    value.uploadId === uploadId &&
    typeof value.tenantId === "string" &&
    /^cp_[a-z0-9_-]{6,80}$/i.test(value.checkpointId) &&
    /^sha256:[a-f0-9]{64}$/i.test(value.checksum) &&
    (validPrivateFormat || validPublicFormat) &&
    typeof value.agentName === "string" &&
    value.agentName.length > 0 &&
    typeof value.agentDescription === "string" &&
    value.agentDescription.length > 0 &&
    (value.agentMetadataMode === "shared" ||
      value.agentMetadataMode === "pseudonymous") &&
    Number.isInteger(value.sizeBytes) &&
    value.sizeBytes > 0 &&
    value.sizeBytes <= MAX_ARCHIVE_BYTES &&
    value.chunkSize === UPLOAD_CHUNK_BYTES &&
    Number.isInteger(value.partCount) &&
    value.partCount > 0 &&
    value.partCount <= MAX_UPLOAD_PARTS &&
    typeof value.objectPrefix === "string" &&
    value.objectKey === `${value.objectPrefix}/manifest.json` &&
    validCompletionLease &&
    (
      value.status === "pending" ||
      value.status === "completing" ||
      value.status === "completed" ||
      value.status === "aborting"
    )
  );
}

function isChunkedManifest(
  value: ChunkedCheckpointManifest,
  objectKey: string,
  expectedSize: number,
): boolean {
  const objectPrefix = objectKey.slice(0, -"/manifest.json".length);
  return (
    value?.version === 1 &&
    /^cp_[a-z0-9_-]{6,80}$/i.test(value.checkpointId) &&
    value.sizeBytes === expectedSize &&
    Array.isArray(value.chunks) &&
    value.chunks.length > 0 &&
    value.chunks.length <= MAX_UPLOAD_PARTS &&
    value.chunks.reduce((total, chunk) => total + chunk.size, 0) === expectedSize &&
    value.chunks.every(
      (chunk, index) =>
        (chunk.key ===
          `${objectPrefix}/part-${String(index + 1).padStart(4, "0")}` ||
          chunk.key ===
            `${objectPrefix}/sealed/part-${String(index + 1).padStart(4, "0")}`) &&
        Number.isInteger(chunk.size) &&
        chunk.size > 0 &&
        chunk.size <= UPLOAD_CHUNK_BYTES &&
        /^sha256:[a-f0-9]{64}$/i.test(chunk.sha256),
    )
  );
}

export function streamChunkObjects(
  storage: R2Bucket,
  chunks: ChunkRecord[],
): ReadableStream {
  let chunkIndex = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          if (!reader) {
            if (chunkIndex >= chunks.length) {
              controller.close();
              return;
            }
            const object = await storage.get(chunks[chunkIndex].key);
            if (!object || object.size !== chunks[chunkIndex].size) {
              throw new Error("Checkpoint archive chunk is missing");
            }
            reader = object.body.getReader();
          }
          const result = await reader.read();
          if (result.done) {
            reader = null;
            chunkIndex += 1;
            continue;
          }
          controller.enqueue(result.value);
          return;
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason);
    },
  });
}

function validBoundedText(value: unknown, maxCharacters: number) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    [...value].length <= maxCharacters
  );
}

function toHex(value: Uint8Array) {
  return [...value]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
