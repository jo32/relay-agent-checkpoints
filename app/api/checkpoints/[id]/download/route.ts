import { NextRequest } from "next/server";
import {
  authenticateApiToken,
  findCheckpoint,
  getRuntimeEnv,
} from "../../../../../db/checkpoints";
import { getCurrentPrincipal } from "../../../../../lib/principal";
import { openCheckpointArchive } from "../../../../../lib/checkpoint-objects";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const tokenPrincipal = await authenticateApiToken(request, "checkpoints:read");
  const browserPrincipal = tokenPrincipal ? null : await getCurrentPrincipal();
  if (!tokenPrincipal && !browserPrincipal) {
    return Response.json({ error: "Sign in to download this checkpoint." }, { status: 401 });
  }
  const checkpoint = await findCheckpoint(
    id,
    tokenPrincipal?.tenantId ?? browserPrincipal!.tenantId,
  );

  if (!checkpoint) {
    return Response.json({ error: "Checkpoint not found." }, { status: 404 });
  }

  const archive = await openCheckpointArchive(
    getRuntimeEnv().CHECKPOINTS,
    checkpoint.objectKey,
    checkpoint.sizeBytes,
  );
  if (!archive) {
    return Response.json({ error: "Checkpoint archive not found." }, { status: 404 });
  }

  const encrypted = checkpoint.encryptionVersion >= 2;
  const filename = encrypted
    ? `${checkpoint.id}.relay`
    : `${checkpoint.id}.tar.gz`;

  return new Response(archive.body, {
    headers: {
      "content-type": encrypted
        ? "application/vnd.relay.checkpoint"
        : "application/gzip",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": String(archive.size),
      "x-checkpoint-sha256": checkpoint.checksum,
      "x-checkpoint-id": checkpoint.id,
      "x-checkpoint-encryption": String(checkpoint.encryptionVersion),
      "cache-control": "private, no-store",
    },
  });
}
