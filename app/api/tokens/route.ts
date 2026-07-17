import { getChatGPTUser } from "../../chatgpt-auth";
import { issueApiToken } from "../../../db/checkpoints";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  const ownerKey = user?.email ?? "local-preview";
  let label = "Agent checkpoint skills";
  try {
    const payload = (await request.json()) as { label?: string };
    label = payload.label?.trim().slice(0, 80) || label;
  } catch {
    // A label is optional.
  }

  try {
    const token = await issueApiToken(ownerKey, label);
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
