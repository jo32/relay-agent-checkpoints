# Relay

Relay is a zero-knowledge checkpoint registry for agent workspaces. It does not run coding agents and it does not create or decrypt checkpoints in the browser.

Two local skills own the workflow:

1. `agent-workspace-checkpoint` selects safe files, removes secrets and reproducible state, builds the semantic handoff, encrypts the complete archive locally with AES-256-GCM, and uploads only ciphertext.
2. `restore-agent-workspace` downloads a private checkpoint ID or expiring share URL, retrieves the key locally, authenticates and decrypts the archive, verifies its structure and hashes, and extracts it into a new workspace.

Each checkpoint has a random 256-bit key. On macOS it is stored in Keychain. On Windows it is stored in Credential Locker. Relay receives neither the key nor readable workspace names, labels, handoffs, manifests, file counts, or lineage.

## Product workflow

```text
Current workspace
      │
      │ $agent-workspace-checkpoint
      ▼
Sanitized archive
      │
      │ local AES-256-GCM + OS credential vault
      │
      ▼
Opaque .relay ciphertext
      │
      ▼
Relay zero-knowledge registry
      │
      │ $restore-agent-workspace
      ▼
Local decrypt → verified workspace
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

Create a seven-day share link:

```bash
python3 .agents/skills/agent-workspace-checkpoint/scripts/create_share.py \
  --checkpoint cp_123
```

The generated URL contains `#relay-key=...`. URL fragments are handled locally and are not sent in HTTP requests. Anyone holding the complete URL can decrypt that checkpoint, so share it through an appropriate private channel.

Recipients should run restore with `--checkpoint -` and paste the complete URL at the hidden prompt, keeping the fragment out of shell history and process arguments.

For CI, testing, or explicit recovery-file operation, both skills accept `--key-file /path/to/relay-keys.json`. The file must be outside the project and mode `600`. The operating-system credential vault is the default.

## Privacy boundary

- Relay can see the account, checkpoint ID, ciphertext size, checksum, cipher version, creation time, and share-link expiration.
- Relay cannot read project files, workspace metadata, the manifest, or handoff.
- API tokens and expiring share tokens are stored only as hashes.
- A compromised local account can use that account's Keychain or Credential Locker access.
- Losing the OS-held key and every complete share URL makes the checkpoint unrecoverable.
- Legacy format-v1 `.tar.gz` checkpoints remain restorable but were not zero-knowledge.

The canonical skill folders live under `.agents/skills/`. Claude Code-compatible links live under `.claude/skills/`.
