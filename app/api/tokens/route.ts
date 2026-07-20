import { issueApiToken } from "../../../db/checkpoints";
import {
  getCurrentPrincipal,
  isSameOriginRequest,
} from "../../../lib/principal";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const principal = await getCurrentPrincipal();
  if (!principal) {
    return Response.json({ error: "Sign in to create an API token." }, { status: 401 });
  }
  if (principal.source !== "local" && !isSameOriginRequest(request)) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }

  let label = "Agent checkpoint skills";
  try {
    const payload = (await request.json()) as { label?: string };
    label = payload.label?.trim().slice(0, 80) || label;
  } catch {
    // A label is optional.
  }

  try {
    const token = await issueApiToken(
      principal.tenantId,
      principal.userId,
      label,
    );
    return Response.json(token, {
      status: 201,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    console.error("Unable to issue API token", error);
    return Response.json(
      { error: "An API token could not be created." },
      { status: 503 },
    );
  }
}
