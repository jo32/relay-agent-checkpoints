import { revokeAccessToken } from "../../../../db/device-authorization";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (match) await revokeAccessToken(match[1].trim());
  return new Response(null, { status: 204 });
}
