import { NextRequest, NextResponse } from "next/server";
import { authenticateApiToken, findCheckpoint } from "@/db/checkpoints";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const credential = await authenticateApiToken(request, "checkpoints:read");
  if (!credential) {
    return NextResponse.json(
      { error: "A valid Relay agent credential is required." },
      { status: 401 },
    );
  }
  const { id } = await context.params;
  const checkpoint = await findCheckpoint(id, credential.tenantId);
  if (!checkpoint) {
    return NextResponse.json({ error: "Checkpoint not found." }, { status: 404 });
  }
  return NextResponse.json(
    {
      checkpoint: {
        id: checkpoint.id,
        workspaceName: checkpoint.workspaceName,
        label: checkpoint.label,
        sourceAgent: checkpoint.sourceAgent,
        agentName: checkpoint.agentName,
        agentDescription: checkpoint.agentDescription,
        agentMetadataMode: checkpoint.agentMetadataMode,
        status: checkpoint.status,
        createdAt: checkpoint.createdAt,
        sizeBytes: checkpoint.sizeBytes,
        fileCount: checkpoint.fileCount,
        excludedCount: checkpoint.excludedCount,
        parentId: checkpoint.parentId,
        handoff: checkpoint.handoff,
        checksum: checkpoint.checksum,
        encryptionVersion: checkpoint.encryptionVersion,
        cipher: checkpoint.cipher,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
