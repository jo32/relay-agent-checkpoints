import { NextRequest, NextResponse } from "next/server";
import {
  authenticateApiToken,
  checkpointIdExists,
  findCheckpoint,
  getRuntimeEnv,
  insertCheckpoint,
} from "@/db/checkpoints";
import {
  ChunkRecord,
  ChunkedCheckpointManifest,
  loadUploadSession,
  uploadPartKey,
  uploadSessionKey,
} from "@/lib/checkpoint-objects";
import {
  hasValidEncryptedHeader,
  MAX_ENCRYPTED_HEADER_BYTES,
} from "@/lib/encrypted-checkpoint";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ uploadId: string }> },
) {
  const credential = await authenticateApiToken(request, "checkpoints:write");
  if (!credential) {
    return NextResponse.json(
      { error: "A valid Relay agent credential is required." },
      { status: 401 },
    );
  }
  const { uploadId } = await context.params;
  const storage = getRuntimeEnv().CHECKPOINTS;
  const session = await loadUploadSession(storage, uploadId);
  if (!session || session.tenantId !== credential.tenantId) {
    return NextResponse.json({ error: "Upload session not found." }, { status: 404 });
  }
  if (session.status === "completed") {
    const existing = await findCheckpoint(session.checkpointId, credential.tenantId);
    return existing
      ? NextResponse.json({ checkpoint: publicCheckpoint(existing) })
      : NextResponse.json({ error: "Completed checkpoint was not found." }, { status: 404 });
  }
  if (session.expiresAt <= new Date().toISOString()) {
    return NextResponse.json({ error: "Upload session expired." }, { status: 410 });
  }

  const chunks: ChunkRecord[] = [];
  for (let partNumber = 1; partNumber <= session.partCount; partNumber += 1) {
    const key = uploadPartKey(session, partNumber);
    const object = await storage.head(key);
    const expectedSize =
      partNumber < session.partCount
        ? session.chunkSize
        : session.sizeBytes - session.chunkSize * (session.partCount - 1);
    const checksum = object?.customMetadata?.sha256 ?? "";
    if (!object || object.size !== expectedSize || !/^sha256:[a-f0-9]{64}$/i.test(checksum)) {
      return NextResponse.json(
        { error: `Upload part ${partNumber} is missing or invalid.` },
        { status: 409 },
      );
    }
    chunks.push({ key, size: object.size, sha256: checksum.toLowerCase() });
  }

  const first = await storage.get(chunks[0].key, {
    range: { offset: 0, length: MAX_ENCRYPTED_HEADER_BYTES + 13 },
  });
  if (!first || !hasValidEncryptedHeader(await first.bytes(), session.checkpointId)) {
    return NextResponse.json(
      { error: "Checkpoint encryption header is invalid or does not match its ID." },
      { status: 400 },
    );
  }
  if (await checkpointIdExists(session.checkpointId)) {
    return NextResponse.json({ error: "This checkpoint already exists." }, { status: 409 });
  }

  const manifest: ChunkedCheckpointManifest = {
    version: 1,
    checkpointId: session.checkpointId,
    sizeBytes: session.sizeBytes,
    chunks,
  };
  const createdAt = new Date().toISOString();
  try {
    await storage.put(session.objectKey, JSON.stringify(manifest), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        checkpointId: session.checkpointId,
        checksum: session.checksum,
        cipher: session.cipher,
        encryptionVersion: String(session.encryptionVersion),
      },
    });
    await insertCheckpoint({
      id: session.checkpointId,
      ownerKey: credential.tenantId,
      tenantId: credential.tenantId,
      createdByUserId: credential.userId,
      workspaceName: "Private workspace",
      label: "Encrypted checkpoint",
      sourceAgent: "Local checkpoint skill",
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
      encryptionVersion: session.encryptionVersion,
      cipher: session.cipher,
    });
    session.status = "completed";
    await storage.put(uploadSessionKey(uploadId), JSON.stringify(session), {
      httpMetadata: { contentType: "application/json" },
    });
  } catch (error) {
    await storage.delete(session.objectKey).catch(() => undefined);
    console.error("Unable to complete checkpoint upload", error);
    return NextResponse.json(
      { error: "Checkpoint upload could not be completed." },
      { status: 503 },
    );
  }

  return NextResponse.json(
    {
      checkpoint: publicCheckpoint({
        id: session.checkpointId,
        workspaceName: "Private workspace",
        label: "Encrypted checkpoint",
        sourceAgent: "Local checkpoint skill",
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
        checksum: session.checksum,
        encryptionVersion: session.encryptionVersion,
        cipher: session.cipher,
      }),
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}

function publicCheckpoint(checkpoint: {
  id: string;
  workspaceName: string;
  label: string;
  sourceAgent: string;
  agentName: string;
  agentDescription: string;
  agentMetadataMode: "shared" | "pseudonymous";
  status: string;
  createdAt: string;
  sizeBytes: number;
  fileCount: number;
  excludedCount: number;
  parentId: string | null;
  handoff: string;
  checksum: string;
  encryptionVersion: number;
  cipher: string;
}) {
  return checkpoint;
}
