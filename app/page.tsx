import type { Metadata } from "next";
import { getCurrentPrincipal } from "../lib/principal";
import { RelayLanding } from "./relay-landing";
import RelayDashboard from "./relay-dashboard";

export const metadata: Metadata = {
  title: { absolute: "Relay — Encrypted checkpoints for agent workspaces." },
  description:
    "Capture, encrypt, and restore AI agent workspaces without exposing source files, workspace context, or recovery keys to Relay.",
};

export const dynamic = "force-dynamic";

export default async function Home() {
  const principal = await getCurrentPrincipal();
  if (!principal) return <RelayLanding />;

  return (
    <RelayDashboard
      displayName={principal.displayName}
      email={principal.email}
      organizationName={principal.organizationName}
      authSource={principal.source}
      isLocalPreview={principal.source === "local"}
    />
  );
}
