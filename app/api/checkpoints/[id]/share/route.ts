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
  const tokenPrincipal = await authenticateApiToken(request, "checkpoints:share");
  if (!tokenPrincipal) {
    return Response.json(
      { error: "Use the local share command with a Relay API token." },
      { status: 401 },
    );
  }

  const share = await createShareToken(
    id,
    tokenPrincipal.tenantId,
  );

  if (!share) {
    return Response.json({ error: "Checkpoint not found." }, { status: 404 });
  }

  const url = new URL(request.url);
  return Response.json(
    {
      url: `${url.origin}/api/shared/${share.token}`,
      expiresAt: share.expiresAt,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
