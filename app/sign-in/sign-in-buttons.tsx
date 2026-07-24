"use client";

import { GitFork, Loader2 } from "lucide-react";
import { useState } from "react";
import { authClient } from "../../lib/auth-client";

export default function SignInButtons({
  callbackURL,
  initialError,
}: {
  callbackURL: string;
  initialError?: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);

  async function signIn() {
    setPending(true);
    setError(null);

    try {
      const result = await authClient.signIn.social({
        provider: "github",
        callbackURL,
        errorCallbackURL: `/sign-in?return_to=${encodeURIComponent(callbackURL)}`,
      });
      if (result.error) {
        setError(result.error.message || "GitHub sign-in could not be started.");
        setPending(false);
      }
    } catch {
      setError("GitHub sign-in could not be started. Please try again.");
      setPending(false);
    }
  }

  return (
    <div className="auth-actions">
      <button
        className="auth-provider-button github"
        type="button"
        disabled={pending}
        aria-busy={pending}
        onClick={() => void signIn()}
      >
        {pending ? (
          <Loader2 className="auth-spinner" size={18} aria-hidden="true" />
        ) : (
          <GitFork size={18} aria-hidden="true" />
        )}
        <span>{pending ? "Connecting to GitHub…" : "Continue with GitHub"}</span>
        <span aria-hidden="true" />
      </button>

      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
