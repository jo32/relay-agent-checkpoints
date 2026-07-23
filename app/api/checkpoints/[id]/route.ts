import { NextRequest, NextResponse } from "next/server";
import {
  authenticateApiToken,
  findCheckpoint,
  toOwnerCheckpointDto,
} from "@/db/checkpoints";

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
      checkpoint: toOwnerCheckpointDto(checkpoint),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
