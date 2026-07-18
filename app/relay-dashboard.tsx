"use client";

import {
  Archive,
  ArrowDownToLine,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Database,
  FileArchive,
  Folder,
  GitBranch,
  HardDrive,
  KeyRound,
  Link2,
  Loader2,
  Menu,
  RefreshCw,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  SquareTerminal,
  UploadCloud,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

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
type LoadStatus = "loading" | "ready" | "error";

const previewCheckpoints: Checkpoint[] = [
  {
    id: "cp_7d2a1f",
    workspaceName: "atlas-web",
    label: "Auth flow ready for handoff",
    sourceAgent: "Claude Code skill",
    status: "ready",
    createdAt: "2026-07-18T08:30:00.000Z",
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
    createdAt: "2026-07-18T05:00:00.000Z",
    sizeBytes: 17_900_000,
    fileCount: 276,
    excludedCount: 14_181,
    parentId: null,
    handoff: "Filter state is reflected in the URL.",
    checksum: "sha256:26f07c44d19",
    demo: true,
  },
  {
    id: "cp_a94f0e",
    workspaceName: "mobile-kit",
    label: "Offline sync adapter",
    sourceAgent: "Codex skill",
    status: "ready",
    createdAt: "2026-07-17T07:00:00.000Z",
    sizeBytes: 9_600_000,
    fileCount: 193,
    excludedCount: 4_982,
    parentId: null,
    handoff: "Continue the conflict-resolution tests.",
    checksum: "sha256:18c3ab0f2c7",
    demo: true,
  },
];

export default function RelayDashboard({
  displayName,
  email,
  isLocalPreview,
}: {
  displayName: string;
  email: string;
  isLocalPreview: boolean;
}) {
  const [view, setView] = useState<View>("checkpoints");
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>(
    isLocalPreview ? previewCheckpoints : [],
  );
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [integrationOpen, setIntegrationOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [workspaceFilter, setWorkspaceFilter] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/checkpoints", {
      signal: controller.signal,
      headers: { accept: "application/json" },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Checkpoint request failed (${response.status})`);
        return (await response.json()) as { checkpoints?: Checkpoint[] };
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        const stored = payload.checkpoints ?? [];
        setCheckpoints(stored.length || !isLocalPreview ? stored : previewCheckpoints);
        setLoadStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.error("Unable to load checkpoints", error);
        setCheckpoints(isLocalPreview ? previewCheckpoints : []);
        setLoadStatus("error");
      });

    return () => controller.abort();
  }, [isLocalPreview, reloadKey]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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

  const visibleCheckpoints = useMemo(() => {
    const query = search.trim().toLowerCase();
    return checkpoints.filter((checkpoint) => {
      const matchesWorkspace =
        !workspaceFilter || checkpoint.workspaceName === workspaceFilter;
      const matchesSearch =
        !query ||
        `${checkpoint.label} ${checkpoint.workspaceName} ${checkpoint.sourceAgent} ${checkpoint.id}`
          .toLowerCase()
          .includes(query);
      return matchesWorkspace && matchesSearch;
    });
  }, [checkpoints, search, workspaceFilter]);

  function selectView(nextView: View) {
    setView(nextView);
    setMobileNavOpen(false);
  }

  function openWorkspace(workspace: string) {
    setWorkspaceFilter(workspace);
    setView("checkpoints");
    setMobileNavOpen(false);
  }

  return (
    <div className="relay-shell">
      <GlobalHeader
        displayName={displayName}
        search={search}
        searchRef={searchRef}
        onSearch={setSearch}
        onOpenNav={() => setMobileNavOpen(true)}
      />

      <div className="relay-body">
        <Sidebar
          email={email}
          view={view}
          workspaceNames={workspaceNames}
          activeWorkspace={workspaceFilter}
          storageOnline={loadStatus !== "error"}
          open={mobileNavOpen}
          onClose={() => setMobileNavOpen(false)}
          onView={selectView}
          onWorkspace={openWorkspace}
          onConnect={() => setIntegrationOpen(true)}
        />

        <main className="relay-main">
          {loadStatus === "error" && (
            <div className="system-banner error" role="alert">
              <span>
                <strong>Checkpoint storage is unavailable.</strong>
                The interface is still usable, but saved data could not be loaded.
              </span>
              <button
                type="button"
                onClick={() => {
                  setLoadStatus("loading");
                  setReloadKey((value) => value + 1);
                }}
              >
                <RefreshCw size={14} />
                Retry
              </button>
            </div>
          )}

          {isLocalPreview && checkpoints.some((checkpoint) => checkpoint.demo) && (
            <div className="system-banner preview" role="status">
              <span>
                <strong>Local preview</strong>
                Example checkpoints are shown only because this workspace has no stored data.
              </span>
            </div>
          )}

          {view === "checkpoints" && (
            <CheckpointsView
              checkpoints={visibleCheckpoints}
              allCheckpoints={checkpoints}
              loading={loadStatus === "loading"}
              workspaceFilter={workspaceFilter}
              onClearWorkspace={() => setWorkspaceFilter(null)}
              onConnect={() => setIntegrationOpen(true)}
              onShare={(checkpoint) => void shareCheckpoint(checkpoint, setToast)}
              onRestore={(checkpoint) => void copyRestorePrompt(checkpoint, setToast)}
            />
          )}

          {view === "workspaces" && (
            <WorkspacesView checkpoints={checkpoints} onOpenWorkspace={openWorkspace} />
          )}

          {view === "shared" && (
            <SharedView
              checkpoints={checkpoints}
              onShare={(checkpoint) => void shareCheckpoint(checkpoint, setToast)}
            />
          )}
        </main>
      </div>

      {integrationOpen && (
        <SkillIntegrationModal onClose={() => setIntegrationOpen(false)} />
      )}

      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={16} />
          {toast}
        </div>
      )}
    </div>
  );
}

function GlobalHeader({
  displayName,
  search,
  searchRef,
  onSearch,
  onOpenNav,
}: {
  displayName: string;
  search: string;
  searchRef: React.RefObject<HTMLInputElement | null>;
  onSearch: (value: string) => void;
  onOpenNav: () => void;
}) {
  return (
    <header className="global-header">
      <div className="brand-cluster">
        <button
          className="mobile-nav-trigger"
          type="button"
          aria-label="Open navigation"
          onClick={onOpenNav}
        >
          <Menu size={18} />
        </button>
        <Link className="relay-brand" href="/" aria-label="Relay home">
          <span className="relay-triangle" aria-hidden="true" />
          <strong>Relay</strong>
        </Link>
        <span className="header-divider" />
        <span className="team-switcher">
          Personal
          <ChevronDown size={14} />
        </span>
      </div>

      <label className="command-search">
        <Search size={15} />
        <span className="sr-only">Search checkpoints</span>
        <input
          ref={searchRef}
          aria-label="Search checkpoints"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search checkpoints…"
        />
        <kbd>⌘ K</kbd>
      </label>

      <div className="header-account">
        <span>Secure workspace registry</span>
        <span className="avatar">{initials(displayName)}</span>
      </div>
    </header>
  );
}

function Sidebar({
  email,
  view,
  workspaceNames,
  activeWorkspace,
  storageOnline,
  open,
  onClose,
  onView,
  onWorkspace,
  onConnect,
}: {
  email: string;
  view: View;
  workspaceNames: string[];
  activeWorkspace: string | null;
  storageOnline: boolean;
  open: boolean;
  onClose: () => void;
  onView: (view: View) => void;
  onWorkspace: (workspace: string) => void;
  onConnect: () => void;
}) {
  const navigation = [
    { id: "checkpoints" as const, label: "Checkpoints", icon: Archive },
    { id: "workspaces" as const, label: "Workspaces", icon: Folder },
    { id: "shared" as const, label: "Shared links", icon: Users },
  ];

  return (
    <>
      <button
        className={`nav-backdrop ${open ? "visible" : ""}`}
        type="button"
        aria-label="Close navigation"
        onClick={onClose}
      />
      <aside className={`side-navigation ${open ? "open" : ""}`}>
        <div className="mobile-nav-heading">
          <strong>Navigation</strong>
          <button type="button" onClick={onClose} aria-label="Close navigation">
            <X size={18} />
          </button>
        </div>

        <button className="connect-button" type="button" onClick={onConnect}>
          <PlusIcon />
          Connect skills
        </button>

        <nav aria-label="Primary">
          <p className="nav-label">Manage</p>
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={view === item.id ? "active" : ""}
                type="button"
                onClick={() => onView(item.id)}
              >
                <Icon size={16} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {workspaceNames.length > 0 && (
          <div className="workspace-navigation">
            <p className="nav-label">Workspaces</p>
            {workspaceNames.slice(0, 5).map((workspace) => (
              <button
                className={activeWorkspace === workspace ? "active" : ""}
                type="button"
                key={workspace}
                onClick={() => onWorkspace(workspace)}
              >
                <span className="workspace-glyph">
                  {workspace.slice(0, 1).toUpperCase()}
                </span>
                <span>{workspace}</span>
              </button>
            ))}
          </div>
        )}

        <div className="sidebar-footer">
          <div className={`connection-status ${storageOnline ? "" : "offline"}`}>
            <span className="status-dot" />
            <div>
              <strong>{storageOnline ? "Storage connected" : "Storage unavailable"}</strong>
              <small>{storageOnline ? "D1 metadata · R2 archives" : "Retry from the status banner"}</small>
            </div>
          </div>
          <div className="account-email">
            <Settings size={15} />
            <span>{email}</span>
          </div>
        </div>
      </aside>
    </>
  );
}

function CheckpointsView({
  checkpoints,
  allCheckpoints,
  loading,
  workspaceFilter,
  onClearWorkspace,
  onConnect,
  onShare,
  onRestore,
}: {
  checkpoints: Checkpoint[];
  allCheckpoints: Checkpoint[];
  loading: boolean;
  workspaceFilter: string | null;
  onClearWorkspace: () => void;
  onConnect: () => void;
  onShare: (checkpoint: Checkpoint) => void;
  onRestore: (checkpoint: Checkpoint) => void;
}) {
  const workspaceCount = new Set(allCheckpoints.map((item) => item.workspaceName)).size;
  const totalBytes = allCheckpoints.reduce((sum, item) => sum + item.sizeBytes, 0);
  const protectedFiles = allCheckpoints.reduce((sum, item) => sum + item.excludedCount, 0);
  const latest = checkpoints[0] ?? allCheckpoints[0] ?? null;

  return (
    <div className="view-container">
      <PageHeading
        eyebrow="Workspace continuity"
        title={workspaceFilter ?? "Checkpoints"}
        description={
          workspaceFilter
            ? `Immutable history for ${workspaceFilter}.`
            : "Immutable workspace archives created by skills and ready to restore anywhere."
        }
        action={
          <button className="button primary" type="button" onClick={onConnect}>
            <PlusIcon />
            Connect skills
          </button>
        }
      />

      <section className="stat-grid" aria-label="Workspace overview">
        <Stat label="Checkpoints" value={String(allCheckpoints.length)} icon={Archive} />
        <Stat label="Workspaces" value={String(workspaceCount)} icon={Folder} />
        <Stat label="Archive storage" value={formatBytes(totalBytes)} icon={HardDrive} />
        <Stat label="Files excluded" value={formatNumber(protectedFiles)} icon={ShieldCheck} />
      </section>

      {latest && (
        <section className="latest-panel">
          <div className="panel-heading">
            <div>
              <span className="status-dot" />
              <span>Latest checkpoint</span>
            </div>
            <span className="mono">{formatDate(latest.createdAt)}</span>
          </div>
          <div className="latest-grid">
            <div className="latest-primary">
              <span className="entity-icon"><FileArchive size={18} /></span>
              <div>
                <span className="badge success">Ready</span>
                <h2>{latest.label}</h2>
                <p>{latest.handoff || "No handoff note was provided."}</p>
              </div>
            </div>
            <dl className="latest-meta">
              <div><dt>Workspace</dt><dd>{latest.workspaceName}</dd></div>
              <div><dt>Created by</dt><dd>{latest.sourceAgent}</dd></div>
              <div><dt>Checkpoint</dt><dd className="mono">{latest.id}</dd></div>
              <div><dt>Integrity</dt><dd className="mono">{shortChecksum(latest.checksum)}</dd></div>
            </dl>
            <div className="latest-actions">
              <button className="button secondary" type="button" onClick={() => onRestore(latest)}>
                <ArrowDownToLine size={15} />
                Restore
              </button>
              <button className="icon-control" type="button" aria-label={`Share ${latest.label}`} onClick={() => onShare(latest)}>
                <Share2 size={15} />
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="registry-section">
        <div className="section-title-row">
          <div>
            <h2>Checkpoint registry</h2>
            <p>Every archive is immutable and addressed by checksum.</p>
          </div>
          {workspaceFilter && (
            <button className="filter-pill" type="button" onClick={onClearWorkspace}>
              {workspaceFilter}
              <X size={13} />
            </button>
          )}
        </div>

        <div className="data-table">
          <div className="data-table-header">
            <span>Checkpoint</span>
            <span>Source</span>
            <span>Contents</span>
            <span>Created</span>
            <span />
          </div>
          {loading && allCheckpoints.length === 0 ? (
            <TableLoading />
          ) : checkpoints.length > 0 ? (
            checkpoints.map((checkpoint) => (
              <CheckpointRow
                key={checkpoint.id}
                checkpoint={checkpoint}
                onShare={onShare}
                onRestore={onRestore}
              />
            ))
          ) : (
            <EmptyState
              title={allCheckpoints.length ? "No checkpoints match this filter" : "No checkpoints yet"}
              description={
                allCheckpoints.length
                  ? "Clear the workspace filter or try another search."
                  : "Connect the creation skill to upload your first immutable workspace archive."
              }
              onConnect={allCheckpoints.length ? undefined : onConnect}
            />
          )}
        </div>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: typeof Archive;
}) {
  return (
    <article className="stat">
      <div>
        <span>{label}</span>
        <Icon size={15} />
      </div>
      <strong>{value}</strong>
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
    <article className="data-row">
      <div className="entity-cell">
        <span className="entity-icon"><FileArchive size={17} /></span>
        <div>
          <strong>{checkpoint.label}</strong>
          <span className="mono"><GitBranch size={11} /> {checkpoint.id}</span>
        </div>
      </div>
      <div>
        <span className="source-badge"><SquareTerminal size={12} /> {checkpoint.sourceAgent}</span>
      </div>
      <div className="contents-cell">
        <strong>{formatNumber(checkpoint.fileCount)} files</strong>
        <span>{formatBytes(checkpoint.sizeBytes)}</span>
      </div>
      <time dateTime={checkpoint.createdAt}>{formatDate(checkpoint.createdAt)}</time>
      <div className="row-controls">
        {!checkpoint.demo && (
          <a
            className="icon-control"
            href={`/api/checkpoints/${checkpoint.id}/download`}
            aria-label={`Download ${checkpoint.label}`}
          >
            <ArrowDownToLine size={15} />
          </a>
        )}
        <button
          className="icon-control"
          type="button"
          aria-label={`Share ${checkpoint.label}`}
          onClick={() => onShare(checkpoint)}
        >
          <Share2 size={15} />
        </button>
        <button className="button row-button" type="button" onClick={() => onRestore(checkpoint)}>
          Restore
        </button>
      </div>
    </article>
  );
}

function WorkspacesView({
  checkpoints,
  onOpenWorkspace,
}: {
  checkpoints: Checkpoint[];
  onOpenWorkspace: (workspace: string) => void;
}) {
  const groups = useMemo(
    () =>
      [...new Set(checkpoints.map((checkpoint) => checkpoint.workspaceName))].map(
        (workspace) => {
          const items = checkpoints.filter(
            (checkpoint) => checkpoint.workspaceName === workspace,
          );
          return {
            workspace,
            items,
            latest: items[0],
            bytes: items.reduce((sum, checkpoint) => sum + checkpoint.sizeBytes, 0),
            files: items.reduce((sum, checkpoint) => sum + checkpoint.fileCount, 0),
          };
        },
      ),
    [checkpoints],
  );

  return (
    <div className="view-container">
      <PageHeading
        eyebrow="Registry"
        title="Workspaces"
        description="Each workspace keeps a linear, immutable history of skill-created checkpoints."
      />

      <section className="workspace-list">
        <div className="workspace-list-header">
          <span>Workspace</span>
          <span>Checkpoints</span>
          <span>Files</span>
          <span>Storage</span>
          <span>Latest</span>
          <span />
        </div>
        {groups.length ? (
          groups.map((group) => (
            <article className="workspace-row" key={group.workspace}>
              <div className="entity-cell">
                <span className="workspace-glyph large">
                  {group.workspace.slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <strong>{group.workspace}</strong>
                  <span className="mono">{shortChecksum(group.latest.checksum)}</span>
                </div>
              </div>
              <strong>{group.items.length}</strong>
              <span>{formatNumber(group.files)}</span>
              <span>{formatBytes(group.bytes)}</span>
              <time dateTime={group.latest.createdAt}>{formatDate(group.latest.createdAt)}</time>
              <button className="button row-button" type="button" onClick={() => onOpenWorkspace(group.workspace)}>
                Open
                <ArrowRight size={14} />
              </button>
            </article>
          ))
        ) : (
          <EmptyState
            title="No workspaces yet"
            description="A workspace appears after its first checkpoint is uploaded."
          />
        )}
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
    <div className="view-container">
      <PageHeading
        eyebrow="Collaboration"
        title="Shared links"
        description="Create an expiring link to one immutable checkpoint. Links expire after seven days."
      />

      <section className="security-note">
        <div className="security-icon"><ShieldCheck size={20} /></div>
        <div>
          <h2>Share the artifact, not your secrets.</h2>
          <p>
            The creation skill removes ignored and sensitive files before upload.
            The restore skill verifies hashes and rejects unsafe archive paths.
          </p>
        </div>
        <div className="security-facts">
          <span><Check size={13} /> Expiring URL</span>
          <span><Check size={13} /> Immutable bytes</span>
          <span><Check size={13} /> Verified restore</span>
        </div>
      </section>

      <section className="registry-section">
        <div className="section-title-row">
          <div>
            <h2>Ready to share</h2>
            <p>Generate a new link when you need to hand off a checkpoint.</p>
          </div>
        </div>
        <div className="share-table">
          {checkpoints.length ? (
            checkpoints.map((checkpoint) => (
              <article key={checkpoint.id}>
                <div className="entity-cell">
                  <span className="entity-icon"><Link2 size={16} /></span>
                  <div>
                    <strong>{checkpoint.label}</strong>
                    <span>{checkpoint.workspaceName} · {formatDate(checkpoint.createdAt)}</span>
                  </div>
                </div>
                <span className="mono">{checkpoint.id}</span>
                <button className="button secondary" type="button" onClick={() => onShare(checkpoint)}>
                  <Copy size={14} />
                  Copy link
                </button>
              </article>
            ))
          ) : (
            <EmptyState
              title="Nothing to share yet"
              description="Upload a checkpoint before creating a share link."
            />
          )}
        </div>
      </section>
    </div>
  );
}

function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </header>
  );
}

function EmptyState({
  title,
  description,
  onConnect,
}: {
  title: string;
  description: string;
  onConnect?: () => void;
}) {
  return (
    <div className="empty-state">
      <span><Archive size={20} /></span>
      <h3>{title}</h3>
      <p>{description}</p>
      {onConnect && (
        <button className="button secondary" type="button" onClick={onConnect}>
          Connect skills
        </button>
      )}
    </div>
  );
}

function TableLoading() {
  return (
    <div className="table-loading" aria-label="Loading checkpoints">
      {[0, 1, 2].map((item) => <span key={item} />)}
    </div>
  );
}

function SkillIntegrationModal({ onClose }: { onClose: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const origin =
    typeof window === "undefined" ? "https://your-relay-site" : window.location.origin;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

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
    try {
      await copyText(value);
      setCopied(label);
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      setError("Clipboard access is unavailable. Select and copy the text manually.");
    }
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
        className="integration-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="integration-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <span className="modal-symbol"><SquareTerminal size={18} /></span>
            <div>
              <p className="eyebrow">Skill API</p>
              <h2 id="integration-title">Connect checkpoint skills</h2>
            </div>
          </div>
          <button ref={closeRef} className="icon-control" type="button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="modal-content">
          <div className="modal-note">
            <Database size={17} />
            <p>
              Relay stores archives in R2 and metadata in D1. Creation and restore
              stay inside the two workspace skills.
            </p>
          </div>

          <section className="setup-step">
            <div className="step-heading">
              <span>1</span>
              <div>
                <h3>Create an API token</h3>
                <p>The full token is displayed once and stored only as a hash.</p>
              </div>
              {!token ? (
                <button className="button primary" type="button" onClick={() => void createToken()} disabled={creating}>
                  {creating ? <Loader2 className="spin" size={14} /> : <KeyRound size={14} />}
                  {creating ? "Creating…" : "Create token"}
                </button>
              ) : (
                <span className="badge success"><Check size={12} /> Token ready</span>
              )}
            </div>
            <CodeBlock
              label="Environment"
              value={environment}
              onCopy={() => void copy(environment, "environment")}
              copied={copied === "environment"}
            />
          </section>

          <div className="setup-grid">
            <section className="setup-step">
              <div className="step-heading compact">
                <span>2</span>
                <div>
                  <h3>Create and upload</h3>
                  <p>Sanitize, hash, archive, then upload.</p>
                </div>
                <UploadCloud size={17} />
              </div>
              <CodeBlock
                label="Creation skill"
                value={createCommand}
                onCopy={() => void copy(createCommand, "create")}
                copied={copied === "create"}
              />
            </section>
            <section className="setup-step">
              <div className="step-heading compact">
                <span>3</span>
                <div>
                  <h3>Download and restore</h3>
                  <p>Verify and extract into a new workspace.</p>
                </div>
                <ArrowDownToLine size={17} />
              </div>
              <CodeBlock
                label="Restore skill"
                value={restoreCommand}
                onCopy={() => void copy(restoreCommand, "restore")}
                copied={copied === "restore"}
              />
            </section>
          </div>

          {error && <p className="form-error" role="alert">{error}</p>}
        </div>

        <footer className="modal-footer">
          <span><ShieldCheck size={14} /> Sanitized · Immutable · Verified</span>
          <button className="button primary" type="button" onClick={onClose}>Done</button>
        </footer>
      </section>
    </div>
  );
}

function CodeBlock({
  label,
  value,
  onCopy,
  copied,
}: {
  label: string;
  value: string;
  onCopy: () => void;
  copied: boolean;
}) {
  return (
    <div className="code-block">
      <div>
        <span>{label}</span>
        <button type="button" onClick={onCopy}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{value}</pre>
    </div>
  );
}

function PlusIcon() {
  return (
    <span className="plus-icon" aria-hidden="true">
      <span />
      <span />
    </span>
  );
}

async function shareCheckpoint(
  checkpoint: Checkpoint,
  setToast: (message: string) => void,
) {
  if (checkpoint.demo) {
    try {
      await copyText(`Relay preview checkpoint: ${checkpoint.label} (${checkpoint.id})`);
      setToast("Preview checkpoint details copied.");
    } catch {
      setToast("Clipboard access is unavailable.");
    }
    return;
  }

  try {
    const response = await fetch(`/api/checkpoints/${checkpoint.id}/share`, {
      method: "POST",
    });
    const result = (await response.json()) as { error?: string; url?: string };
    if (!response.ok || !result.url) {
      throw new Error(result.error || "Share link creation failed.");
    }
    await copyText(result.url);
    setToast("Private seven-day link copied.");
  } catch {
    setToast("Share link could not be created.");
  }
}

async function copyRestorePrompt(
  checkpoint: Checkpoint,
  setToast: (message: string) => void,
) {
  try {
    await copyText(
      `Use $restore-agent-workspace to download Relay checkpoint ${checkpoint.id} and extract it into a new workspace.`,
    );
    setToast("Restore-skill prompt copied.");
  } catch {
    setToast("Clipboard access is unavailable.");
  }
}

async function copyText(value: string) {
  if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
  await navigator.clipboard.writeText(value);
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US", {
    notation: value > 99_999 ? "compact" : "standard",
  }).format(value);
}

function formatBytes(bytes: number) {
  if (bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function shortChecksum(value: string) {
  return value.length > 22 ? `${value.slice(0, 19)}…` : value;
}
