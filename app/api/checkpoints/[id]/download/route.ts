import { NextRequest } from "next/server";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import {
  authenticateApiToken,
  findCheckpoint,
  getRuntimeEnv,
} from "../../../../../db/checkpoints";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const user = await getChatGPTUser();
  const tokenOwner = await authenticateApiToken(request);
  const checkpoint = await findCheckpoint(
    id,
    tokenOwner ?? user?.email ?? "local-preview",
  );

  if (!checkpoint) {
    return Response.json({ error: "Checkpoint not found." }, { status: 404 });
  }

  const object = await getRuntimeEnv().CHECKPOINTS.get(checkpoint.objectKey);
  if (!object) {
    return Response.json({ error: "Checkpoint archive not found." }, { status: 404 });
  }

  const filename = `${checkpoint.workspaceName}-${checkpoint.id}.tar.gz`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-");

  return new Response(object.body, {
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": String(object.size),
      "x-checkpoint-sha256": checkpoint.checksum,
      "cache-control": "private, no-store",
    },
  });
}
