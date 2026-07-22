import type { Metadata } from "next";
import { getCurrentPrincipal } from "../lib/principal";
import { RelayLanding } from "./relay-landing";
import RelayDashboard from "./relay-dashboard";

export const metadata: Metadata = {
  title: { absolute: "Relay — Install now. Back up when you’re ready." },
  description:
    "Install Relay's checkpoint skills without an account. Sign in only when you're ready to create a private encrypted backup.",
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
