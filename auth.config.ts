import { betterAuth } from "better-auth";
import { relayAccountPolicy, relayAuthPlugins } from "./lib/auth-shared";

// Schema-only configuration used by the Better Auth CLI. Runtime bindings and
// provider secrets are supplied lazily by lib/auth.ts inside Cloudflare Workers.
export const auth = betterAuth({
  account: relayAccountPolicy,
  plugins: relayAuthPlugins(),
});
