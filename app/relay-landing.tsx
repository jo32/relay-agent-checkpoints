"use client";

import {
  ArrowRight,
  Check,
  Copy,
  Download,
  KeyRound,
  Laptop,
  LockKeyhole,
  ShieldCheck,
  SquareTerminal,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

const INSTALL_PROMPT_LABEL = "Create a secure Relay checkpoint of this workspace.";

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
              Secure workspace continuity
            </p>
            <h1 id="landing-title">
              Encrypted checkpoints
              <span>for agent workspaces.</span>
            </h1>
            <p className="hero-lede">
              Relay lets an AI agent capture a project&rsquo;s files, context, and
              handoff state in a locally encrypted checkpoint—then restore it in
              another workspace without exposing the contents or recovery key to Relay.
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

          <div className="install-visual" aria-label="Relay encrypted checkpoint preview">
            <div className="install-window">
              <div className="install-window-bar">
                <span className="window-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span>relay / secure checkpoint</span>
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
                    <small>Relay stores ciphertext, never plaintext.</small>
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
                Relay never gets your key
              </span>
            </div>
          </div>
        </section>

        <section className="trust-ribbon" aria-label="Relay promises">
          <div>
            <LockKeyhole size={15} />
            <span><strong>AES-256-GCM</strong> — encrypted locally</span>
          </div>
          <div>
            <KeyRound size={15} />
            <span><strong>Zero knowledge</strong> — Relay never gets the key</span>
          </div>
          <div>
            <ShieldCheck size={15} />
            <span><strong>Verified restore</strong> — hashes and paths checked</span>
          </div>
        </section>

        <section className="how-section" id="how-it-works" aria-labelledby="how-title">
          <div className="section-heading">
            <p className="landing-kicker">Security from source to restore</p>
            <h2 id="how-title">A checkpoint built to travel safely.</h2>
            <p>
              Your agent filters the workspace, encrypts everything before it leaves
              your machine, and proves the restored files are exactly what you saved.
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
              <span className="journey-icon"><LockKeyhole size={19} /></span>
              <p className="journey-status local">Zero knowledge</p>
              <h3>Encrypt before upload</h3>
              <p>
                The checkpoint is sealed locally with AES-256-GCM. The recovery
                key stays with you; Relay receives only opaque ciphertext and
                minimal approved metadata.
              </p>
            </article>

            <article className="journey-card approve-card">
              <div className="journey-number">03</div>
              <span className="journey-icon"><ShieldCheck size={19} /></span>
              <p className="journey-status once">Cryptographically checked</p>
              <h3>Restore with proof</h3>
              <p>
                Restore decrypts on your machine, rejects unsafe paths, and verifies
                every file hash before handing the recovered workspace to a new agent.
              </p>
            </article>
          </div>
        </section>

        <section className="first-backup-section" aria-labelledby="backup-title">
          <div className="backup-copy">
            <p className="landing-kicker">Zero knowledge by design</p>
            <h2 id="backup-title">Relay can store your checkpoint. It cannot read it.</h2>
            <p>
              The archive is encrypted before it leaves your workspace. Readable
              file contents, workspace metadata, handoff notes, and the recovery key
              never reach Relay&rsquo;s servers.
            </p>
            <div className="backup-facts">
              <span><Check size={14} /> AES-256-GCM encryption</span>
              <span><Check size={14} /> Secrets excluded before packing</span>
              <span><Check size={14} /> Recovery key stays local</span>
              <span><Check size={14} /> Every restored file is verified</span>
            </div>
          </div>

          <div className="backup-demo" aria-label="Relay checkpoint security example">
            <div className="backup-demo-header">
              <span className="status-dot" />
              Checkpoint protection
              <span>local security pipeline</span>
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
            <p className="landing-kicker">Private by construction</p>
            <h2 id="privacy-title">Your workspace stays yours—even while it travels.</h2>
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
            <p className="landing-kicker">Protect the next handoff</p>
            <h2 id="cta-title">Give your agent a secure place to resume.</h2>
            <p>Install Relay, create a locally encrypted checkpoint, and restore it with cryptographic verification.</p>
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
