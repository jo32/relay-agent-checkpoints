---
name: agent-workspace-checkpoint
description: Connect or sign a local agent in to Relay through browser approval, then create, sanitize, locally encrypt, inspect, and upload immutable project checkpoints. Use when connecting an agent to Relay, pausing unfinished work, preserving tracked and untracked workspace state, handing a project to another person or machine, forking work, or publishing a restorable zero-knowledge checkpoint without dependencies, caches, credentials, VCS internals, raw agent runtime data, or temporary files.
---

# Agent Workspace Checkpoint

Create a safe archive, offer to generate a recovery key for the user or let them enter one privately, derive a 256-bit key locally with salted scrypt, encrypt locally, then upload only ciphertext to Relay. Generated recovery keys stay in a protected local file outside the project; user-entered keys are not stored. Neither kind is sent to Relay. Do not restore or execute a checkpoint with this skill; use `$restore-agent-workspace` for that.

## Connect to Relay

Perform authentication through this skill. Never ask the user to run an authentication command or copy an API key.

1. Set the Relay URL supplied by the user or installation prompt.
2. Check the saved local credential:

```bash
export RELAY_API_URL="https://your-relay-site"
python3 scripts/relay_auth.py status --api-url "$RELAY_API_URL"
```

The status command verifies the credential against Relay's authenticated agent API and reports the checkpoint count. Use this API result to confirm connectivity. Do not open the Relay dashboard or any other site after authorization merely to check status.

3. If the credential is missing or expired, start one-time browser authorization yourself:

```bash
python3 scripts/relay_auth.py login --api-url "$RELAY_API_URL"
```

This command opens only the one-time approval page automatically. Do not also open the printed URL with a browser tool or another command. Wait while the user signs in with ChatGPT and approves the short code. If automatic browser launch clearly fails and you need to open the page yourself, stop the login and restart it with `--no-browser`, then open the printed URL exactly once. After approval, the command verifies the credential through `/api/agent/status`; do not open the dashboard or another site. Continue the requested checkpoint operation after API verification succeeds. The skill stores the resulting revocable Relay access credential outside the project in the user's protected configuration directory. Relay stores only the credential hash. This credential authorizes private checkpoint API access; it is not the archive encryption key.

Never request a Relay access credential or encryption key in chat. Never place either secret in the archive, project files, logs, URLs, or handoff text. `RELAY_API_TOKEN` and `--api-token` remain supported only for explicit backward-compatible automation.

## Create and upload

1. Connect to Relay as described above if the saved credential is unavailable or expired.
2. Identify the project root.
3. Before a non-dry-run creation, ask the user: “Would you like me to generate and securely save a recovery key for you (recommended; no terminal input), or would you prefer to enter your own key privately?” Do not ask again if the user already stated a preference. Treat generation as the recommended/default choice.
4. Summarize the objective, completed work, blockers, validation state, and next steps in a short Markdown handoff.
5. Preview the file selection:

```bash
python3 scripts/create_checkpoint.py \
  --root /absolute/path/to/project \
  --label before-handoff \
  --handoff-file /path/to/handoff.md \
  --dry-run
```

6. Review secret warnings and unusual exclusions. Never weaken mandatory security exclusions merely to include a file.
7. If the user chooses generation, create, encrypt, and upload with `--generate-key`. This path is non-interactive and must not open a terminal for key entry. Upload uses authenticated 1 MiB API chunks, avoiding hosting request-size limits, and independently verifies the stored checkpoint through its metadata API:

```bash
python3 scripts/create_checkpoint.py \
  --root /absolute/path/to/project \
  --label before-handoff \
  --handoff-file /path/to/handoff.md \
  --source-agent codex \
  --generate-key \
  --upload \
  --json
```

The generated 43-character recovery key is saved under the protected Relay configuration directory with file mode `0600`. Return the recovery-key file path, but never read or reveal its contents in chat. Tell the user to keep that file private and back it up separately from the checkpoint.

If the user chooses their own key, add `--prompt-key` instead of `--generate-key`. Only this path uses a hidden local prompt, and the user enters the key once—never ask them to repeat it for confirmation. The key may contain any 8 or more characters, including spaces and Unicode; a longer, unique passphrase is strongly recommended. Never request the key in chat or place it in command arguments, environment variables, project files, logs, handoff text, or API requests.

If encryption succeeded but upload failed, retry the existing `.relay` file without its encryption key and without recreating the checkpoint:

```bash
python3 scripts/upload_checkpoint.py \
  /absolute/path/to/existing-checkpoint.relay \
  --api-url "$RELAY_API_URL" \
  --json
```

This verifies the archive and sidecar checksum, reads only the public encrypted header, uploads in chunks, and confirms the stored ID, size, and checksum through Relay's agent API. It must never prompt for or decrypt with the checkpoint key. Do not open the dashboard to verify the upload.

Return the Relay checkpoint ID, archive checksum, included and excluded counts, and the local archive path.

The output must be a format-v2 `.relay` file encrypted with AES-256-GCM. Derive its 256-bit cipher key with scrypt and a fresh random salt stored in the authenticated header. Relay must never receive the recovery key. Generated keys are stored only in the protected local key directory; user-entered keys are never stored, remembered, recovered, or synchronized. Losing both the key and every backup makes the checkpoint unrecoverable. Continue to support restoring older format-v2 checkpoints that used a 43-character base64url key directly.

## File-selection policy

- Always exclude VCS internals, dependency trees, build output, caches, raw agent runtime data, credentials, unsafe links, special files, and detected secrets.
- Preserve Git-tracked regular files unless they match a mandatory security exclusion.
- Honor project and nested `.gitignore` rules for untracked files when Git is available.
- When the root has no `.gitignore`, infer conservative rules from project markers without modifying the project.
- Record the effective inferred policy at `.agent-checkpoint/inferred.gitignore`.
- Write an inferred root `.gitignore` only when the user explicitly requests `--write-gitignore`.
- Create archives outside the project under `~/.agent-checkpoints/<project>/` by default.

Secret detection is defense in depth. Always inspect the inclusion and exclusion summary before upload.

## Inspect before sharing

Verify the sidecar checksum, archive structure, member types, manifest, and file hashes:

```bash
python3 scripts/inspect_checkpoint.py \
  --verify \
  --show-excluded \
  /path/to/checkpoint.relay
```

The inspector automatically uses the locally saved generated key when present, without a terminal prompt. For a separately received recovery-key file, add `--key-file /path/to/cp_123.key`. It prompts privately only when no safe key file is available.

Treat an archive that fails validation as untrusted.

## Output contract

Each checkpoint contains:

```text
.agent-checkpoint/
├── HANDOFF.md
├── README.md
├── inferred.gitignore
└── manifest.json
```

The manifest records lineage, source agent, Git state, included file hashes, exclusion reasons, inferred stacks, and a deterministic tree hash. The adjacent `.sha256` file identifies the encrypted artifact itself. The manifest, handoff, workspace name, Git state, file list, and exclusions are all inside the ciphertext.

## Create a keyless share link

```bash
python3 scripts/create_share.py --checkpoint cp_123
```

The link contains no encryption key. Send the link and the recovery-key file or user-managed key through separate appropriate secure channels. A recipient can pass a protected recovery-key file with `--key-file`; otherwise restore uses the hidden key prompt. Never put the key in the URL or upload it to Relay.
