export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 1024 * 1024;
export const MAX_UPLOAD_PARTS = Math.ceil(MAX_ARCHIVE_BYTES / UPLOAD_CHUNK_BYTES);

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

export type CheckpointUploadSession = {
  version: 1;
  uploadId: string;
  tenantId: string;
  userId: string | null;
  checkpointId: string;
  checksum: string;
  encryptionVersion: 2;
  cipher: "AES-256-GCM";
  sizeBytes: number;
  chunkSize: number;
  partCount: number;
  objectPrefix: string;
  objectKey: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "completed";
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
  if (!/^[a-f0-9]{32}$/i.test(uploadId)) return null;
  const object = await storage.get(uploadSessionKey(uploadId));
  if (!object) return null;
  try {
    const session = await object.json<CheckpointUploadSession>();
    return isUploadSession(session, uploadId) ? session : null;
  } catch {
    return null;
  }
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
    body: concatenateChunkObjects(storage, manifest.chunks),
    size: manifest.sizeBytes,
  };
}

function isUploadSession(
  value: CheckpointUploadSession,
  uploadId: string,
): boolean {
  return (
    value?.version === 1 &&
    value.uploadId === uploadId &&
    typeof value.tenantId === "string" &&
    /^cp_[a-z0-9_-]{6,80}$/i.test(value.checkpointId) &&
    /^sha256:[a-f0-9]{64}$/i.test(value.checksum) &&
    value.encryptionVersion === 2 &&
    value.cipher === "AES-256-GCM" &&
    Number.isInteger(value.sizeBytes) &&
    value.sizeBytes > 0 &&
    value.sizeBytes <= MAX_ARCHIVE_BYTES &&
    value.chunkSize === UPLOAD_CHUNK_BYTES &&
    Number.isInteger(value.partCount) &&
    value.partCount > 0 &&
    value.partCount <= MAX_UPLOAD_PARTS &&
    typeof value.objectPrefix === "string" &&
    value.objectKey === `${value.objectPrefix}/manifest.json` &&
    (value.status === "pending" || value.status === "completed")
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
        chunk.key === `${objectPrefix}/part-${String(index + 1).padStart(4, "0")}` &&
        Number.isInteger(chunk.size) &&
        chunk.size > 0 &&
        chunk.size <= UPLOAD_CHUNK_BYTES &&
        /^sha256:[a-f0-9]{64}$/i.test(chunk.sha256),
    )
  );
}

function concatenateChunkObjects(
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
