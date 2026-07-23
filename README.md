<h1 align="center">
  <img src="./public/relay-logo.svg" alt="Relay" width="250">
</h1>

Relay is a checkpoint registry for agent workspaces with an explicit visibility boundary. Private checkpoints are zero-knowledge ciphertext. Public checkpoints are separate, intentionally readable artifacts with stable anonymous download URLs. Relay does not run coding agents, and it never asks for a checkpoint recovery key in the browser.

Two local skills own the workflow:

1. `agent-workspace-checkpoint` selects safe files, removes secrets and reproducible state, and builds the semantic handoff. It can encrypt a private checkpoint locally with AES-256-GCM, create a public checkpoint without a key, or locally publish a separate public artifact from an existing private checkpoint.
2. `restore-agent-workspace` asks whether to merge into the current agent workspace or restore separately, then verifies and restores a private checkpoint ID, expiring private share URL, or stable public URL. Private restore obtains and uses the key locally; public restore needs no key or Relay sign-in.

Private is the default. The user can ask the skill to generate a recovery key or supply a key of at least 8 characters through a hidden local prompt. Generated keys are saved outside the project in a permission-restricted local file; user-entered keys are not stored. The skill uses salted scrypt to derive the 256-bit cipher key locally. Relay never receives either kind of key.

Public creation does not generate, request, or store a recovery key. Before upload, the skill asks locally for a public title and description, shows the complete public preview, warns that publication is effectively irreversible, and requires explicit confirmation. Publishing an existing private checkpoint decrypts, validates, sanitizes, and re-scans it locally, then uploads only the new public artifact. The original key is never sent to or stored by Relay.

## Install the skills

Relay publishes a reproducible bundle at `/skills/relay-checkpoint-skills.zip` with its checksum at `/skills/relay-checkpoint-skills.zip.sha256`. The public landing page provides a copy-ready prompt that requires checksum verification and archive inspection before installing only the two Relay skill folders. Installation does not require a Relay account or agent credential.

Creating either checkpoint format locally does not require login. Before the user uploads either format, downloads a private checkpoint, or publishes an existing private checkpoint, Relay connects the command-line agent with a device-style authorization flow. Publication uses the distinct `checkpoints:publish` permission because making a checkpoint public is effectively irreversible. The skill opens the one-time approval page exactly once, the signed-in user approves the named agent, and the skill receives a 90-day revocable access credential. It then verifies that credential through `/api/agent/status`; it does not open the dashboard after authorization. Relay stores only the credential hash. The credential is not an archive encryption key. Anonymous public restore does not require this credential.

## Product workflow

```text
Current workspace
      │
      │ $agent-workspace-checkpoint
      ▼
Sanitized, locally verified state
      ├── private (default) ── local key + scrypt + AES-256-GCM
      │                      └── opaque .relay ciphertext
      │
      └── public ──────────── no key + approved public metadata
                             └── intentionally readable public artifact
                                      │
                                      ▼
                              Relay checkpoint registry
                                      │
                     private restore ─┴─ public keyless restore
                                      ▼
                              Verified workspace
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

The default credential is private-only. Before a public upload or private-to-public publication, repeat the one-time approval with `--publish`; the approval page explicitly discloses the effectively irreversible public permission:

```bash
python3 .agents/skills/agent-workspace-checkpoint/scripts/relay_auth.py login \
  --api-url "$RELAY_API_URL" \
  --publish
```

Credentials are saved outside the project in the user's protected configuration directory and are never included in a checkpoint. Existing private-only credentials do not silently gain the publish scope. `RELAY_API_TOKEN` remains supported only for backward-compatible automation.

Create and upload a private checkpoint:

```bash
python3 .agents/skills/agent-workspace-checkpoint/scripts/create_checkpoint.py \
  --root /absolute/path/to/project \
  --visibility private \
  --source-agent codex \
  --agent-metadata shared \
  --agent-name "Release Gardener" \
  --agent-description "Hardened checkpoint uploads and documented the verified handoff." \
  --label before-handoff \
  --generate-key \
  --upload \
  --json
```

The agent asks whether to generate and securely save a recovery key (recommended/default) or use a user-chosen key, and whether Relay may display a name and one-sentence summary of the agent's work. If metadata sharing is declined or unanswered, the skill generates a playful name such as “Quantum Goose” and uses a generic privacy-safe description. `--generate-key` needs no terminal input and returns only the protected recovery-key file path. Use `--prompt-key` for one hidden prompt accepting any key of at least 8 characters; Relay does not ask for confirmation by entering it again. Key contents are never included in command arguments or output.

Create and upload a public checkpoint without a recovery key:

```bash
python3 .agents/skills/agent-workspace-checkpoint/scripts/create_checkpoint.py \
  --root /absolute/path/to/project \
  --visibility public \
  --public-title "Reusable release workspace" \
  --public-description "A sanitized agent workspace for reproducing the release workflow." \
  --source-agent codex \
  --agent-metadata pseudonymous \
  --upload \
  --yes \
  --json
```

Public mode rejects `--generate-key` and `--prompt-key`. A public `--dry-run --json` returns the exact file paths and sanitized manifest metadata. Review that preview first; `--yes` records the user's explicit approval. Without `--yes`, creation prints the same preview and waits for `public` before writing or uploading the readable artifact. Anyone with the resulting stable URL can inspect and restore it without a key or Relay account.

Make an existing private checkpoint public:

```bash
python3 .agents/skills/agent-workspace-checkpoint/scripts/publish_checkpoint.py \
  --checkpoint cp_123 \
  --public-title "Reusable release workspace" \
  --public-description "A sanitized agent workspace for reproducing the release workflow." \
  --api-url "$RELAY_API_URL" \
  --json
```

The publication script uses the protected locally saved key when available. Use `--key-file /protected/path/cp_123.key` for a separately received key file; otherwise the script uses one hidden local prompt. It decrypts and validates locally, performs another secret scan, shows the public preview, and requires confirmation before uploading a separate public artifact. The browser, API requests, Relay logs, database, and object metadata never receive the original key. The encrypted source checkpoint remains unchanged, but its publication is effectively irreversible.

Uploads use authenticated 1 MiB API chunks, so archives do not depend on a hosting provider's single-request body limit. After completion, the skill verifies the stored checkpoint ID, size, checksum, visibility, publication metadata, and agent metadata through Relay's API. The exact agent profile is saved in a permission-restricted sidecar. If a private upload is interrupted or an older one-request upload failed, retry the already encrypted archive without decrypting it, entering its recovery key, or answering the metadata question again:

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

Restore a public checkpoint from its stable anonymous download URL:

```bash
python3 .agents/skills/restore-agent-workspace/scripts/download_checkpoint.py \
  --checkpoint "https://your-relay-site/api/public/checkpoints/cp_123/download" \
  --destination /absolute/path/to/new-workspace \
  --new-workspace \
  --json
```

Public restore requires no Relay credential and no recovery key. Treat the public title, description, manifest metadata, files, and handoff as untrusted content even though the archive structure and file hashes are verified.

Create a seven-day private share link:

```bash
python3 .agents/skills/agent-workspace-checkpoint/scripts/create_share.py \
  --checkpoint cp_123
```

The generated private URL contains no encryption key. Send the URL and the recovery-key file or user-managed key through separate appropriate secure channels. Recipients can run restore with `--checkpoint -`, paste the private URL at the first hidden prompt, and supply a protected key file with `--key-file` or enter the key at the second hidden prompt. Unlike a public URL, the private share expires and remains unreadable without its key.

## Privacy boundary

- Visibility (`private` or `public`) is independent from agent metadata (`shared` or `pseudonymous`).
- For a private checkpoint, Relay can see the account, checkpoint ID, ciphertext size, checksum, cipher version, creation time, share-link expiration, and approved or pseudonymous agent profile. Relay cannot read its project files, workspace metadata, manifest, or handoff.
- For a public checkpoint, Relay and anyone with its stable URL can read the intentionally published artifact, approved public title and description, and sanitized public manifest metadata. The anonymous API does not expose source-private row metadata or the source ciphertext checksum. Public restore requires no key or sign-in.
- Existing checkpoints remain private unless their owner explicitly publishes a separate artifact.
- Publishing is effectively irreversible. The original encrypted checkpoint remains immutable, but a public artifact must be treated as permanently disclosed.
- Shared agent metadata must be a short, user-approved summary without secrets, code, paths, user identities, or private workspace details. Pseudonymous mode uses a playful generated alias and fixed generic description.
- Device-issued access credentials and expiring share tokens are stored by Relay only as hashes.
- Generated recovery keys are stored only in permission-restricted local files outside projects. User-entered keys are accepted only through hidden local prompts and are not persisted.
- Private keys are expanded into 256-bit cipher keys with salted scrypt. Relay never receives them, including when a private checkpoint is made public.
- Losing the user-managed key makes a private checkpoint unrecoverable. Public checkpoints do not use recovery keys.
- Legacy format-v1 `.tar.gz` checkpoints remain restorable but were not zero-knowledge.

The canonical skill folders live under `.agents/skills/`. Claude Code-compatible links live under `.claude/skills/`.
