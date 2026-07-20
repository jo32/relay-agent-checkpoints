import { env } from "cloudflare:workers";
import { betterAuth } from "better-auth";
import { relayAccountPolicy, relayAuthPlugins } from "./auth-shared";
import { ensureRelaySchema } from "../db/identity";

type RelayAuthEnv = {
  DB?: D1Database;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  RELAY_LOCAL_PREVIEW?: string;
};

type AuthInstance = ReturnType<typeof buildAuthInstance>;

let authInstance: AuthInstance | null = null;

export type AuthProviderStatus = {
  google: boolean;
  github: boolean;
};

export function getRelayAuthEnv(): RelayAuthEnv {
  const runtime = env as unknown as RelayAuthEnv;
  const local = typeof process === "undefined" ? undefined : process.env;
  return {
    DB: runtime.DB,
    BETTER_AUTH_URL: runtime.BETTER_AUTH_URL ?? local?.BETTER_AUTH_URL,
    BETTER_AUTH_SECRET: runtime.BETTER_AUTH_SECRET ?? local?.BETTER_AUTH_SECRET,
    GOOGLE_CLIENT_ID: runtime.GOOGLE_CLIENT_ID ?? local?.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET:
      runtime.GOOGLE_CLIENT_SECRET ?? local?.GOOGLE_CLIENT_SECRET,
    GITHUB_CLIENT_ID: runtime.GITHUB_CLIENT_ID ?? local?.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET:
      runtime.GITHUB_CLIENT_SECRET ?? local?.GITHUB_CLIENT_SECRET,
    RELAY_LOCAL_PREVIEW:
      runtime.RELAY_LOCAL_PREVIEW ?? local?.RELAY_LOCAL_PREVIEW,
  };
}

export function getAuthProviderStatus(): AuthProviderStatus {
  const runtime = getRelayAuthEnv();
  return {
    google: Boolean(runtime.GOOGLE_CLIENT_ID && runtime.GOOGLE_CLIENT_SECRET),
    github: Boolean(runtime.GITHUB_CLIENT_ID && runtime.GITHUB_CLIENT_SECRET),
  };
}

export function isLocalPreviewEnabled(): boolean {
  return getRelayAuthEnv().RELAY_LOCAL_PREVIEW === "true";
}

export async function prepareAuthStorage(): Promise<void> {
  const runtime = getRelayAuthEnv();
  if (!runtime.DB) throw new Error("Relay authentication storage is unavailable.");
  await ensureRelaySchema(runtime.DB);
}

export function getAuth(): AuthInstance {
  if (authInstance) return authInstance;

  authInstance = buildAuthInstance();
  return authInstance;
}

function buildAuthInstance() {
  const runtime = getRelayAuthEnv();
  if (!runtime.DB) throw new Error("Relay authentication storage is unavailable.");

  const providerStatus = getAuthProviderStatus();
  const configuredURL = runtime.BETTER_AUTH_URL?.trim();
  const secret =
    runtime.BETTER_AUTH_SECRET?.trim() ||
    (process.env.NODE_ENV !== "production"
      ? "relay-local-development-secret-change-before-production"
      : "");

  if (secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters.");
  }

  return betterAuth({
    appName: "Relay",
    database: runtime.DB,
    secret,
    baseURL:
      configuredURL ||
      ({
        allowedHosts: [
          "localhost",
          "localhost:*",
          "127.0.0.1",
          "127.0.0.1:*",
          "*.chatgpt.site",
        ],
        protocol: "auto",
      } as const),
    trustedOrigins: (request) => {
      const requestOrigin = request ? new URL(request.url).origin : null;
      return [configuredURL, requestOrigin].filter(
        (origin): origin is string => Boolean(origin),
      );
    },
    advanced: {
      cookiePrefix: "relay",
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip"],
      },
    },
    account: relayAccountPolicy,
    socialProviders: {
      ...(providerStatus.google
        ? {
            google: {
              clientId: runtime.GOOGLE_CLIENT_ID!,
              clientSecret: runtime.GOOGLE_CLIENT_SECRET!,
            },
          }
        : {}),
      ...(providerStatus.github
        ? {
            github: {
              clientId: runtime.GITHUB_CLIENT_ID!,
              clientSecret: runtime.GITHUB_CLIENT_SECRET!,
            },
          }
        : {}),
    },
    plugins: relayAuthPlugins(),
  });
}
