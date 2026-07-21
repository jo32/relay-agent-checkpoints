import { createDeviceAuthorization } from "../../../../db/device-authorization";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let clientName = "Relay checkpoint skills";
  try {
    const payload = (await request.json()) as { client_name?: string };
    clientName = payload.client_name?.trim().slice(0, 80) || clientName;
  } catch {
    // The client name is optional.
  }

  try {
    const authorization = await createDeviceAuthorization(clientName);
    const origin = new URL(request.url).origin;
    const verificationUri = `${origin}/device`;
    return Response.json(
      {
        device_code: authorization.deviceCode,
        user_code: authorization.userCode,
        verification_uri: verificationUri,
        verification_uri_complete: `${verificationUri}?code=${encodeURIComponent(authorization.userCode)}`,
        expires_in: authorization.expiresIn,
        interval: authorization.interval,
      },
      {
        status: 201,
        headers: { "cache-control": "no-store" },
      },
    );
  } catch (error) {
    console.error("Unable to start device authorization", error);
    return Response.json(
      { error: "temporarily_unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
