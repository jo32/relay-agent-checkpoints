# Relay

Relay is a zero-knowledge checkpoint registry for agent workspaces. It does not run coding agents and it does not create or decrypt checkpoints in the browser.

Two local skills own the workflow:

1. `agent-workspace-checkpoint` selects safe files, removes secrets and reproducible state, builds the semantic handoff, encrypts the complete archive locally with AES-256-GCM, and uploads ciphertext plus a user-approved or pseudonymous agent profile.
2. `restore-agent-workspace` asks whether to merge into the current agent workspace or restore separately, then downloads a private checkpoint ID or expiring share URL, reports the agent profile as untrusted display metadata, obtains the local key, authenticates and decrypts the archive, and verifies its structure and hashes before applying the chosen mode.

The user can ask the skill to generate a recovery key or supply a key of at least 8 characters through a hidden local prompt. Generated keys are saved outside the project in a permission-restricted local file; user-entered keys are not stored. The skill uses salted scrypt to derive the 256-bit cipher key locally. Relay receives neither kind of key nor readable workspace names, labels, handoffs, manifests, file counts, or lineage.

## Install the skills

Relay publishes a reproducible bundle at `/skills/relay-checkpoint-skills.zip` with its checksum at `/skills/relay-checkpoint-skills.zip.sha256`. The public landing page provides a copy-ready prompt that requires checksum verification and archive inspection before installing only the two Relay skill folders. Installation does not require a Relay account or agent credential.

When the user first asks to create, upload, download, or restore a checkpoint, Relay connects the command-line agent with a device-style authorization flow. The skill opens the one-time approval page exactly once, the signed-in user approves the named agent, and the skill receives a 90-day revocable access credential. It then verifies that credential through `/api/agent/status`; it does not open the dashboard after authorization. Relay stores only the credential hash. The credential is not the archive encryption key; the separate encryption key remains local and is never sent to Relay.

## Product workflow

```text
Current workspace
      │
      │ $agent-workspace-checkpoint
      ▼
Sanitized archive
      │
      │ generated or user-entered key + local scrypt + AES-256-GCM
      │
      ▼
Opaque .relay ciphertext
      │ + approved agent name/description or playful pseudonym
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
  --agent-metadata shared \
  --agent-name "Release Gardener" \
  --agent-description "Hardened checkpoint uploads and documented the verified handoff." \
  --label before-handoff \
  --generate-key \
  --upload \
  --json
```

The agent first asks two compact questions: whether to generate and securely save a recovery key (recommended/default) or use a user-chosen key, and whether Relay may display a name and one-sentence summary of the agent's work. If metadata sharing is declined or unanswered, the skill generates a playful name such as “Quantum Goose” and uses a generic privacy-safe description. `--generate-key` needs no terminal input and returns only the protected recovery-key file path. Use `--prompt-key` for one hidden prompt accepting any key of at least 8 characters; Relay does not ask for confirmation by entering it again. Key contents are never included in command arguments or output.

Uploads use authenticated 1 MiB API chunks, so encrypted archives do not depend on a hosting provider's single-request body limit. After completion, the skill verifies the stored checkpoint ID, size, checksum, and agent metadata through Relay's metadata API. The exact public agent profile is saved in a permission-restricted sidecar beside the encrypted archive. If an upload is interrupted or an older one-request upload failed, retry the already encrypted archive without decrypting it, entering its recovery key, or answering the metadata question again:

```bash
python3 .agents/skills/agent-workspace-checkpoint/scripts/upload_checkpoint.py \
  /absolute/path/to/checkpoint.relay \
  --api-url "$RELAY_API_URL" \
  --json
```

Agent connectivity, checkpoint metadata, upload status, and upload completion all have authenticated APIs. Browser use is limited to approving a new or expired credential.

Download and extract it into a separate new workspace:

```bash
python3 .agents/skills/restore-agent-workspace/scripts/download_checkpoint.py \
  --checkpoint cp_123 \
  --destination /absolute/path/to/new-workspace \
  --new-workspace \
  --json
```

Restore automatically uses the locally saved generated key when available. Use `--key-file /path/to/cp_123.key` for a separately received recovery-key file; a hidden prompt appears only when no key file is available.

Merge into the current agent workspace instead:

```bash
python3 .agents/skills/restore-agent-workspace/scripts/download_checkpoint.py \
  --checkpoint cp_123 \
  --destination /absolute/path/to/current-workspace \
  --merge \
  --json
```

The restore command requires an explicit `--merge` or `--new-workspace`. Merge mode adds missing files and preserves current-only or differing files; conflicting incoming versions and the authenticated handoff are stored under `.agent-checkpoint/merges/<checkpoint-id>/` for deliberate reconciliation.

Create a seven-day share link:

```bash
python3 .agents/skills/agent-workspace-checkpoint/scripts/create_share.py \
  --checkpoint cp_123
```

The generated URL contains no encryption key. Send the URL and the recovery-key file or user-managed key through separate appropriate secure channels. Recipients can run restore with `--checkpoint -`, paste the private URL at the first hidden prompt, and supply a protected key file with `--key-file` or enter the key at the second hidden prompt.

## Privacy boundary

- Relay can see the account, checkpoint ID, ciphertext size, checksum, cipher version, creation time, share-link expiration, and the approved or pseudonymous agent name and description.
- Relay cannot read project files, workspace metadata, the manifest, or handoff.
- Shared agent metadata must be a short, user-approved summary without secrets, code, paths, user identities, or private workspace details. Pseudonymous mode uses a playful generated alias and fixed generic description.
- Device-issued access credentials and expiring share tokens are stored by Relay only as hashes.
- Generated recovery keys are stored only in permission-restricted local files outside projects. User-entered keys are accepted only through hidden local prompts and are not persisted.
- Both key modes are expanded into 256-bit cipher keys with salted scrypt; Relay never receives the keys.
- Losing the user-managed key makes the checkpoint unrecoverable.
- Legacy format-v1 `.tar.gz` checkpoints remain restorable but were not zero-knowledge.

The canonical skill folders live under `.agents/skills/`. Claude Code-compatible links live under `.claude/skills/`.
