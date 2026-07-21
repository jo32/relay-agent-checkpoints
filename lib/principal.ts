import { getChatGPTUser } from "../app/chatgpt-auth";
import {
  getRelayRuntimeEnv,
  isLocalPreviewEnabled,
  prepareRelayStorage,
} from "./runtime";
import {
  claimLegacyOwnership,
  ensureChatGPTIdentity,
  ensurePersonalOrganization,
} from "../db/identity";

export type AuthSource = "chatgpt" | "local";

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
  await prepareRelayStorage();
  const runtime = getRelayRuntimeEnv();
  const db = runtime.DB!;

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
