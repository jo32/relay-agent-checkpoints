"use client";

import {
  Archive,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleEllipsis,
  Clock3,
  Cloud,
  Code2,
  Copy,
  Download,
  FileArchive,
  Files,
  FolderArchive,
  GitBranch,
  HardDrive,
  History,
  KeyRound,
  LayoutDashboard,
  Link2,
  Loader2,
  Menu,
  Plus,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  SquareTerminal,
  UploadCloud,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type Checkpoint = {
  id: string;
  workspaceName: string;
  label: string;
  sourceAgent: string;
  status: string;
  createdAt: string;
  sizeBytes: number;
  fileCount: number;
  excludedCount: number;
  parentId: string | null;
  handoff: string;
  checksum: string;
  demo?: boolean;
};

type View = "checkpoints" | "workspaces" | "shared";

const demoCheckpoints: Checkpoint[] = [
  {
    id: "cp_7d2a1f",
    workspaceName: "atlas-web",
    label: "Auth flow ready for handoff",
    sourceAgent: "Claude Code skill",
    status: "ready",
    createdAt: "2026-07-17T16:30:00.000Z",
    sizeBytes: 18_400_000,
    fileCount: 284,
    excludedCount: 14_203,
    parentId: "cp_4a91ce",
    handoff: "Review the passkey flow and run the browser tests.",
    checksum: "sha256:7b26d3f912e",
    demo: true,
  },
  {
    id: "cp_4a91ce",
    workspaceName: "atlas-web",
    label: "Dashboard filters complete",
    sourceAgent: "Codex skill",
    status: "ready",
    createdAt: "2026-07-17T13:00:00.000Z",
    sizeBytes: 17_900_000,
    fileCount: 276,
    excludedCount: 14_181,
    parentId: "cp_10bd81",
    handoff: "Filter state is now reflected in the URL.",
    checksum: "sha256:26f07c44d19",
    demo: true,
  },
  {
    id: "cp_a94f0e",
    workspaceName: "mobile-kit",
    label: "Handoff from MacBook",
    sourceAgent: "Codex skill",
    status: "ready",
    createdAt: "2026-07-16T15:00:00.000Z",
    sizeBytes: 9_600_000,
    fileCount: 193,
    excludedCount: 4_982,
    parentId: null,
    handoff: "Continue the offline sync adapter.",
    checksum: "sha256:18c3ab0f2c7",
    demo: true,
  },
];

export default function RelayDashboard({
  displayName,
  email,
}: {
  displayName: string;
  email: string;
}) {
  const [view, setView] = useState<View>("checkpoints");
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>(demoCheckpoints);
  const [integrationOpen, setIntegrationOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/checkpoints", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (controller.signal.aborted) return;
        const payload = data as { checkpoints?: Checkpoint[] } | null;
        if (payload?.checkpoints?.length) {
          setCheckpoints([...payload.checkpoints, ...demoCheckpoints]);
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const workspaceNames = useMemo(
    () => [...new Set(checkpoints.map((checkpoint) => checkpoint.workspaceName))],
    [checkpoints],
  );
  const filtered = checkpoints.filter((checkpoint) =>
    `${checkpoint.label} ${checkpoint.workspaceName} ${checkpoint.sourceAgent}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );

  return (
    <div className="app-shell">
      <Sidebar
        displayName={displayName}
        email={email}
        view={view}
        onView={setView}
        workspaces={workspaceNames}
        open={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        onConnect={() => setIntegrationOpen(true)}
      />

      <main className="main-shell">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            type="button"
            aria-label="Open navigation"
            onClick={() => setMobileNavOpen(true)}
          >
            <Menu size={20} />
          </button>
          <div className="workspace-switcher">
            <span className="workspace-monogram">A</span>
            <div>
              <strong>Atlas workspace</strong>
              <span>Personal</span>
            </div>
            <ChevronDown size={15} />
          </div>
          <label className="search-field">
            <Search size={17} />
            <span className="sr-only">Search checkpoints</span>
            <input
              aria-label="Search checkpoints"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search checkpoints"
            />
            <kbd>⌘ K</kbd>
          </label>
          <div className="topbar-actions">
            <button className="icon-button" type="button" aria-label="Activity">
              <History size={18} />
            </button>
            <button className="avatar-button" type="button" aria-label="Account menu">
              {initials(displayName)}
            </button>
          </div>
        </header>

        {view === "checkpoints" && (
          <CheckpointView
            checkpoints={filtered}
            onConnect={() => setIntegrationOpen(true)}
            onShare={(checkpoint) => void shareCheckpoint(checkpoint, setToast)}
            onRestore={(checkpoint) => void copyRestorePrompt(checkpoint, setToast)}
          />
        )}
        {view === "workspaces" && (
          <WorkspacesView
            checkpoints={checkpoints}
            onConnect={() => setIntegrationOpen(true)}
          />
        )}
        {view === "shared" && (
          <SharedView
            checkpoints={checkpoints}
            onShare={(checkpoint) => void shareCheckpoint(checkpoint, setToast)}
          />
        )}
      </main>

      {integrationOpen && (
        <SkillIntegrationModal onClose={() => setIntegrationOpen(false)} />
      )}
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} />
          {toast}
        </div>
      )}
    </div>
  );
}

function Sidebar({
  displayName,
  email,
  view,
  onView,
  workspaces,
  open,
  onClose,
  onConnect,
}: {
  displayName: string;
  email: string;
  view: View;
  onView: (view: View) => void;
  workspaces: string[];
  open: boolean;
  onClose: () => void;
  onConnect: () => void;
}) {
  const nav = [
    { id: "checkpoints" as const, label: "Checkpoints", icon: Archive },
    { id: "workspaces" as const, label: "Workspaces", icon: LayoutDashboard },
    { id: "shared" as const, label: "Shared", icon: Users },
  ];
  return (
    <>
      <div className={`sidebar-backdrop ${open ? "visible" : ""}`} onClick={onClose} />
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <span className="brand-name">relay</span>
          <button className="sidebar-close" onClick={onClose} aria-label="Close navigation">
            <X size={19} />
          </button>
        </div>

        <button className="create-sidebar-button" type="button" onClick={onConnect}>
          <SquareTerminal size={17} />
          Connect skills
          <kbd>K</kbd>
        </button>

        <nav className="primary-nav" aria-label="Primary">
          {nav.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className={view === item.id ? "active" : ""}
                onClick={() => {
                  onView(item.id);
                  onClose();
                }}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-section">
          <div className="section-label">
            <span>Recent workspaces</span>
            <Plus size={14} />
          </div>
          {workspaces.slice(0, 3).map((workspace, index) => (
            <button className="workspace-nav" type="button" key={workspace}>
              <span className={`workspace-dot dot-${index + 1}`} />
              <span>{workspace}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-bottom">
          <div className="storage-card">
            <div>
              <Cloud size={16} />
              <span>Storage</span>
              <strong>1.8 GB</strong>
            </div>
            <div className="storage-track"><span /></div>
            <small>18% of 10 GB used</small>
          </div>
          <button className="settings-link" type="button">
            <Settings size={17} />
            Settings
          </button>
          <div className="account-card">
            <span className="account-avatar">{initials(displayName)}</span>
            <div>
              <strong>{displayName}</strong>
              <small>{email}</small>
            </div>
            <CircleEllipsis size={17} />
          </div>
        </div>
      </aside>
    </>
  );
}

function CheckpointView({
  checkpoints,
  onConnect,
  onShare,
  onRestore,
}: {
  checkpoints: Checkpoint[];
  onConnect: () => void;
  onShare: (checkpoint: Checkpoint) => void;
  onRestore: (checkpoint: Checkpoint) => void;
}) {
  const atlas = checkpoints.filter((checkpoint) => checkpoint.workspaceName === "atlas-web");
  const latest = atlas[0] ?? checkpoints[0] ?? demoCheckpoints[0];
  const parent =
    checkpoints.find((checkpoint) => checkpoint.id === latest.parentId) ??
    demoCheckpoints[1];

  return (
    <div className="page-content">
      <section className="page-heading">
        <div>
          <p className="eyebrow">Workspace continuity</p>
          <h1>Your agents create checkpoints. Relay keeps them ready.</h1>
          <p>
            Immutable, sanitized workspace archives that another skill can
            download and restore anywhere.
          </p>
        </div>
        <button className="primary-button" type="button" onClick={onConnect}>
          <SquareTerminal size={18} />
          Connect skills
        </button>
      </section>

      <section className="metric-grid" aria-label="Workspace overview">
        <article>
          <span className="metric-icon peach"><Archive size={19} /></span>
          <div><strong>{checkpoints.length}</strong><span>Checkpoints</span></div>
          <small>+4 this week</small>
        </article>
        <article>
          <span className="metric-icon violet"><Code2 size={19} /></span>
          <div><strong>2</strong><span>Workflow skills</span></div>
          <small>Create + restore</small>
        </article>
        <article>
          <span className="metric-icon green"><ShieldCheck size={19} /></span>
          <div><strong>19.2k</strong><span>Unsafe files skipped</span></div>
          <small>Secrets protected</small>
        </article>
        <article>
          <span className="metric-icon blue"><HardDrive size={19} /></span>
          <div><strong>1.8 GB</strong><span>Stored safely</span></div>
          <small>Immutable archives</small>
        </article>
      </section>

      <section className="lineage-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Current workspace</p>
            <h2>Checkpoint lineage</h2>
          </div>
          <button className="ghost-button" type="button">
            View full history <ArrowRight size={16} />
          </button>
        </div>

        <div className="lineage-card">
          <div className="lineage-top">
            <div>
              <span className="live-pulse" />
              <strong>atlas-web</strong>
              <small>immutable history</small>
            </div>
            <span className="synced-badge"><Check size={13} /> Uploaded by skill</span>
          </div>

          <div className="lineage-canvas">
            <div className="lineage-rail" aria-hidden="true">
              <span className="node node-one" />
              <span className="node node-two" />
              <span className="node node-three" />
            </div>
            <LineageNode checkpoint={parent} className="lineage-parent" onRestore={onRestore} />
            <LineageNode
              checkpoint={latest}
              className="lineage-current"
              onRestore={onRestore}
              current
            />
            <button className="lineage-new" type="button" onClick={onConnect}>
              <span><UploadCloud size={18} /></span>
              <strong>Create from agent</strong>
              <small>Use the checkpoint skill</small>
            </button>
          </div>
        </div>
      </section>

      <section className="recent-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Your work</p>
            <h2>Recent checkpoints</h2>
          </div>
          <div className="table-actions">
            <button className="compact-button" type="button"><Files size={15} /> All workspaces</button>
            <button className="compact-button" type="button"><Clock3 size={15} /> Recent</button>
          </div>
        </div>
        <div className="checkpoint-table">
          <div className="table-header">
            <span>Checkpoint</span>
            <span>Created by</span>
            <span>Files</span>
            <span>Created</span>
            <span aria-hidden="true" />
          </div>
          {checkpoints.length ? (
            checkpoints.slice(0, 7).map((checkpoint) => (
              <CheckpointRow
                key={checkpoint.id}
                checkpoint={checkpoint}
                onShare={onShare}
                onRestore={onRestore}
              />
            ))
          ) : (
            <div className="empty-row">
              <FileArchive size={26} />
              <strong>No checkpoints match your search.</strong>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function LineageNode({
  checkpoint,
  className,
  current,
  onRestore,
}: {
  checkpoint: Checkpoint;
  className: string;
  current?: boolean;
  onRestore: (checkpoint: Checkpoint) => void;
}) {
  return (
    <article className={`lineage-node ${className} ${current ? "current" : ""}`}>
      <div className="source-mark mint"><FolderArchive size={17} /></div>
      <div className="lineage-node-copy">
        <span>{checkpoint.sourceAgent}</span>
        <strong>{checkpoint.label}</strong>
        <small>{relativeTime(checkpoint.createdAt)} · {formatBytes(checkpoint.sizeBytes)}</small>
      </div>
      {current ? (
        <button type="button" onClick={() => onRestore(checkpoint)}>
          Restore <ArrowRight size={14} />
        </button>
      ) : (
        <CheckCircle2 className="node-check" size={18} />
      )}
    </article>
  );
}

function CheckpointRow({
  checkpoint,
  onShare,
  onRestore,
}: {
  checkpoint: Checkpoint;
  onShare: (checkpoint: Checkpoint) => void;
  onRestore: (checkpoint: Checkpoint) => void;
}) {
  return (
    <article className="checkpoint-row">
      <div className="checkpoint-name">
        <span className="archive-icon"><FileArchive size={19} /></span>
        <div>
          <strong>{checkpoint.label}</strong>
          <small><GitBranch size={12} /> {checkpoint.workspaceName} · {checkpoint.id.slice(-6)}</small>
        </div>
      </div>
      <div>
        <span className="source-chip mint"><Code2 size={14} /> {checkpoint.sourceAgent}</span>
      </div>
      <div className="file-count">
        <strong>{checkpoint.fileCount.toLocaleString()}</strong>
        <small>{formatBytes(checkpoint.sizeBytes)}</small>
      </div>
      <time dateTime={checkpoint.createdAt}>{relativeTime(checkpoint.createdAt)}</time>
      <div className="row-actions">
        {!checkpoint.demo && (
          <a
            className="row-icon-button"
            href={`/api/checkpoints/${checkpoint.id}/download`}
            aria-label={`Download ${checkpoint.label}`}
          >
            <Download size={16} />
          </a>
        )}
        <button
          className="row-icon-button"
          type="button"
          onClick={() => onShare(checkpoint)}
          aria-label={`Share ${checkpoint.label}`}
        >
          <Share2 size={16} />
        </button>
        <button className="continue-button" type="button" onClick={() => onRestore(checkpoint)}>
          Restore
        </button>
      </div>
    </article>
  );
}

function WorkspacesView({
  checkpoints,
  onConnect,
}: {
  checkpoints: Checkpoint[];
  onConnect: () => void;
}) {
  const groups = [...new Set(checkpoints.map((checkpoint) => checkpoint.workspaceName))].map(
    (workspace) => {
      const items = checkpoints.filter((checkpoint) => checkpoint.workspaceName === workspace);
      return {
        workspace,
        count: items.length,
        latest: items[0],
        bytes: items.reduce((sum, checkpoint) => sum + checkpoint.sizeBytes, 0),
      };
    },
  );
  return (
    <div className="page-content secondary-view">
      <section className="page-heading">
        <div>
          <p className="eyebrow">Checkpoint registry</p>
          <h1>Every workspace has a durable history.</h1>
          <p>Skills upload immutable versions; Relay keeps lineage, integrity, and access in one place.</p>
        </div>
        <button className="primary-button" onClick={onConnect}>
          <SquareTerminal size={18} /> Connect skills
        </button>
      </section>
      <div className="workspace-grid">
        {groups.map((group, index) => (
          <article key={group.workspace} className="workspace-panel">
            <span className={`source-mark large ${index === 1 ? "mint" : index === 2 ? "blue" : "clay"}`}>
              <FolderArchive size={20} />
            </span>
            <div>
              <small>{relativeTime(group.latest.createdAt)}</small>
              <h3>{group.workspace}</h3>
              <p>{group.count} checkpoints · {formatBytes(group.bytes)}</p>
            </div>
            <button type="button">Open history <ArrowRight size={15} /></button>
          </article>
        ))}
      </div>
      <section className="activity-panel">
        <div className="section-heading">
          <div><p className="eyebrow">Latest uploads</p><h2>Skill activity</h2></div>
        </div>
        {checkpoints.slice(0, 5).map((checkpoint, index) => (
          <div className="activity-row" key={checkpoint.id}>
            <span className={`activity-status ${index === 0 ? "active" : ""}`} />
            <div><strong>{checkpoint.label}</strong><small>{checkpoint.workspaceName}</small></div>
            <span>{checkpoint.sourceAgent}</span>
            <time>{relativeTime(checkpoint.createdAt)}</time>
          </div>
        ))}
      </section>
    </div>
  );
}

function SharedView({
  checkpoints,
  onShare,
}: {
  checkpoints: Checkpoint[];
  onShare: (checkpoint: Checkpoint) => void;
}) {
  return (
    <div className="page-content secondary-view">
      <section className="page-heading">
        <div>
          <p className="eyebrow">Secure collaboration</p>
          <h1>Share a complete handoff, not a vague update.</h1>
          <p>Private links expire after seven days and point to one immutable, verifiable checkpoint.</p>
        </div>
      </section>
      <div className="share-callout">
        <div className="share-visual"><Link2 size={28} /><span /><span /></div>
        <div>
          <span className="safe-label"><ShieldCheck size={14} /> Secrets stay out</span>
          <h2>Send a restorable workspace in one click.</h2>
          <p>The restore skill downloads the archive, rejects unsafe paths, verifies every hash, and extracts into a new workspace.</p>
        </div>
      </div>
      <section className="recent-section">
        <div className="section-heading">
          <div><p className="eyebrow">Ready to send</p><h2>Your checkpoints</h2></div>
        </div>
        <div className="share-list">
          {checkpoints.slice(0, 6).map((checkpoint) => (
            <article key={checkpoint.id}>
              <span className="archive-icon"><FileArchive size={19} /></span>
              <div>
                <strong>{checkpoint.label}</strong>
                <small>{checkpoint.workspaceName} · {relativeTime(checkpoint.createdAt)}</small>
              </div>
              <button type="button" onClick={() => onShare(checkpoint)}>
                <Copy size={15} /> Copy link
              </button>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function SkillIntegrationModal({ onClose }: { onClose: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const origin = typeof window === "undefined" ? "https://your-relay-site" : window.location.origin;

  async function createToken() {
    setCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "Agent checkpoint skills" }),
      });
      const payload = (await response.json()) as { token?: string; error?: string };
      if (!response.ok || !payload.token) {
        throw new Error(payload.error || "Token creation failed.");
      }
      setToken(payload.token);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Token creation failed.");
    } finally {
      setCreating(false);
    }
  }

  async function copy(value: string, label: string) {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1800);
  }

  const environment = token
    ? `export RELAY_API_URL="${origin}"\nexport RELAY_API_TOKEN="${token}"`
    : `export RELAY_API_URL="${origin}"\nexport RELAY_API_TOKEN="<create-a-token-above>"`;
  const createCommand =
    'python3 .agents/skills/agent-workspace-checkpoint/scripts/create_checkpoint.py \\\n  --root "$PWD" \\\n  --label "ready-for-handoff" \\\n  --upload \\\n  --json';
  const restoreCommand =
    "python3 .agents/skills/restore-agent-workspace/scripts/download_checkpoint.py \\\n  --checkpoint cp_EXAMPLE \\\n  --destination ../restored-workspace \\\n  --json";

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="checkpoint-modal skill-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <span className="modal-icon"><SquareTerminal size={20} /></span>
            <div>
              <p className="eyebrow">Local-first workflow</p>
              <h2 id="skill-modal-title">Connect the checkpoint skills</h2>
            </div>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close">
            <X size={19} />
          </button>
        </div>

        <div className="modal-body integration-body">
          <div className="integration-intro">
            <ShieldCheck size={20} />
            <div>
              <strong>Archives are created and restored by skills, not by this website.</strong>
              <p>Relay only stores immutable checkpoint bytes, lineage, and sharing metadata.</p>
            </div>
          </div>

          <section className="token-panel">
            <div>
              <span className="step-number">1</span>
              <div>
                <strong>Create an API token</strong>
                <small>Used by both skills. The full token is shown once.</small>
              </div>
            </div>
            {!token ? (
              <button className="primary-button" type="button" onClick={() => void createToken()} disabled={creating}>
                {creating ? <Loader2 className="spin" size={16} /> : <KeyRound size={16} />}
                {creating ? "Creating…" : "Create token"}
              </button>
            ) : (
              <span className="token-ready"><CheckCircle2 size={15} /> Token ready</span>
            )}
          </section>

          <CodeBlock
            label="Environment"
            value={environment}
            onCopy={() => void copy(environment, "environment")}
            copied={copied === "environment"}
            secret={Boolean(token)}
          />

          <div className="skill-pair">
            <section className="skill-card">
              <span className="step-number">2</span>
              <div className="skill-card-icon create"><UploadCloud size={19} /></div>
              <h3>Create + upload</h3>
              <p>The creation skill infers ignores, removes secrets and caches, writes the handoff, hashes every file, then uploads.</p>
              <CodeBlock
                label="Creation skill"
                value={createCommand}
                onCopy={() => void copy(createCommand, "create")}
                copied={copied === "create"}
                compact
              />
            </section>
            <section className="skill-card">
              <span className="step-number">3</span>
              <div className="skill-card-icon restore"><Download size={19} /></div>
              <h3>Download + restore</h3>
              <p>The restore skill downloads a checkpoint, blocks unsafe archive members, verifies hashes, and extracts into a new workspace.</p>
              <CodeBlock
                label="Restore skill"
                value={restoreCommand}
                onCopy={() => void copy(restoreCommand, "restore")}
                copied={copied === "restore"}
                compact
              />
            </section>
          </div>
          {error && <p className="form-error">{error}</p>}
        </div>

        <div className="modal-footer">
          <div><ShieldCheck size={15} /> Local scan · Encrypted storage · Verified restore</div>
          <button className="primary-button" type="button" onClick={onClose}>Done</button>
        </div>
      </section>
    </div>
  );
}

function CodeBlock({
  label,
  value,
  onCopy,
  copied,
  compact,
  secret,
}: {
  label: string;
  value: string;
  onCopy: () => void;
  copied: boolean;
  compact?: boolean;
  secret?: boolean;
}) {
  return (
    <div className={`code-block ${compact ? "compact" : ""}`}>
      <div>
        <span>{label}</span>
        {secret && <em>Store securely</em>}
        <button type="button" onClick={onCopy}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{value}</pre>
    </div>
  );
}

async function shareCheckpoint(
  checkpoint: Checkpoint,
  setToast: (message: string) => void,
) {
  if (checkpoint.demo) {
    await navigator.clipboard?.writeText(
      `Relay checkpoint: ${checkpoint.label} (${checkpoint.id})`,
    );
    setToast("Demo checkpoint details copied.");
    return;
  }

  try {
    const response = await fetch(`/api/checkpoints/${checkpoint.id}/share`, { method: "POST" });
    const result = (await response.json()) as { error?: string; url?: string };
    if (!response.ok || !result.url) throw new Error(result.error);
    await navigator.clipboard.writeText(result.url);
    setToast("Private 7-day checkpoint link copied.");
  } catch {
    setToast("Share link could not be created.");
  }
}

async function copyRestorePrompt(
  checkpoint: Checkpoint,
  setToast: (message: string) => void,
) {
  const prompt = `Use $restore-agent-workspace to download Relay checkpoint ${checkpoint.id} and extract it into a new workspace.`;
  await navigator.clipboard?.writeText(prompt);
  setToast("Restore-skill prompt copied.");
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function relativeTime(value: string) {
  const elapsed = Date.now() - new Date(value).getTime();
  const minutes = Math.max(1, Math.round(elapsed / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
