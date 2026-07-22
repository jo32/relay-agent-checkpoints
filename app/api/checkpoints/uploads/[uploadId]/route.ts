import { NextRequest, NextResponse } from "next/server";
import { authenticateApiToken, getRuntimeEnv } from "@/db/checkpoints";
import {
  loadUploadSession,
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
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ uploadId: string }> },
) {
  const credential = await authenticateApiToken(request, "checkpoints:write");
  if (!credential) {
    return NextResponse.json({ error: "A valid Relay agent credential is required." }, { status: 401 });
  }
  const { uploadId } = await context.params;
  const storage = getRuntimeEnv().CHECKPOINTS;
  const session = await loadUploadSession(storage, uploadId);
  if (!session || session.tenantId !== credential.tenantId) {
    return NextResponse.json({ error: "Upload session not found." }, { status: 404 });
  }
  if (session.status === "completed") {
    return NextResponse.json({ error: "Completed uploads cannot be aborted." }, { status: 409 });
  }
  const objects = await storage.list({ prefix: session.objectPrefix });
  if (objects.objects.length) {
    await storage.delete(objects.objects.map((object) => object.key));
  }
  await storage.delete(uploadSessionKey(uploadId));
  return new Response(null, { status: 204 });
}
