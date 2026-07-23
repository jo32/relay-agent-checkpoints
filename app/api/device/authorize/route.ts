import {
  createDeviceAuthorization,
  InvalidDeviceScopeError,
} from "../../../../db/device-authorization";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let clientName = "Relay checkpoint skills";
  let requestedScopes: string[] | undefined;
  try {
    const payload = (await request.json()) as {
      client_name?: string;
      scope?: string;
    };
    clientName = payload.client_name?.trim().slice(0, 80) || clientName;
    requestedScopes =
      typeof payload.scope === "string"
        ? payload.scope.trim().split(/\s+/).filter(Boolean)
        : undefined;
  } catch {
    // The client name is optional.
  }

  try {
    const authorization = await createDeviceAuthorization(
      clientName,
      requestedScopes,
    );
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
        scope: authorization.scopes.join(" "),
      },
      {
        status: 201,
        headers: { "cache-control": "no-store" },
      },
    );
  } catch (error) {
    if (error instanceof InvalidDeviceScopeError) {
      return Response.json(
        { error: "invalid_scope" },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
    console.error("Unable to start device authorization", error);
    return Response.json(
      { error: "temporarily_unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
