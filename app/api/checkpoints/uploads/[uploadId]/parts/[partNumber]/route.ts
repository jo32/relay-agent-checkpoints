import { NextRequest, NextResponse } from "next/server";
import {
  authenticateApiToken,
  getRuntimeEnv,
  hasCheckpointScopes,
} from "@/db/checkpoints";
import {
  isPublicUploadSession,
  loadUploadSession,
  uploadPartKey,
} from "@/lib/checkpoint-objects";

export const dynamic = "force-dynamic";

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ uploadId: string; partNumber: string }> },
) {
  const credential = await authenticateApiToken(request);
  if (!credential) {
    return NextResponse.json(
      { error: "A valid Relay agent credential is required." },
      { status: 401 },
    );
  }
  const { uploadId, partNumber: partInput } = await context.params;
  const partNumber = Number.parseInt(partInput, 10);
  const storage = getRuntimeEnv().CHECKPOINTS;
  const session = await loadUploadSession(storage, uploadId);
  if (!session || session.tenantId !== credential.tenantId) {
    return NextResponse.json({ error: "Upload session not found." }, { status: 404 });
  }
  if (
    !hasCheckpointScopes(credential, "checkpoints:write") ||
    (isPublicUploadSession(session) &&
      !hasCheckpointScopes(credential, "checkpoints:publish"))
  ) {
    return NextResponse.json(
      { error: "This Relay agent credential lacks the required checkpoint scope." },
      { status: 403 },
    );
  }
  if (session.status !== "pending") {
    return NextResponse.json({ error: "Upload is already complete." }, { status: 409 });
  }
  if (session.expiresAt <= new Date().toISOString()) {
    return NextResponse.json({ error: "Upload session expired." }, { status: 410 });
  }
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > session.partCount) {
    return NextResponse.json({ error: "Upload part number is invalid." }, { status: 400 });
  }
  const expectedSize =
    partNumber < session.partCount
      ? session.chunkSize
      : session.sizeBytes - session.chunkSize * (session.partCount - 1);
  const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  if (declaredLength !== expectedSize) {
    return NextResponse.json({ error: "Upload part size is invalid." }, { status: 400 });
  }
  const expectedChecksum = request.headers.get("x-chunk-sha256")?.toLowerCase() ?? "";
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedChecksum)) {
    return NextResponse.json({ error: "Upload part checksum is invalid." }, { status: 400 });
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength !== expectedSize) {
    return NextResponse.json({ error: "Upload part is incomplete." }, { status: 400 });
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const checksum = `sha256:${toHex(digest)}`;
  if (checksum !== expectedChecksum) {
    return NextResponse.json({ error: "Upload part checksum does not match." }, { status: 400 });
  }
  try {
    const object = await storage.put(
      uploadPartKey(session, partNumber),
      bytes,
      {
        sha256: digest,
        customMetadata: {
          checkpointId: session.checkpointId,
          operation: session.operation ?? "create-private",
          partNumber: String(partNumber),
          sha256: checksum,
        },
      },
    );
    return NextResponse.json(
      { partNumber, sizeBytes: bytes.byteLength, checksum, etag: object.etag },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error("Unable to store checkpoint upload part", error);
    return NextResponse.json({ error: "Upload part could not be stored." }, { status: 503 });
  }
}

function toHex(value: ArrayBuffer) {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
