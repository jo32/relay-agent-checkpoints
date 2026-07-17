---
name: agent-workspace-checkpoint
description: Create, sanitize, inspect, and upload immutable project checkpoints to Relay. Use when pausing unfinished agent work, preserving tracked and untracked workspace state, handing a project to another person or machine, forking work, or publishing a restorable checkpoint without dependencies, caches, credentials, VCS internals, raw agent runtime data, or temporary files.
---

# Agent Workspace Checkpoint

Create a safe local archive, verify its contents, then upload it to Relay. Do not restore or execute a checkpoint with this skill; use `$restore-agent-workspace` for that.

## Configure Relay

Require these environment variables before upload:

```bash
export RELAY_API_URL="https://your-relay-site"
export RELAY_API_TOKEN="rly_..."
```

Treat `RELAY_API_TOKEN` as a secret. Never place it in the archive, project files, logs, or handoff text.

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
5. Create and upload:

```bash
python3 scripts/create_checkpoint.py \
  --root /absolute/path/to/project \
  --label before-handoff \
  --handoff-file /path/to/handoff.md \
  --source-agent codex \
  --upload \
  --json
```

Return the Relay checkpoint ID, archive checksum, included and excluded counts, and the local archive path.

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
  /path/to/checkpoint.tar.gz
```

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

The manifest records lineage, source agent, Git state, included file hashes, exclusion reasons, inferred stacks, and a deterministic tree hash. The adjacent `.sha256` file identifies the archive itself.
