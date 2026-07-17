import type { Metadata } from "next";
import { getChatGPTUser } from "./chatgpt-auth";
import RelayDashboard from "./relay-dashboard";

export const metadata: Metadata = {
  title: { absolute: "Relay — Portable agent checkpoints" },
  description:
    "Store, share, and restore sanitized workspace checkpoints created by agent skills.",
};

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getChatGPTUser();
  return (
    <RelayDashboard
      displayName={user?.displayName ?? "Jo"}
      email={user?.email ?? "Local workspace"}
    />
  );
}
