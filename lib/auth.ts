import { env } from "cloudflare:workers";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth";
import { drizzle } from "drizzle-orm/d1";
import { ensureRelaySchema } from "../db/identity";
import * as authSchema from "../db/auth-schema";

type RelayAuthEnv = {
  DB?: D1Database;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
};

type AuthInstance = ReturnType<typeof buildAuthInstance>;

let authInstance: AuthInstance | null = null;

export function getRelayAuthEnv(): RelayAuthEnv {
  const runtime = env as unknown as RelayAuthEnv;
  const local = typeof process === "undefined" ? undefined : process.env;

  return {
    DB: runtime.DB,
    BETTER_AUTH_URL: runtime.BETTER_AUTH_URL ?? local?.BETTER_AUTH_URL,
    BETTER_AUTH_SECRET:
      runtime.BETTER_AUTH_SECRET ?? local?.BETTER_AUTH_SECRET,
    GITHUB_CLIENT_ID:
      runtime.GITHUB_CLIENT_ID ?? local?.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET:
      runtime.GITHUB_CLIENT_SECRET ?? local?.GITHUB_CLIENT_SECRET,
  };
}

export function isGitHubAuthConfigured(): boolean {
  const runtime = getRelayAuthEnv();
  return Boolean(runtime.GITHUB_CLIENT_ID && runtime.GITHUB_CLIENT_SECRET);
}

export async function prepareAuthStorage(): Promise<void> {
  const runtime = getRelayAuthEnv();
  if (!runtime.DB) {
    throw new Error("Relay authentication storage is unavailable.");
  }
  await ensureRelaySchema(runtime.DB);
}

export function getAuth(): AuthInstance {
  if (!authInstance) authInstance = buildAuthInstance();
  return authInstance;
}

function buildAuthInstance() {
  const runtime = getRelayAuthEnv();
  if (!runtime.DB) {
    throw new Error("Relay authentication storage is unavailable.");
  }

  const isProduction = process.env.NODE_ENV === "production";
  const configuredURL = normalizeAuthURL(runtime.BETTER_AUTH_URL);
  if (isProduction && !configuredURL) {
    throw new Error("BETTER_AUTH_URL must be set in production.");
  }

  const secret =
    runtime.BETTER_AUTH_SECRET?.trim() ||
    (isProduction
      ? ""
      : "relay-local-development-secret-change-before-production");
  if (secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters.");
  }

  const githubConfigured = isGitHubAuthConfigured();

  return betterAuth({
    appName: "Relay",
    database: drizzleAdapter(drizzle(runtime.DB), {
      provider: "sqlite",
      schema: authSchema,
      transaction: false,
    }),
    secret,
    baseURL:
      configuredURL ||
      ({
        allowedHosts: [
          "localhost",
          "localhost:*",
          "127.0.0.1",
          "127.0.0.1:*",
        ],
        protocol: "auto",
      } as const),
    trustedOrigins: configuredURL
      ? [configuredURL]
      : ["http://localhost:*", "http://127.0.0.1:*"],
    advanced: {
      cookiePrefix: "relay",
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip"],
      },
    },
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        allowDifferentEmails: false,
        allowUnlinkingAll: false,
      },
    },
    socialProviders: githubConfigured
      ? {
          github: {
            clientId: runtime.GITHUB_CLIENT_ID!,
            clientSecret: runtime.GITHUB_CLIENT_SECRET!,
          },
        }
      : {},
  });
}

function normalizeAuthURL(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("BETTER_AUTH_URL must be a valid absolute URL.");
  }

  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "BETTER_AUTH_URL must be an HTTP(S) origin without a path, query, or hash.",
    );
  }

  return parsed.origin;
}
