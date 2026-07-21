import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { findDeviceAuthorization } from "../../db/device-authorization";
import { getCurrentPrincipal } from "../../lib/principal";
import DeviceApproval from "./device-approval";

export const metadata: Metadata = {
  title: "Connect local agent",
  description: "Approve a local Relay checkpoint skill.",
};

export const dynamic = "force-dynamic";

export default async function DevicePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const code = (await searchParams).code?.trim().toUpperCase() ?? "";
  const principal = await getCurrentPrincipal();
  if (!principal) {
    const returnTo = code ? `/device?code=${encodeURIComponent(code)}` : "/device";
    redirect(`/sign-in?return_to=${encodeURIComponent(returnTo)}`);
  }

  const authorization = code ? await findDeviceAuthorization(code) : null;
  const unavailable =
    Boolean(code) &&
    (!authorization || authorization.expired || authorization.status !== "pending");

  return (
    <main className="auth-page">
      <section className="auth-card device-card" aria-labelledby="device-title">
        <Link className="auth-brand" href="/" aria-label="Relay home">
          <span className="relay-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <strong>Relay</strong>
        </Link>

        <div className="auth-heading">
          <span className="eyebrow">Device authorization</span>
          <h1 id="device-title">Connect a local agent.</h1>
          <p>Approve only if this code matches the one shown by your agent.</p>
        </div>

        {!code && (
          <form className="device-code-form" action="/device" method="get">
            <label htmlFor="device-code-input">One-time code</label>
            <input
              id="device-code-input"
              name="code"
              placeholder="ABCD-EFGH"
              autoComplete="one-time-code"
              required
            />
            <button className="button primary" type="submit">Continue</button>
          </form>
        )}

        {authorization && !unavailable && (
          <DeviceApproval
            userCode={authorization.userCode}
            clientName={authorization.clientName}
          />
        )}

        {unavailable && (
          <div className="device-result denied" role="alert">
            <div>
              <strong>Code unavailable</strong>
              <p>This code is invalid, expired, denied, or already used. Start sign-in again from the agent.</p>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
