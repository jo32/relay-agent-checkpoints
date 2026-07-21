"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";
import { authClient } from "../../lib/auth-client";

type SocialProvider = "google" | "github";

export default function SignInButtons({
  googleEnabled,
  githubEnabled,
  callbackURL,
}: {
  googleEnabled: boolean;
  githubEnabled: boolean;
  callbackURL: string;
}) {
  const [pending, setPending] = useState<SocialProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function signIn(provider: SocialProvider) {
    setPending(provider);
    setError(null);
    const result = await authClient.signIn.social({
      provider,
      callbackURL,
      errorCallbackURL: `/sign-in?return_to=${encodeURIComponent(callbackURL)}`,
    });
    if (result.error) {
      setError(result.error.message || "Sign-in could not be started.");
      setPending(null);
    }
  }

  return (
    <div className="auth-actions">
      {googleEnabled && (
        <button
          className="auth-provider-button"
          type="button"
          disabled={pending !== null}
          onClick={() => void signIn("google")}
        >
          {pending === "google" ? (
            <Loader2 className="auth-spinner" size={18} />
          ) : (
            <span className="provider-letter" aria-hidden="true">
              G
            </span>
          )}
          Continue with Google
        </button>
      )}

      {githubEnabled && (
        <button
          className="auth-provider-button"
          type="button"
          disabled={pending !== null}
          onClick={() => void signIn("github")}
        >
          {pending === "github" ? (
            <Loader2 className="auth-spinner" size={18} />
          ) : (
            <span className="provider-letter" aria-hidden="true">
              GH
            </span>
          )}
          Continue with GitHub
        </button>
      )}

      {(googleEnabled || githubEnabled) && (
        <div className="auth-divider">
          <span />
          <small>or</small>
          <span />
        </div>
      )}

      <a
        className="auth-provider-button chatgpt"
        href={`/signin-with-chatgpt?return_to=${encodeURIComponent(callbackURL)}`}
      >
        <span className="provider-letter chatgpt" aria-hidden="true">
          C
        </span>
        Continue with ChatGPT
      </a>

      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
