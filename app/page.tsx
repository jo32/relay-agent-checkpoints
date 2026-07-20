import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "../lib/principal";
import RelayDashboard from "./relay-dashboard";

export const metadata: Metadata = {
  title: { absolute: "Relay — Portable agent checkpoints" },
  description:
    "Store, share, and restore sanitized workspace checkpoints created by agent skills.",
};

export const dynamic = "force-dynamic";

export default async function Home() {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/sign-in");

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
