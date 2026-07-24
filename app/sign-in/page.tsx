import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { isGitHubAuthConfigured } from "../../lib/auth";
import { getCurrentPrincipal } from "../../lib/principal";
import SignInButtons from "./sign-in-buttons";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to your Relay checkpoint registry.",
};

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ return_to?: string; error?: string }>;
}) {
  const params = await searchParams;
  const returnTo = safeReturnTo(params.return_to);
  const principal = await getCurrentPrincipal();
  if (principal) redirect(returnTo);
  const githubEnabled = isGitHubAuthConfigured();

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="sign-in-title">
        <div className="auth-card-top">
          <Link className="auth-brand" href="/" aria-label="Relay home">
            <span className="relay-mark" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <strong>Relay</strong>
          </Link>
          <Link className="auth-home-link" href="/">
            <ArrowLeft size={14} aria-hidden="true" />
            Back to home
          </Link>
        </div>

        <div className="auth-heading">
          <span className="eyebrow">Your private backup vault</span>
          <h1 id="sign-in-title">Pick up where you left off.</h1>
          <p>
            Sign in to upload, share, or restore an encrypted agent workspace.
            Installing the skills never requires an account.
          </p>
        </div>

        {githubEnabled ? (
          <SignInButtons
            callbackURL={returnTo}
            initialError={
              params.error
                ? "GitHub sign-in was not completed. Please try again."
                : undefined
            }
          />
        ) : (
          <p className="auth-configuration-note" role="status">
            GitHub sign-in is not configured for this deployment.
          </p>
        )}

        <p className="auth-legal">Relay never stores your encryption key.</p>
      </section>
    </main>
  );
}

function safeReturnTo(value: string | undefined) {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const parsed = new URL(value, "https://relay.local");
    if (parsed.origin !== "https://relay.local") return "/";
    if (
      parsed.pathname === "/sign-in" ||
      parsed.pathname.startsWith("/api/auth/")
    ) {
      return "/";
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/";
  }
}
