import { exchangeDeviceCode } from "../../../../db/device-authorization";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let deviceCode = "";
  try {
    const payload = (await request.json()) as { device_code?: string };
    deviceCode = payload.device_code?.trim() ?? "";
  } catch {
    return tokenError("invalid_request");
  }

  try {
    const result = await exchangeDeviceCode(deviceCode);
    if (!result.ok) return tokenError(result.error);
    const expiresIn = Math.max(
      0,
      Math.floor((Date.parse(result.expiresAt) - Date.now()) / 1000),
    );
    return Response.json(
      {
        access_token: result.accessToken,
        token_type: "Bearer",
        expires_in: expiresIn,
        expires_at: result.expiresAt,
        scope: result.scopes,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error("Unable to exchange device authorization", error);
    return tokenError("temporarily_unavailable", 503);
  }
}

function tokenError(error: string, status = 400) {
  return Response.json(
    { error },
    { status, headers: { "cache-control": "no-store" } },
  );
}
