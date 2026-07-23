import { NextRequest, NextResponse } from "next/server";
import {
  authenticateApiToken,
  deleteCheckpoint,
  findCheckpoint,
  hasCheckpointScopes,
  toOwnerCheckpointDto,
} from "@/db/checkpoints";
import {
  getCurrentPrincipal,
  isSameOriginRequest,
} from "@/lib/principal";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const credential = await authenticateApiToken(request, "checkpoints:read");
  if (!credential) {
    return NextResponse.json(
      { error: "A valid Relay agent credential is required." },
      { status: 401 },
    );
  }
  const { id } = await context.params;
  const checkpoint = await findCheckpoint(id, credential.tenantId);
  if (!checkpoint) {
    return NextResponse.json({ error: "Checkpoint not found." }, { status: 404 });
  }
  return NextResponse.json(
    {
      checkpoint: toOwnerCheckpointDto(checkpoint),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const tokenPrincipal = await authenticateApiToken(request);
  const browserPrincipal = tokenPrincipal ? null : await getCurrentPrincipal();
  if (!tokenPrincipal && !browserPrincipal) {
    return NextResponse.json(
      { error: "Sign in or use a Relay agent credential to delete checkpoints." },
      { status: 401 },
    );
  }
  if (
    tokenPrincipal &&
    !hasCheckpointScopes(tokenPrincipal, "checkpoints:delete")
  ) {
    return NextResponse.json(
      { error: "This Relay agent credential lacks checkpoints:delete." },
      { status: 403 },
    );
  }
  if (browserPrincipal && !isSameOriginRequest(request)) {
    return NextResponse.json(
      { error: "Checkpoint deletion requires a same-origin request." },
      { status: 403 },
    );
  }

  const { id } = await context.params;
  let confirmation = "";
  try {
    const payload = (await request.json()) as { confirmation?: unknown };
    confirmation =
      typeof payload.confirmation === "string" ? payload.confirmation : "";
  } catch {
    return NextResponse.json(
      { error: "Type the checkpoint ID to confirm deletion." },
      { status: 400 },
    );
  }
  if (confirmation !== id) {
    return NextResponse.json(
      { error: "The deletion confirmation does not match the checkpoint ID." },
      { status: 400 },
    );
  }

  try {
    const deleted = await deleteCheckpoint(
      id,
      tokenPrincipal?.tenantId ?? browserPrincipal!.tenantId,
    );
    if (!deleted) {
      return NextResponse.json(
        { error: "Checkpoint not found." },
        { status: 404 },
      );
    }
    return NextResponse.json(
      {
        deleted: true,
        ...deleted,
        publicCopiesWarning:
          deleted.visibility === "public"
            ? "Relay removed its public artifact and marketplace listing, but previously downloaded or cached copies cannot be retracted."
            : null,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error("Unable to delete checkpoint", error);
    return NextResponse.json(
      { error: "Relay could not delete this checkpoint." },
      { status: 503 },
    );
  }
}
