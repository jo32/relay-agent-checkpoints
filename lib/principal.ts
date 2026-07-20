import { headers } from "next/headers";
import { getChatGPTUser } from "../app/chatgpt-auth";
import {
  getAuth,
  getRelayAuthEnv,
  isLocalPreviewEnabled,
  prepareAuthStorage,
} from "./auth";
import {
  claimLegacyOwnership,
  ensureChatGPTIdentity,
  ensurePersonalOrganization,
} from "../db/identity";

export type AuthSource = "better-auth" | "chatgpt" | "local";

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
  await prepareAuthStorage();
  const runtime = getRelayAuthEnv();
  const db = runtime.DB!;
  const requestHeaders = await headers();

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
      source: "better-auth",
    };
  }

  const chatGPTUser = await getChatGPTUser();
  if (chatGPTUser) {
    const user = await ensureChatGPTIdentity(
      db,
      chatGPTUser.email,
      chatGPTUser.displayName,
    );
    const organization = await ensurePersonalOrganization(
      db,
      user.userId,
      user.name,
    );
    await claimLegacyOwnership(
      db,
      user.email,
      organization.organizationId,
      user.userId,
    );
    return {
      userId: user.userId,
      tenantId: organization.organizationId,
      organizationName: organization.organizationName,
      role: organization.role,
      displayName: user.name,
      email: user.email,
      source: "chatgpt",
    };
  }

  if (isLocalPreviewEnabled() && process.env.NODE_ENV !== "production") {
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

  return null;
}

export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  return origin === new URL(request.url).origin;
}
