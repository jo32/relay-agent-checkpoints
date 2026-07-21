import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
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
  searchParams: Promise<{ return_to?: string }>;
}) {
  const returnTo = safeReturnTo((await searchParams).return_to);
  const principal = await getCurrentPrincipal();
  if (principal) redirect(returnTo);

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

        <SignInButtons callbackURL={returnTo} />

        <p className="auth-legal">
          Share links never contain your encryption key.
        </p>
      </section>
    </main>
  );
}

function safeReturnTo(value: string | undefined) {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const parsed = new URL(value, "https://relay.local");
    if (parsed.origin !== "https://relay.local") return "/";
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/";
  }
}
