---
name: restore-agent-workspace
description: Download a Relay checkpoint and safely extract it into a new workspace with archive-path validation and file-hash verification. Use when resuming shared agent work on another machine, handing a checkpoint to another person or agent, restoring a checkpoint ID or expiring Relay share URL, creating an isolated workspace from an immutable snapshot, or verifying a downloaded .tar.gz checkpoint before use.
---

# Restore Agent Workspace

Download one immutable checkpoint from Relay, validate it as untrusted input, and extract it into a new or empty workspace.

## Configure authenticated access

For a private checkpoint ID, require:

```bash
export RELAY_API_URL="https://your-relay-site"
export RELAY_API_TOKEN="rly_..."
```

An expiring Relay share URL does not require a token.

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
  --checkpoint "https://relay.example/api/shared/..." \
  --destination /absolute/path/to/new-workspace \
  --json
```

Always restore into a new or empty destination. Never merge an archive directly into a live workspace.

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

Do not bypass these checks to recover a questionable checkpoint.

## Continue the handoff

After a successful restore:

1. Read `.agent-checkpoint/HANDOFF.md`.
2. Read repository instructions such as `AGENTS.md` and `CLAUDE.md`.
3. Reinstall dependencies from lockfiles; do not expect dependency trees in the checkpoint.
4. Run the recorded validation commands before editing.
5. Use `$agent-workspace-checkpoint` to create and upload a child checkpoint after the work changes.

Treat the restored workspace as a fork of the immutable checkpoint. Never modify the downloaded archive itself.
