"use client";

import {
  ArrowRight,
  Check,
  Copy,
  Download,
  Globe2,
  Laptop,
  LockKeyhole,
  ShieldCheck,
  SquareTerminal,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

const INSTALL_PROMPT_LABEL = "Create a private Relay checkpoint of this workspace.";

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
          Open Relay
          <ArrowRight size={15} aria-hidden="true" />
        </Link>
      </header>

      <main>
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="hero-copy">
            <p className="landing-kicker">
              <ShieldCheck size={14} aria-hidden="true" />
              Private by default · public by choice
            </p>
            <h1 id="landing-title">
              Workspace checkpoints
              <span>private or public.</span>
            </h1>
            <p className="hero-lede">
              Keep a checkpoint as locally encrypted ciphertext, or deliberately
              publish a separately sanitized artifact for stable, anonymous,
              keyless restore. You choose the boundary.
            </p>

            <div className="hero-actions">
              <button
                className="landing-button primary"
                type="button"
                onClick={() => void copyInstallPrompt()}
              >
                {copied ? <Check size={17} /> : <Copy size={17} />}
                {copied ? "Prompt copied" : "Install Relay skills"}
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
                : "Paste the prompt into your agent. Relay verifies the bundle before installation."}
            </p>
          </div>

          <div className="install-visual" aria-label="Relay private encrypted checkpoint preview">
            <div className="install-window">
              <div className="install-window-bar">
                <span className="window-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span>relay / private checkpoint</span>
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
                        <Check size={14} /> Sensitive files excluded locally
                      </li>
                      <li>
                        <Check size={14} /> Workspace encrypted with AES-256-GCM
                      </li>
                      <li>
                        <Check size={14} /> Integrity manifest sealed
                      </li>
                    </ul>
                  </div>
                </div>

                <div className="ready-strip">
                  <span className="ready-pulse" aria-hidden="true" />
                  <div>
                    <strong>Checkpoint secured — key stays local</strong>
                    <small>Private mode stores ciphertext, never plaintext.</small>
                  </div>
                </div>
              </div>
            </div>

            <div className="floating-note note-local">
              <Laptop size={16} />
              <span>
                <strong>Local first</strong>
                Encryption happens on your machine
              </span>
            </div>
            <div className="floating-note note-private">
              <LockKeyhole size={16} />
              <span>
                <strong>Zero knowledge</strong>
                Private checkpoint keys never reach Relay
              </span>
            </div>
          </div>
        </section>

        <section className="trust-ribbon" aria-label="Relay promises">
          <div>
            <LockKeyhole size={15} />
            <span><strong>Private</strong> — AES-256-GCM ciphertext</span>
          </div>
          <div>
            <Globe2 size={15} />
            <span><strong>Public</strong> — intentionally readable, keyless restore</span>
          </div>
          <div>
            <ShieldCheck size={15} />
            <span><strong>Verified restore</strong> — hashes and paths checked</span>
          </div>
        </section>

        <section className="how-section" id="how-it-works" aria-labelledby="how-title">
          <div className="section-heading">
            <p className="landing-kicker">A deliberate visibility boundary</p>
            <h2 id="how-title">One workflow, two clear choices.</h2>
            <p>
              Every checkpoint is filtered and verified locally. Private artifacts
              remain encrypted; public artifacts are readable by design.
            </p>
          </div>

          <div className="journey-grid">
            <article className="journey-card install-card">
              <div className="journey-number">01</div>
              <span className="journey-icon"><SquareTerminal size={19} /></span>
              <p className="journey-status free">On your machine</p>
              <h3>Sanitize at the source</h3>
              <p>
                Relay&rsquo;s skill selects the workspace state and excludes secrets,
                unsafe paths, caches, dependencies, and other disposable data.
              </p>
            </article>

            <article className="journey-card ask-card">
              <div className="journey-number">02</div>
              <span className="journey-icon"><Globe2 size={19} /></span>
              <p className="journey-status local">Your choice</p>
              <h3>Choose who can read it</h3>
              <p>
                Private checkpoints are sealed locally with AES-256-GCM. Public
                checkpoints use no key and publish only the title, description,
                metadata, and files you explicitly approve.
              </p>
            </article>

            <article className="journey-card approve-card">
              <div className="journey-number">03</div>
              <span className="journey-icon"><ShieldCheck size={19} /></span>
              <p className="journey-status once">Cryptographically checked</p>
              <h3>Restore with proof</h3>
              <p>
                Private restore decrypts locally. Public restore needs no sign-in or
                key. Both paths reject unsafe paths and verify every file hash.
              </p>
            </article>
          </div>
        </section>

        <section className="first-backup-section" aria-labelledby="backup-title">
          <div className="backup-copy">
            <p className="landing-kicker">Private means private</p>
            <h2 id="backup-title">Private ciphertext stays unreadable to Relay.</h2>
            <p>
              A private archive is encrypted before it leaves your workspace.
              Publishing creates a separate readable artifact only after a local
              preview and explicit confirmation; it never uploads the original key.
            </p>
            <div className="backup-facts">
              <span><Check size={14} /> AES-256-GCM encryption</span>
              <span><Check size={14} /> Secrets excluded before packing</span>
              <span><Check size={14} /> Recovery key stays local</span>
              <span><Check size={14} /> Every restored file is verified</span>
              <span><Check size={14} /> Public artifacts are clearly labeled</span>
              <span><Check size={14} /> Publication is effectively irreversible</span>
            </div>
          </div>

          <div className="backup-demo" aria-label="Relay checkpoint security example">
            <div className="backup-demo-header">
              <span className="status-dot" />
              Private checkpoint protection
              <span>private-mode example</span>
            </div>
            <div className="backup-message user">
              Create a secure checkpoint of this workspace.
            </div>
            <div className="backup-message agent">
              <span className="mini-mark"><SquareTerminal size={13} /></span>
              <div>
                <p>Secrets excluded. Workspace encrypted locally. Recovery key saved separately.</p>
                <strong>AES-256-GCM &nbsp; · &nbsp; manifest sealed</strong>
              </div>
            </div>
            <div className="backup-complete">
              <ShieldCheck size={16} />
              <div>
                <strong>Ciphertext uploaded · integrity verified</strong>
                <span>Relay received no source files, workspace name, or recovery key</span>
              </div>
            </div>
          </div>
        </section>

        <section className="privacy-section" id="privacy" aria-labelledby="privacy-title">
          <div className="privacy-lock" aria-hidden="true">
            <span><LockKeyhole size={28} /></span>
          </div>
          <div>
            <p className="landing-kicker">A boundary you can see</p>
            <h2 id="privacy-title">Private is encrypted. Public is intentionally readable.</h2>
            <p>
              Private mode sends an opaque <code>.relay</code> file plus approved
              or pseudonymous agent metadata. Public mode sends a separate sanitized
              archive plus the public title and description you approve. Anyone with
              its stable URL can read and restore it without a key.
            </p>
          </div>
          <dl className="privacy-list">
            <div>
              <dt>Private mode</dt>
              <dd>AES-256-GCM, locally keyed</dd>
            </div>
            <div>
              <dt>Public mode</dt>
              <dd>Readable, permanent, keyless</dd>
            </div>
            <div>
              <dt>Agent metadata</dt>
              <dd>Shared or pseudonymous, independently</dd>
            </div>
          </dl>
        </section>

        <section className="landing-cta" aria-labelledby="cta-title">
          <div>
            <p className="landing-kicker">Protect the next handoff</p>
            <h2 id="cta-title">Give your agent a secure place to resume.</h2>
            <p>Install Relay, choose private or public, and restore with integrity verification.</p>
          </div>
          <div className="cta-actions">
            <button
              className="landing-button light"
              type="button"
              onClick={() => void copyInstallPrompt()}
            >
              {copied ? <Check size={17} /> : <Copy size={17} />}
              {copied ? "Prompt copied" : "Install Relay skills"}
            </button>
            <Link className="cta-text-link" href="/sign-in?return_to=%2F">
              Open checkpoint registry <ArrowRight size={15} />
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
          <Link href="/sign-in?return_to=%2F">Open Relay</Link>
        </div>
      </footer>
    </div>
  );
}
