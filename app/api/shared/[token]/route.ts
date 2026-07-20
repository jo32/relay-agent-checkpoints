import { findSharedCheckpoint, getRuntimeEnv } from "../../../../db/checkpoints";

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

  const object = await getRuntimeEnv().CHECKPOINTS.get(checkpoint.objectKey);
  if (!object) {
    return Response.json({ error: "Checkpoint archive not found." }, { status: 404 });
  }

  const encrypted = checkpoint.encryptionVersion >= 2;
  const filename = encrypted
    ? `${checkpoint.id}.relay`
    : `${checkpoint.id}.tar.gz`;
  return new Response(object.body, {
    headers: {
      "content-type": encrypted
        ? "application/vnd.relay.checkpoint"
        : "application/gzip",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": String(object.size),
      "x-checkpoint-sha256": checkpoint.checksum,
      "x-checkpoint-id": checkpoint.id,
      "x-checkpoint-encryption": String(checkpoint.encryptionVersion),
      "cache-control": "private, no-store",
    },
  });
}
