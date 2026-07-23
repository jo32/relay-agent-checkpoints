import { NextResponse } from "next/server";
import { findPublicCheckpoint } from "@/db/checkpoints";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const checkpoint = await findPublicCheckpoint(id);
  if (!checkpoint?.publication) {
    return NextResponse.json({ error: "Public checkpoint not found." }, { status: 404 });
  }

  return NextResponse.json(
    {
      checkpoint: {
        id: checkpoint.id,
        visibility: "public",
        publication: {
          title: checkpoint.publication.title,
          description: checkpoint.publication.description,
          checksum: checkpoint.publication.checksum,
          sizeBytes: checkpoint.publication.sizeBytes,
          formatVersion: checkpoint.publication.formatVersion,
          publishedAt: checkpoint.publication.publishedAt,
        },
      },
    },
    {
      headers: {
        "cache-control": "public, max-age=300, stale-while-revalidate=3600",
      },
    },
  );
}
