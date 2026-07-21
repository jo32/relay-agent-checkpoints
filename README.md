# Relay

Relay is a zero-knowledge checkpoint registry for agent workspaces. It does not run coding agents and it does not create or decrypt checkpoints in the browser.

Two local skills own the workflow:

1. `agent-workspace-checkpoint` selects safe files, removes secrets and reproducible state, builds the semantic handoff, encrypts the complete archive locally with AES-256-GCM, and uploads only ciphertext.
2. `restore-agent-workspace` downloads a private checkpoint ID or expiring share URL, prompts for the user-managed key, authenticates and decrypts the archive, verifies its structure and hashes, and extracts it into a new workspace.

The user supplies a 256-bit key through a hidden local prompt when creating and restoring a checkpoint. Relay receives neither the key nor readable workspace names, labels, handoffs, manifests, file counts, or lineage. The skills never store, recover, or synchronize the key.

## Install the skills

The Relay dashboard publishes a reproducible bundle at `/skills/relay-checkpoint-skills.zip` with its checksum at `/skills/relay-checkpoint-skills.zip.sha256`. Open **Connect skills**, download the bundle, and copy the provided install prompt to your agent. The prompt requires checksum verification and archive inspection before installing only the two Relay skill folders.

Relay connects a command-line agent with a device-style authorization flow. The skill displays a short one-time code, the signed-in user approves the named agent in Relay, and the skill receives a 90-day revocable access credential. Relay stores only its hash. The credential is not the archive encryption key; the separate user-entered encryption key remains local and is never sent to Relay.

## Product workflow

```text
Current workspace
      │
      │ $agent-workspace-checkpoint
      ▼
Sanitized archive
      │
      │ user-entered key + local AES-256-GCM
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

Set the Relay URL, then connect the local skills with the one-time browser authorization:

```bash
export RELAY_API_URL="https://your-relay-site"
python3 .agents/skills/agent-workspace-checkpoint/scripts/relay_auth.py login \
  --api-url "$RELAY_API_URL"
```

The credential is saved outside the project in the user's protected configuration directory and is never included in a checkpoint. `RELAY_API_TOKEN` remains supported only for backward-compatible automation.

Create and upload a checkpoint:

```bash
python3 .agents/skills/agent-workspace-checkpoint/scripts/create_checkpoint.py \
  --root /absolute/path/to/project \
  --source-agent codex \
  --label before-handoff \
  --upload \
  --json
```

Enter and confirm the same 43-character base64url key at the hidden prompts. The key is not included in command arguments or output.

Download and extract it into a new workspace:

```bash
python3 .agents/skills/restore-agent-workspace/scripts/download_checkpoint.py \
  --checkpoint cp_123 \
  --destination /absolute/path/to/new-workspace \
  --json
```

Enter the checkpoint key at the hidden prompt.

Create a seven-day share link:

```bash
python3 .agents/skills/agent-workspace-checkpoint/scripts/create_share.py \
  --checkpoint cp_123
```

The generated URL contains no encryption key. Send the URL and the user-managed key through separate appropriate channels. Recipients can run restore with `--checkpoint -`, paste the private URL at the first hidden prompt, and enter the key at the second hidden prompt.

## Privacy boundary

- Relay can see the account, checkpoint ID, ciphertext size, checksum, cipher version, creation time, and share-link expiration.
- Relay cannot read project files, workspace metadata, the manifest, or handoff.
- Device-issued access credentials and expiring share tokens are stored by Relay only as hashes.
- Encryption keys are accepted only through hidden local prompts and are not persisted by the skills.
- Losing the user-managed key makes the checkpoint unrecoverable.
- Legacy format-v1 `.tar.gz` checkpoints remain restorable but were not zero-knowledge.

The canonical skill folders live under `.agents/skills/`. Claude Code-compatible links live under `.claude/skills/`.
