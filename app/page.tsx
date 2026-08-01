import type { Metadata } from "next";
import { getCurrentPrincipal } from "../lib/principal";
import { RelayLanding } from "./relay-landing";
import RelayDashboard from "./relay-dashboard";

export const metadata: Metadata = {
  title: { absolute: "Relay — Private or public checkpoints for agents and skills." },
  description:
    "Keep agent workspaces or individual skills locally encrypted, or intentionally publish a sanitized artifact for stable, keyless restore.",
};

export const dynamic = "force-dynamic";

export default async function Home() {
  const principal = await getCurrentPrincipal();
  if (!principal) return <RelayLanding />;

  return (
    <RelayDashboard
      email={principal.email}
      organizationName={principal.organizationName}
      authSource={principal.source}
      isLocalPreview={principal.source === "local"}
    />
  );
}
