import { getSessionCookie } from "better-auth/cookies";
import { headers } from "next/headers";
import { getAuth, prepareAuthStorage } from "./auth";
import { getRelayRuntimeEnv, isLocalPreviewEnabled } from "./runtime";
import {
  claimLegacyOwnership,
  ensurePersonalOrganization,
} from "../db/identity";

export type AuthSource = "github" | "local";

export type RelayPrincipal = {
  userId: string;
  tenantId: string;
  organizationName: string;
  role: string;
  displayName: string;
  email: string;
  source: AuthSource;
};

export async function getCurrentPrincipal(): Promise<RelayPrincipal | null> {
  const useLocalPreview =
    isLocalPreviewEnabled() && process.env.NODE_ENV !== "production";
  const requestHeaders = await headers();
  const sessionCookie = getSessionCookie(requestHeaders, {
    cookiePrefix: "relay",
  });

  // Keep the public install page independent from private checkpoint storage.
  if (!sessionCookie && !useLocalPreview) return null;
  if (!sessionCookie) return localPreviewPrincipal();

  await prepareAuthStorage();
  const runtime = getRelayRuntimeEnv();
  const db = runtime.DB!;
  const session = await getAuth().api.getSession({
    headers: requestHeaders,
  });

  if (session?.user) {
    const organization = await ensurePersonalOrganization(
      db,
      session.user.id,
      session.user.name,
    );
    await claimLegacyOwnership(
      db,
      session.user.email,
      organization.organizationId,
      session.user.id,
    );
    return {
      userId: session.user.id,
      tenantId: organization.organizationId,
      organizationName: organization.organizationName,
      role: organization.role,
      displayName: session.user.name,
      email: session.user.email,
      source: "github",
    };
  }

  return useLocalPreview ? localPreviewPrincipal() : null;
}

export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  return origin === new URL(request.url).origin;
}

function localPreviewPrincipal(): RelayPrincipal {
  return {
    userId: "local-preview-user",
    tenantId: "local-preview",
    organizationName: "Local preview",
    role: "owner",
    displayName: "Local developer",
    email: "local-preview",
    source: "local",
  };
}
