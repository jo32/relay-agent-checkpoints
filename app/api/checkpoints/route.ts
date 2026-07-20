import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "../../../lib/principal";
import {
  authenticateApiToken,
  findCheckpoint,
  getRuntimeEnv,
  insertCheckpoint,
  listCheckpoints,
} from "../../../db/checkpoints";

export const dynamic = "force-dynamic";

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

export async function GET() {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) {
      return NextResponse.json({ error: "Sign in to view checkpoints." }, { status: 401 });
    }
    return NextResponse.json({
      checkpoints: await listCheckpoints(principal.tenantId),
    });
  } catch (error) {
    console.error("Unable to list checkpoints", error);
    return NextResponse.json(
      { error: "Checkpoint storage is not available yet." },
      { status: 503 },
    );
  }
}

export async function POST(request: NextRequest) {
  const credential = await authenticateApiToken(request, "checkpoints:write");
  if (!credential) {
    return NextResponse.json(
      { error: "A valid Relay API token is required." },
      { status: 401 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected a checkpoint archive." }, { status: 400 });
  }

  const archive = form.get("archive");
  const requestedId = cleanText(form.get("checkpointId"), 90);
  const workspaceName = cleanText(form.get("workspaceName"), 80);
  const label = cleanText(form.get("label"), 120);
  const sourceAgent = cleanText(form.get("sourceAgent"), 60) || "Checkpoint skill";
  const parentId = cleanText(form.get("parentId"), 80) || null;
  const handoff = cleanText(form.get("handoff"), 4000);
  const checksum = cleanText(form.get("checksum"), 100);
  const fileCount = cleanInteger(form.get("fileCount"));
  const excludedCount = cleanInteger(form.get("excludedCount"));

  if (!(archive instanceof File) || archive.size === 0) {
    return NextResponse.json({ error: "A checkpoint archive is required." }, { status: 400 });
  }
  if (archive.size > MAX_ARCHIVE_BYTES) {
    return NextResponse.json(
      { error: "Checkpoint archives are limited to 100 MB in this preview." },
      { status: 413 },
    );
  }
  if (!workspaceName || !label) {
    return NextResponse.json({ error: "Checkpoint details are incomplete." }, { status: 400 });
  }
  if (!/^sha256:[a-f0-9]{64}$/i.test(checksum)) {
    return NextResponse.json({ error: "A valid archive checksum is required." }, { status: 400 });
  }

  const id = /^cp_[a-z0-9_-]{6,80}$/i.test(requestedId)
    ? requestedId
    : `cp_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const objectKey = `${encodeURIComponent(credential.tenantId)}/${id}.tar.gz`;
  const createdAt = new Date().toISOString();
  if (await findCheckpoint(id, credential.tenantId)) {
    return NextResponse.json(
      { error: "This checkpoint already exists." },
      { status: 409 },
    );
  }

  let storage: R2Bucket | null = null;
  try {
    storage = getRuntimeEnv().CHECKPOINTS;
    await storage.put(objectKey, archive.stream(), {
      httpMetadata: {
        contentType: "application/gzip",
        contentDisposition: `attachment; filename="${safeFilename(workspaceName)}-${id}.tar.gz"`,
      },
      customMetadata: { checkpointId: id, checksum },
    });

    await insertCheckpoint({
      id,
      ownerKey: credential.tenantId,
      tenantId: credential.tenantId,
      createdByUserId: credential.userId,
      workspaceName,
      label,
      sourceAgent,
      status: "ready",
      createdAt,
      sizeBytes: archive.size,
      fileCount,
      excludedCount,
      parentId,
      handoff,
      objectKey,
      checksum,
    });
  } catch (error) {
    if (storage) await storage.delete(objectKey).catch(() => undefined);
    console.error("Unable to store checkpoint", error);
    return NextResponse.json(
      { error: "The checkpoint could not be stored. Please try again." },
      { status: 503 },
    );
  }

  return NextResponse.json(
    {
      checkpoint: {
        id,
        workspaceName,
        label,
        sourceAgent,
        status: "ready",
        createdAt,
        sizeBytes: archive.size,
        fileCount,
        excludedCount,
        parentId,
        handoff,
        checksum,
      },
    },
    { status: 201 },
  );
}

function cleanText(value: FormDataEntryValue | null, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanInteger(value: FormDataEntryValue | null) {
  const parsed = Number.parseInt(typeof value === "string" ? value : "0", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function safeFilename(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "workspace";
}
