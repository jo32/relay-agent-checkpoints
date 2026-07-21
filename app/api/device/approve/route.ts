import { decideDeviceAuthorization } from "../../../../db/device-authorization";
import {
  getCurrentPrincipal,
  isSameOriginRequest,
} from "../../../../lib/principal";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const principal = await getCurrentPrincipal();
  if (!principal) {
    return Response.json({ error: "Sign in to approve this device." }, { status: 401 });
  }
  if (principal.source !== "local" && !isSameOriginRequest(request)) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }

  let userCode = "";
  let decision: "approve" | "deny" = "approve";
  try {
    const payload = (await request.json()) as {
      user_code?: string;
      decision?: string;
    };
    userCode = payload.user_code?.trim() ?? "";
    decision = payload.decision === "deny" ? "deny" : "approve";
  } catch {
    return Response.json({ error: "Invalid approval request." }, { status: 400 });
  }

  const changed = await decideDeviceAuthorization(
    userCode,
    decision,
    principal.tenantId,
    principal.userId,
  );
  if (!changed) {
    return Response.json(
      { error: "This code is invalid, expired, or already used." },
      { status: 409 },
    );
  }
  return Response.json({ status: decision === "approve" ? "approved" : "denied" });
}
