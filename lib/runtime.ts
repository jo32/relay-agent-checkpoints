import { env } from "cloudflare:workers";
import { ensureRelaySchema } from "../db/identity";

type RelayRuntimeEnv = {
  DB?: D1Database;
  RELAY_LOCAL_PREVIEW?: string;
};

export function getRelayRuntimeEnv(): RelayRuntimeEnv {
  const runtime = env as unknown as RelayRuntimeEnv;
  const local = typeof process === "undefined" ? undefined : process.env;
  return {
    DB: runtime.DB,
    RELAY_LOCAL_PREVIEW:
      runtime.RELAY_LOCAL_PREVIEW ?? local?.RELAY_LOCAL_PREVIEW,
  };
}

export function isLocalPreviewEnabled(): boolean {
  return getRelayRuntimeEnv().RELAY_LOCAL_PREVIEW === "true";
}

export async function prepareRelayStorage(): Promise<void> {
  const runtime = getRelayRuntimeEnv();
  if (!runtime.DB) throw new Error("Relay storage is unavailable.");
  await ensureRelaySchema(runtime.DB);
}
