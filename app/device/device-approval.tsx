"use client";

import { Check, Loader2, ShieldCheck, X } from "lucide-react";
import { useState } from "react";

export default function DeviceApproval({
  userCode,
  clientName,
  scopes,
}: {
  userCode: string;
  clientName: string;
  scopes: string[];
}) {
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);
  const [result, setResult] = useState<"approved" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canPublish = scopes.includes("checkpoints:publish");
  const canDelete = scopes.includes("checkpoints:delete");

  async function decide(decision: "approve" | "deny") {
    setPending(decision);
    setError(null);
    const response = await fetch("/api/device/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_code: userCode, decision }),
    });
    const payload = (await response.json()) as { error?: string; status?: string };
    if (!response.ok) {
      setError(payload.error || "Relay could not complete this request.");
      setPending(null);
      return;
    }
    setResult(decision === "approve" ? "approved" : "denied");
    setPending(null);
  }

  if (result) {
    return (
      <div className={`device-result ${result}`} role="status">
        {result === "approved" ? <Check size={20} /> : <X size={20} />}
        <div>
          <strong>{result === "approved" ? "Agent connected" : "Request denied"}</strong>
          <p>
            {result === "approved"
              ? "Return to your agent. It will finish signing in automatically."
              : "No Relay credential was issued."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="device-request">
        <ShieldCheck size={22} />
        <div>
          <span>Local agent requesting access</span>
          <strong>{clientName}</strong>
        </div>
      </div>
      <div className="device-code" aria-label={`Device code ${userCode}`}>
        {userCode}
      </div>
      <p className="device-scope">
        This permits private checkpoint upload, download, and expiring share-link
        creation. It never grants access to your local encryption key.
        {canPublish && (
          <>
            {" "}It also permits creating permanent public checkpoints and making
            your own private checkpoints publicly readable. Public disclosure is
            effectively irreversible.
          </>
        )}
        {canDelete && (
          <>
            {" "}It also permits permanently deleting your Relay-hosted checkpoint
            records, stored archives, public artifacts, and marketplace listings.
          </>
        )}
      </p>
      <div className="device-actions">
        <button
          className="button primary"
          type="button"
          disabled={pending !== null}
          onClick={() => void decide("approve")}
        >
          {pending === "approve" ? <Loader2 className="spin" size={15} /> : <Check size={15} />}
          Approve agent
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={pending !== null}
          onClick={() => void decide("deny")}
        >
          Deny
        </button>
      </div>
      {error && <p className="auth-error" role="alert">{error}</p>}
    </>
  );
}
