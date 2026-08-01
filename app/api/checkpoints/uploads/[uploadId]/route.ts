import { NextRequest, NextResponse } from "next/server";
import {
  authenticateApiToken,
  findCheckpoint,
  findCheckpointPublication,
  getRuntimeEnv,
  hasCheckpointScopes,
} from "@/db/checkpoints";
import {
  checkpointUploadOperation,
  completionLeaseRetryAfterSeconds,
  hasActiveCompletionLease,
  isPublicUploadSession,
  loadUploadSession,
  loadUploadSessionRecord,
  transitionUploadSession,
  uploadSessionKey,
} from "@/lib/checkpoint-objects";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ uploadId: string }> },
) {
  const credential = await authenticateApiToken(request, "checkpoints:read");
  if (!credential) {
    return NextResponse.json({ error: "A valid Relay agent credential is required." }, { status: 401 });
  }
  const { uploadId } = await context.params;
  const session = await loadUploadSession(getRuntimeEnv().CHECKPOINTS, uploadId);
  if (!session || session.tenantId !== credential.tenantId) {
    return NextResponse.json({ error: "Upload session not found." }, { status: 404 });
  }
  return NextResponse.json(
    {
      uploadId,
      operation: checkpointUploadOperation(session),
      checkpointId: session.checkpointId,
      status: session.status,
      sizeBytes: session.sizeBytes,
      chunkSize: session.chunkSize,
      partCount: session.partCount,
      expiresAt: session.expiresAt,
      agent: {
        name: session.agentName,
        description: session.agentDescription,
        mode: session.agentMetadataMode,
      },
      artifactType: session.artifactType ?? "agent",
      skill:
        session.artifactType === "skill"
          ? {
              name: session.skillName,
              description: session.skillDescription,
            }
          : null,
      ...(session.publicTitle && session.publicDescription
        ? {
            publication: {
              title: session.publicTitle,
              description: session.publicDescription,
              formatVersion: session.publicFormatVersion,
              sourceCiphertextChecksum:
                session.sourceCiphertextChecksum ?? null,
            },
          }
        : {}),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ uploadId: string }> },
) {
  const credential = await authenticateApiToken(request);
  if (!credential) {
    return NextResponse.json({ error: "A valid Relay agent credential is required." }, { status: 401 });
  }
  const { uploadId } = await context.params;
  const storage = getRuntimeEnv().CHECKPOINTS;
  const loaded = await loadUploadSessionRecord(storage, uploadId);
  if (!loaded || loaded.session.tenantId !== credential.tenantId) {
    return NextResponse.json({ error: "Upload session not found." }, { status: 404 });
  }
  const session = loaded.session;
  if (
    !hasCheckpointScopes(credential, "checkpoints:write") ||
    (isPublicUploadSession(session) &&
      !hasCheckpointScopes(credential, "checkpoints:publish"))
  ) {
    return NextResponse.json(
      { error: "This Relay agent credential lacks the required checkpoint scope." },
      { status: 403 },
    );
  }
  const operation = checkpointUploadOperation(session);
  const committed = await hasDurableUpload(
    session,
    operation,
    credential.tenantId,
  );
  if (committed || session.status === "completed") {
    return NextResponse.json({ error: "Completed uploads cannot be aborted." }, { status: 409 });
  }
  if (
    session.status === "completing" &&
    hasActiveCompletionLease(session)
  ) {
    const retryAfter = completionLeaseRetryAfterSeconds(session);
    return NextResponse.json(
      { error: "Uploads being completed cannot be aborted." },
      {
        status: 409,
        headers: {
          "cache-control": "no-store",
          ...(retryAfter ? { "retry-after": String(retryAfter) } : {}),
        },
      },
    );
  }
  let aborting = loaded;
  if (session.status === "pending" || session.status === "completing") {
    const claimed = await transitionUploadSession(storage, loaded, "aborting");
    if (!claimed) {
      return NextResponse.json(
        { error: "Upload state changed; retry the request." },
        { status: 409 },
      );
    }
    aborting = claimed;
  }
  if (await hasDurableUpload(session, operation, credential.tenantId)) {
    await transitionUploadSession(storage, aborting, "completed").catch(
      (error) => {
        console.error(
          "Unable to reconcile committed checkpoint upload during abort",
          error,
        );
      },
    );
    return NextResponse.json(
      { error: "Completed uploads cannot be aborted." },
      { status: 409 },
    );
  }
  const objects = await storage.list({ prefix: session.objectPrefix });
  if (objects.objects.length) {
    await storage.delete(objects.objects.map((object) => object.key));
  }
  await storage.delete(uploadSessionKey(uploadId));
  return new Response(null, { status: 204 });
}

async function hasDurableUpload(
  session: NonNullable<Awaited<ReturnType<typeof loadUploadSession>>>,
  operation: ReturnType<typeof checkpointUploadOperation>,
  tenantId: string,
) {
  const durable =
    operation === "create-private"
      ? await findCheckpoint(session.checkpointId, tenantId)
      : await findCheckpointPublication(session.checkpointId, tenantId);
  return Boolean(
    durable &&
      durable.objectKey === session.objectKey &&
      durable.checksum.toLowerCase() === session.checksum.toLowerCase(),
  );
}
