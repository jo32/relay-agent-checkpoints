import {
  authenticateApiToken,
  createShareToken,
} from "../../../../../db/checkpoints";
import {
  getCurrentPrincipal,
  isSameOriginRequest,
} from "../../../../../lib/principal";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const tokenPrincipal = await authenticateApiToken(request, "checkpoints:share");
  const browserPrincipal = tokenPrincipal ? null : await getCurrentPrincipal();
  if (!tokenPrincipal && !browserPrincipal) {
    return Response.json({ error: "Sign in to share a checkpoint." }, { status: 401 });
  }
  if (
    browserPrincipal &&
    browserPrincipal.source !== "local" &&
    !isSameOriginRequest(request)
  ) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }

  const share = await createShareToken(
    id,
    tokenPrincipal?.tenantId ?? browserPrincipal!.tenantId,
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
