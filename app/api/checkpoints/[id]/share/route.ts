import { getChatGPTUser } from "../../../../chatgpt-auth";
import {
  authenticateApiToken,
  createShareToken,
} from "../../../../../db/checkpoints";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const user = await getChatGPTUser();
  const tokenOwner = await authenticateApiToken(request);
  const share = await createShareToken(
    id,
    tokenOwner ?? user?.email ?? "local-preview",
  );

  if (!share) {
    return Response.json({ error: "Checkpoint not found." }, { status: 404 });
  }

  const url = new URL(request.url);
  return Response.json({
    url: `${url.origin}/api/shared/${share.token}`,
    expiresAt: share.expiresAt,
  });
}
