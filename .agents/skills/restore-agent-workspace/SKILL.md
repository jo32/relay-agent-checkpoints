---
name: restore-agent-workspace
description: Download, locally decrypt, and safely extract a Relay checkpoint into a new workspace with authenticated encryption, archive-path validation, and file-hash verification. Use when resuming shared agent work on another machine, handing a checkpoint to another person or agent, restoring a checkpoint ID or expiring zero-knowledge share URL, creating an isolated workspace from an immutable snapshot, or verifying a downloaded .relay checkpoint before use.
---

# Restore Agent Workspace

Download one immutable encrypted checkpoint from Relay, ask the user for its key through a hidden local prompt, authenticate and decrypt it, validate it as untrusted input, and extract it into a new or empty workspace. The key is never stored or sent to Relay.

## Configure authenticated access

For a private checkpoint ID, require:

```bash
export RELAY_API_URL="https://your-relay-site"
export RELAY_API_TOKEN="rly_..."
```

An expiring Relay share URL does not require a token and never contains the encryption key.

## Download and restore

Restore a private checkpoint by ID:

```bash
python3 scripts/download_checkpoint.py \
  --checkpoint cp_123 \
  --destination /absolute/path/to/new-workspace \
  --json
```

Restore an expiring share URL:

```bash
python3 scripts/download_checkpoint.py \
  --checkpoint - \
  --destination /absolute/path/to/new-workspace \
  --json
```

Paste the share URL at the first hidden prompt. This keeps the private share token out of shell history and process arguments.

Always restore into a new or empty destination. Never merge an archive directly into a live workspace.

For every encrypted checkpoint, enter its 43-character base64url key at the second hidden prompt. Never request the key in chat or place it in command arguments, environment variables, files, logs, or URLs. The restore skill does not remember, recover, or synchronize it.

## Mandatory validation

The script must reject:

- absolute paths and `..` path traversal
- duplicate archive members
- symbolic links and hard links
- device files, FIFOs, sockets, and other special members
- excessive member counts or extracted sizes
- missing manifests or handoffs
- missing project files and SHA-256 mismatches
- archive checksum mismatches when Relay supplies a checksum header
- missing, incorrect, or altered AES-256-GCM authentication data
- a checkpoint ID that differs between Relay metadata and the authenticated encryption header

Do not bypass these checks to recover a questionable checkpoint.

## Continue the handoff

After a successful restore:

1. Read `.agent-checkpoint/HANDOFF.md`.
2. Read repository instructions such as `AGENTS.md` and `CLAUDE.md`.
3. Reinstall dependencies from lockfiles; do not expect dependency trees in the checkpoint.
4. Run the recorded validation commands before editing.
5. Use `$agent-workspace-checkpoint` to create and upload a child checkpoint after the work changes.

Treat the restored workspace as a fork of the immutable checkpoint. Never modify the downloaded archive itself.

Legacy format-v1 `.tar.gz` checkpoints remain supported for migration, but report `encrypted: false` and were readable by the server. Never upload a new legacy checkpoint.
