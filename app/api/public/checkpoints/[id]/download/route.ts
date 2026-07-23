import {
  findCheckpointPublication,
  findPublicCheckpoint,
  getRuntimeEnv,
} from "@/db/checkpoints";
import { openCheckpointArchive } from "@/lib/checkpoint-objects";
import {
  PUBLIC_CHECKPOINT_CONTENT_TYPE,
  PUBLIC_CHECKPOINT_FORMAT_VERSION,
} from "@/lib/public-checkpoint";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const checkpoint = await findPublicCheckpoint(id);
  const publication = checkpoint?.publication;
  if (!checkpoint || !publication) {
    return Response.json({ error: "Public checkpoint not found." }, { status: 404 });
  }

  const record = await findCheckpointPublication(
    checkpoint.id,
    checkpoint.tenantId,
  );
  if (!record) {
    return Response.json({ error: "Public checkpoint not found." }, { status: 404 });
  }
  const archive = await openCheckpointArchive(
    getRuntimeEnv().CHECKPOINTS,
    record.objectKey,
    publication.sizeBytes,
  );
  if (!archive) {
    return Response.json({ error: "Public checkpoint not found." }, { status: 404 });
  }

  return new Response(archive.body, {
    headers: {
      "content-type": PUBLIC_CHECKPOINT_CONTENT_TYPE,
      "content-disposition": `attachment; filename="${checkpoint.id}.tar.gz"`,
      "content-length": String(archive.size),
      "x-checkpoint-sha256": publication.checksum,
      "x-checkpoint-id": checkpoint.id,
      "x-checkpoint-encryption": "0",
      "x-relay-public-format": String(
        publication.formatVersion || PUBLIC_CHECKPOINT_FORMAT_VERSION,
      ),
      "x-relay-public-title": encodeURIComponent(publication.title),
      "x-relay-public-description": encodeURIComponent(publication.description),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}
