import { findSharedCheckpoint, getRuntimeEnv } from "../../../../db/checkpoints";
import { openCheckpointArchive } from "../../../../lib/checkpoint-objects";
import { agentMetadataHeaders } from "../../../../lib/agent-metadata";
import { artifactMetadataHeaders } from "../../../../lib/artifact-metadata";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  if (!/^[a-f0-9]{32}$/i.test(token)) {
    return Response.json({ error: "Share link is invalid." }, { status: 400 });
  }

  const checkpoint = await findSharedCheckpoint(token);
  if (!checkpoint) {
    return Response.json({ error: "This share link expired or was revoked." }, { status: 404 });
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
      ...agentMetadataHeaders(checkpoint),
      ...artifactMetadataHeaders(checkpoint),
      "cache-control": "private, no-store",
    },
  });
}
