import type { Metadata } from "next";
import { getCurrentPrincipal } from "../lib/principal";
import { RelayLanding } from "./relay-landing";
import RelayDashboard from "./relay-dashboard";

export const metadata: Metadata = {
  title: { absolute: "Relay — Install without login. Sign in to upload." },
  description:
    "Install Relay's checkpoint skills without an account. Sign in is required before uploading a private encrypted checkpoint.",
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
