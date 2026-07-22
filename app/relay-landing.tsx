"use client";

import {
  ArrowRight,
  Check,
  Cloud,
  Copy,
  Download,
  KeyRound,
  Laptop,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

const INSTALL_PROMPT_LABEL = "Install Relay's checkpoint skills in this project.";

function installPrompt(origin: string) {
  const bundleUrl = `${origin}/skills/relay-checkpoint-skills.zip`;
  const checksumUrl = `${bundleUrl}.sha256`;

  return `Install Relay's checkpoint skills in this project. No Relay sign-in is needed for installation.

Relay URL: ${origin}

1. Download ${bundleUrl} and ${checksumUrl} yourself. Do not ask me to download either file.
2. Verify the ZIP against the published SHA-256 checksum before opening it.
3. Inspect the archive. It must contain only these two skill folders under .agents/skills/:
   - agent-workspace-checkpoint
   - restore-agent-workspace
4. Install or update only those folders in this project. Preserve unrelated skills, and ask before replacing locally modified Relay skill files.
5. Read both SKILL.md files.
6. Stop after installation. Do not sign in, connect an account, create a checkpoint, upload, download, decrypt, or restore anything yet.`;
}

export function RelayLanding() {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  async function copyInstallPrompt() {
    const origin = window.location.origin;
    try {
      await navigator.clipboard.writeText(installPrompt(origin));
      setCopyError(false);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      setCopyError(true);
    }
  }

  return (
    <div className="landing-shell">
      <header className="landing-header">
        <Link className="landing-brand" href="/" aria-label="Relay home">
          <span className="relay-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <strong>Relay</strong>
        </Link>

        <nav className="landing-nav" aria-label="Main navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#privacy">Privacy</a>
        </nav>

        <Link className="landing-vault-link" href="/sign-in?return_to=%2F">
          Open your backups
          <ArrowRight size={15} aria-hidden="true" />
        </Link>
      </header>

      <main>
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="hero-copy">
            <p className="landing-kicker">
              <Sparkles size={14} aria-hidden="true" />
              Install without an account
            </p>
            <h1 id="landing-title">
              Install without login.
              <span>Sign in to upload.</span>
            </h1>
            <p className="hero-lede">
              Give your agent one prompt to install Relay&rsquo;s checkpoint
              skills with no account. Creating the encrypted checkpoint stays
              local; uploading it to Relay requires a one-time sign-in approval.
            </p>

            <div className="hero-actions">
              <button
                className="landing-button primary"
                type="button"
                onClick={() => void copyInstallPrompt()}
              >
                {copied ? <Check size={17} /> : <Copy size={17} />}
                {copied ? "Prompt copied" : "Copy install prompt"}
              </button>
              <a
                className="landing-button secondary"
                href="/skills/relay-checkpoint-skills.zip"
                download
              >
                <Download size={17} aria-hidden="true" />
                Download verified bundle
              </a>
            </div>
            <p className={`copy-feedback${copyError ? " error" : ""}`} role="status">
              {copyError
                ? "Clipboard access is blocked. Download the bundle instead."
                : "Paste the prompt into your agent. Installation stays local."}
            </p>
          </div>

          <div className="install-visual" aria-label="Relay skill installation preview">
            <div className="install-window">
              <div className="install-window-bar">
                <span className="window-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span>relay / skill setup</span>
                <span className="verified-badge">
                  <ShieldCheck size={12} /> verified
                </span>
              </div>

              <div className="install-window-body">
                <div className="prompt-bubble">
                  <span>You</span>
                  <p>{INSTALL_PROMPT_LABEL}</p>
                </div>

                <div className="install-response">
                  <div className="agent-orb" aria-hidden="true">
                    <SquareTerminal size={17} />
                  </div>
                  <div>
                    <p className="response-label">Agent</p>
                    <ul>
                      <li>
                        <Check size={14} /> Bundle checksum verified
                      </li>
                      <li>
                        <Check size={14} /> 2 Relay skills installed
                      </li>
                      <li>
                        <Check size={14} /> Instructions read and ready
                      </li>
                    </ul>
                  </div>
                </div>

                <div className="ready-strip">
                  <span className="ready-pulse" aria-hidden="true" />
                  <div>
                    <strong>Installed — upload not connected</strong>
                    <small>Sign-in is required before the first upload.</small>
                  </div>
                </div>
              </div>
            </div>

            <div className="floating-note note-local">
              <Laptop size={16} />
              <span>
                <strong>Local first</strong>
                Skills install in your project
              </span>
            </div>
            <div className="floating-note note-private">
              <LockKeyhole size={16} />
              <span>
                <strong>Zero knowledge</strong>
                Relay never gets your key
              </span>
            </div>
          </div>
        </section>

        <section className="trust-ribbon" aria-label="Relay promises">
          <div>
            <Check size={15} />
            <span><strong>Public install</strong> — no login</span>
          </div>
          <div>
            <KeyRound size={15} />
            <span><strong>Local encryption</strong> — your key stays put</span>
          </div>
          <div>
            <Cloud size={15} />
            <span><strong>Private upload</strong> — login required</span>
          </div>
        </section>

        <section className="how-section" id="how-it-works" aria-labelledby="how-title">
          <div className="section-heading">
            <p className="landing-kicker">From zero to safely backed up</p>
            <h2 id="how-title">Install freely. Sign in before anything uploads.</h2>
            <p>
              Install first and keep working. Relay asks who you are only when
              you upload or retrieve a private checkpoint.
            </p>
          </div>

          <div className="journey-grid">
            <article className="journey-card install-card">
              <div className="journey-number">01</div>
              <span className="journey-icon"><Download size={19} /></span>
              <p className="journey-status free">No login</p>
              <h3>Install the skills</h3>
              <p>
                Copy the prompt above. Your agent verifies the public bundle,
                installs two skills, and stops there.
              </p>
            </article>

            <article className="journey-card ask-card">
              <div className="journey-number">02</div>
              <span className="journey-icon"><SquareTerminal size={19} /></span>
              <p className="journey-status local">Still local</p>
              <h3>Create the checkpoint</h3>
              <p>
                Say: &ldquo;Create an encrypted Relay checkpoint of this
                project.&rdquo; The skill prepares a safe local archive and asks
                whether to share an agent summary or use a playful pseudonym.
                Nothing has uploaded yet.
              </p>
            </article>

            <article className="journey-card approve-card">
              <div className="journey-number">03</div>
              <span className="journey-icon"><ShieldCheck size={19} /></span>
              <p className="journey-status once">Login required</p>
              <h3>Sign in, then upload</h3>
              <p>
                Your agent must open a short-code approval if you&rsquo;re not
                connected. Only after approval does it upload encrypted workspace
                data with the agent profile you approved or pseudonymized.
              </p>
            </article>
          </div>
        </section>

        <section className="first-backup-section" aria-labelledby="backup-title">
          <div className="backup-copy">
            <p className="landing-kicker">Your first upload</p>
            <h2 id="backup-title">Not signed in? Relay pauses before upload.</h2>
            <p>
              The checkpoint skill notices the missing connection and guides the
              whole flow. You approve the matching code in your browser; only
              then can the agent upload the encrypted checkpoint. It never asks
              you for API keys or terminal commands.
            </p>
            <div className="backup-facts">
              <span><Check size={14} /> Login required to upload</span>
              <span><Check size={14} /> 90-day revocable connection</span>
              <span><Check size={14} /> Recovery key stays local</span>
              <span><Check size={14} /> Agent profile is your choice</span>
            </div>
          </div>

          <div className="backup-demo" aria-label="First backup conversation example">
            <div className="backup-demo-header">
              <span className="status-dot" />
              First checkpoint
              <span>agent conversation</span>
            </div>
            <div className="backup-message user">
              Upload this encrypted checkpoint to Relay.
            </div>
            <div className="backup-message agent">
              <span className="mini-mark"><SquareTerminal size={13} /></span>
              <div>
                <p>Sign-in is required before I can upload. I opened Relay once.</p>
                <strong>Approve code &nbsp; R8LY-K2QP</strong>
              </div>
            </div>
            <div className="backup-complete">
              <ShieldCheck size={16} />
              <div>
                <strong>Signed in · encrypted checkpoint uploaded</strong>
                <span>Ciphertext + your chosen agent profile</span>
              </div>
            </div>
          </div>
        </section>

        <section className="privacy-section" id="privacy" aria-labelledby="privacy-title">
          <div className="privacy-lock" aria-hidden="true">
            <span><LockKeyhole size={28} /></span>
          </div>
          <div>
            <p className="landing-kicker">Private by construction</p>
            <h2 id="privacy-title">Relay stores the backup. Not the meaning.</h2>
            <p>
              Files are selected, sanitized, and encrypted on your machine.
              Relay receives an opaque <code>.relay</code> file plus either the
              agent profile you approved or a playful privacy-safe pseudonym—not
              your source, readable workspace name, handoff notes, or recovery key.
            </p>
          </div>
          <dl className="privacy-list">
            <div>
              <dt>Encryption</dt>
              <dd>AES-256-GCM, locally</dd>
            </div>
            <div>
              <dt>Relay can read</dt>
              <dd>ID, size, time, chosen agent profile</dd>
            </div>
            <div>
              <dt>Relay cannot read</dt>
              <dd>Files, workspace metadata, recovery key</dd>
            </div>
          </dl>
        </section>

        <section className="landing-cta" aria-labelledby="cta-title">
          <div>
            <p className="landing-kicker">Ready when you are</p>
            <h2 id="cta-title">Install now. Sign in when you upload.</h2>
            <p>No account for installation. Relay login is required for cloud uploads.</p>
          </div>
          <div className="cta-actions">
            <button
              className="landing-button light"
              type="button"
              onClick={() => void copyInstallPrompt()}
            >
              {copied ? <Check size={17} /> : <Copy size={17} />}
              {copied ? "Prompt copied" : "Copy install prompt"}
            </button>
            <Link className="cta-text-link" href="/sign-in?return_to=%2F">
              I already use Relay <ArrowRight size={15} />
            </Link>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <Link className="landing-brand" href="/">
          <span className="relay-mark" aria-hidden="true"><span /><span /><span /></span>
          <strong>Relay</strong>
        </Link>
        <p>Pause here. Continue anywhere.</p>
        <div>
          <a href="/skills/relay-checkpoint-skills.zip.sha256">Bundle checksum</a>
          <Link href="/sign-in?return_to=%2F">Sign in</Link>
        </div>
      </footer>
    </div>
  );
}
