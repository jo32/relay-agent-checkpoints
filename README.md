# Relay

Relay is a checkpoint registry for agent workspaces. It does not run coding agents and it does not create archives in the browser.

Two local skills own the workflow:

1. `agent-workspace-checkpoint` selects safe files, infers ignore rules, removes secrets and reproducible state, writes the semantic handoff, creates an immutable `.tar.gz`, hashes it, and uploads it to Relay.
2. `restore-agent-workspace` downloads a private checkpoint ID or expiring share URL, treats the archive as untrusted input, verifies its structure and hashes, and extracts it into a new workspace.

Relay stores encrypted archive bytes, checkpoint metadata, lineage, integrity hashes, and expiring share links.

## Product workflow

```text
Current workspace
      │
      │ $agent-workspace-checkpoint
      ▼
Sanitized immutable archive
      │
      ▼
Relay checkpoint registry
      │
      │ $restore-agent-workspace
      ▼
New verified workspace
```

## Local development

Requires Node.js 22.13 or newer and Python 3.10 or newer.

```bash
npm install
npm run dev
```

Run the complete validation suite with:

```bash
npm test
```

## Configure the skills

Create an API token from **Connect skills** in the Relay dashboard, then set:

```bash
export RELAY_API_URL="https://your-relay-site"
export RELAY_API_TOKEN="rly_..."
```

Create and upload a checkpoint:

```bash
python3 .agents/skills/agent-workspace-checkpoint/scripts/create_checkpoint.py \
  --root /absolute/path/to/project \
  --source-agent codex \
  --label before-handoff \
  --upload \
  --json
```

Download and extract it into a new workspace:

```bash
python3 .agents/skills/restore-agent-workspace/scripts/download_checkpoint.py \
  --checkpoint cp_123 \
  --destination /absolute/path/to/new-workspace \
  --json
```

The canonical skill folders live under `.agents/skills/`. Claude Code-compatible links live under `.claude/skills/`.
