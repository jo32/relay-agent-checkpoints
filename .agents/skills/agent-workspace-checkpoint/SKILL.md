---
name: agent-workspace-checkpoint
description: Create, sanitize, locally encrypt, inspect, and upload immutable project checkpoints to Relay. Use when pausing unfinished agent work, preserving tracked and untracked workspace state, handing a project to another person or machine, forking work, or publishing a restorable zero-knowledge checkpoint without dependencies, caches, credentials, VCS internals, raw agent runtime data, or temporary files.
---

# Agent Workspace Checkpoint

Create a safe archive, ask the user for a 256-bit encryption key through a hidden local prompt, encrypt locally, then upload only ciphertext to Relay. The key is never stored by the skill or sent to Relay. Do not restore or execute a checkpoint with this skill; use `$restore-agent-workspace` for that.

## Configure Relay

Set the Relay URL, then connect the local agent with a one-time browser authorization:

```bash
export RELAY_API_URL="https://your-relay-site"
python3 scripts/relay_auth.py login --api-url "$RELAY_API_URL"
```

The command stores the resulting revocable Relay access credential outside the project in the user's protected configuration directory. Relay stores only the credential hash. This credential authorizes private checkpoint API access; it is not the archive encryption key.

Never request a Relay access credential or encryption key in chat. Never place either secret in the archive, project files, logs, URLs, or handoff text. `RELAY_API_TOKEN` and `--api-token` remain supported only for explicit backward-compatible automation.

## Create and upload

1. Identify the project root.
2. Summarize the objective, completed work, blockers, validation state, and next steps in a short Markdown handoff.
3. Preview the file selection:

```bash
python3 scripts/create_checkpoint.py \
  --root /absolute/path/to/project \
  --label before-handoff \
  --handoff-file /path/to/handoff.md \
  --dry-run
```

4. Review secret warnings and unusual exclusions. Never weaken mandatory security exclusions merely to include a file.
5. Create, encrypt, and upload:

```bash
python3 scripts/create_checkpoint.py \
  --root /absolute/path/to/project \
  --label before-handoff \
  --handoff-file /path/to/handoff.md \
  --source-agent codex \
  --upload \
  --json
```

At the hidden prompts, the user must enter and confirm the same 43-character base64url key. Never request the key in chat or place it in command arguments, environment variables, project files, logs, handoff text, or API requests.

Return the Relay checkpoint ID, archive checksum, included and excluded counts, and the local archive path.

The output must be a format-v2 `.relay` file encrypted with AES-256-GCM. The skill does not generate, remember, recover, or synchronize the user-entered key. Relay must never receive the key. Losing the key makes the checkpoint unrecoverable.

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

Enter the checkpoint key at the hidden prompt.

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

The link contains no encryption key. Send the link and the user-managed key through separate appropriate channels. The recipient enters the key at the hidden restore prompt. Never put the key in the URL.
