import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthProviderStatus } from "../../lib/auth";
import { getCurrentPrincipal } from "../../lib/principal";
import SignInButtons from "./sign-in-buttons";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to your Relay checkpoint registry.",
};

export const dynamic = "force-dynamic";

export default async function SignInPage() {
  const principal = await getCurrentPrincipal();
  if (principal) redirect("/");

  const providers = getAuthProviderStatus();

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="sign-in-title">
        <Link className="auth-brand" href="/" aria-label="Relay home">
          <span className="relay-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <strong>Relay</strong>
        </Link>

        <div className="auth-heading">
          <span className="eyebrow">Secure workspace registry</span>
          <h1 id="sign-in-title">Continue your work anywhere.</h1>
          <p>
            Sign in to store, share, and restore sanitized agent workspace
            checkpoints.
          </p>
        </div>

        <SignInButtons
          googleEnabled={providers.google}
          githubEnabled={providers.github}
        />

        {!providers.google && !providers.github && (
          <p className="auth-configuration-note">
            Google and GitHub sign-in will appear after their OAuth credentials
            are configured.
          </p>
        )}

        <p className="auth-legal">
          Your archives stay private unless you create an expiring share link.
        </p>
      </section>
    </main>
  );
}
