import { NextRequest, NextResponse } from "next/server";
import { authenticateApiToken, listCheckpoints } from "@/db/checkpoints";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const credential = await authenticateApiToken(request);
  if (!credential) {
    return NextResponse.json(
      { connected: false, error: "A valid Relay agent credential is required." },
      { status: 401 },
    );
  }
  const checkpoints = await listCheckpoints(credential.tenantId);
  return NextResponse.json(
    {
      connected: true,
      scopes: credential.scopes,
      checkpointCount: checkpoints.length,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
