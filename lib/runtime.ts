import { env } from "cloudflare:workers";
import { ensureRelaySchema } from "../db/identity";

type RelayRuntimeEnv = {
  DB?: D1Database;
  RELAY_LOCAL_PREVIEW?: string;
  VIBELOFT_PRODUCT_ID?: string;
  VIBELOFT_WEB_AUTH_KEY?: string;
};

export function getRelayRuntimeEnv(): RelayRuntimeEnv {
  const runtime = env as unknown as RelayRuntimeEnv;
  const local = typeof process === "undefined" ? undefined : process.env;
  return {
    DB: runtime.DB,
    RELAY_LOCAL_PREVIEW:
      runtime.RELAY_LOCAL_PREVIEW ?? local?.RELAY_LOCAL_PREVIEW,
    VIBELOFT_PRODUCT_ID:
      runtime.VIBELOFT_PRODUCT_ID ?? local?.VIBELOFT_PRODUCT_ID,
    VIBELOFT_WEB_AUTH_KEY:
      runtime.VIBELOFT_WEB_AUTH_KEY ?? local?.VIBELOFT_WEB_AUTH_KEY,
  };
}

export function getVibeLoftTelemetryConfig():
  | { productId: string; authKey: string }
  | undefined {
  const runtime = getRelayRuntimeEnv();
  const productId = runtime.VIBELOFT_PRODUCT_ID?.trim();
  const authKey = runtime.VIBELOFT_WEB_AUTH_KEY?.trim();
  return productId && authKey ? { productId, authKey } : undefined;
}

export function isLocalPreviewEnabled(): boolean {
  return getRelayRuntimeEnv().RELAY_LOCAL_PREVIEW === "true";
}

export async function prepareRelayStorage(): Promise<void> {
  const runtime = getRelayRuntimeEnv();
  if (!runtime.DB) throw new Error("Relay storage is unavailable.");
  await ensureRelaySchema(runtime.DB);
}
