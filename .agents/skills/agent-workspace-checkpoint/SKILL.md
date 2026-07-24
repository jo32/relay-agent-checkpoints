---
name: agent-workspace-checkpoint
description: Connect a local agent to Relay; create, publish, and delete private locally encrypted or intentionally public keyless workspace checkpoints without sending decryption secrets to Relay. Use for safe project handoffs, immutable-until-deleted snapshots, public agent workspaces, private-to-public publication, and owner-requested removal.
---

# Agent Workspace Checkpoint

Create a safe archive with an explicit visibility choice. Private checkpoints use either a user-chosen passphrase (recommended/default) or an explicitly requested generated recovery key, and upload only AES-256-GCM ciphertext. User-chosen passphrases are entered and confirmed through hidden local prompts. Generated recovery keys are displayed once in the command output and must be returned directly to the user in the agent's response; they are never saved to a key file. Relay never stores, synchronizes, or receives either secret. Public checkpoints use no decryption secret and upload an intentionally readable canonical archive with an approved public title and description. Publishing an existing private checkpoint decrypts, validates, sanitizes, and re-scans it locally, then uploads only a separate public artifact. Do not restore or execute a checkpoint with this skill; use `$restore-agent-workspace` for that.

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

The default credential cannot publish. Before creating or uploading a public checkpoint, or making a private checkpoint public, verify that status includes `checkpoints:publish`. If it does not, run the same one-time flow with `--publish`:

```bash
python3 scripts/relay_auth.py login --api-url "$RELAY_API_URL" --publish
```

The approval page must explicitly warn that this extra permission can make the user's own checkpoint permanently public. Never request it for a private-only operation.

The default credential also cannot delete. Before deleting a checkpoint, verify that status includes `checkpoints:delete`. If it does not, run the one-time flow with `--delete`:

```bash
python3 scripts/relay_auth.py login --api-url "$RELAY_API_URL" --delete
```

The approval page must explicitly warn that this permission can permanently remove the user's Relay-hosted checkpoint records and stored artifacts. Request it only for a deletion the user asked for. `--publish` and `--delete` may be combined only when both permissions are needed for the current user request.

Never request a Relay access credential, existing passphrase, or existing recovery key in chat. Never place one in command arguments, environment variables, the archive, project files, URLs, or handoff text. The only chat-display exception is a newly generated recovery key after the user explicitly selected generated-key mode; return that new key once in the agent response so the user can save it. `RELAY_API_TOKEN` and `--api-token` remain supported only for explicit backward-compatible automation.

## Create and upload

1. Connect to Relay as described above if the saved credential is unavailable or expired.
2. Identify the project root.
3. Before a non-dry-run creation, ask one short question covering all choices:
   - “Should this checkpoint be private (recommended/default) or intentionally public?”
   - For private: “Use a passphrase you choose in hidden local prompts (recommended/default), or generate a random recovery key that I will display once in my response?”
   - For public: “What public title and one-sentence public description should accompany it?”
   - “May Relay display a name and one-sentence description of what this agent did, or should I use a playful pseudonym with a generic privacy-safe description?”
   Do not ask again for choices the user already provided. Treat private, user-chosen passphrase, and pseudonymous metadata as safe defaults. Public visibility and generated-key mode must always be explicit. For passphrase mode, tell the user that the command will ask them to choose and confirm it in hidden local prompts. Never ask what it is. For generated-key mode, warn that the key will be shown once in the agent response and anyone who can read that response can use it.
4. Summarize the objective, completed work, blockers, validation state, and next steps in a short Markdown handoff. Separately prepare the public agent metadata:
   - For shared metadata, choose a concise agent name and summarize the agent's completed activity in one sentence. Show both to the user before upload. Never include secrets, code, private paths, user identities, private workspace names, or sensitive project details.
   - When the user declines or does not choose, use `--agent-metadata pseudonymous`. Let the script generate a playful name and fixed privacy-safe description; do not ask for another name.
5. Preview the file selection. For a public checkpoint, include the approved
   `--visibility public`, `--public-title`, and `--public-description` options;
   its JSON preview includes the exact public file paths and sanitized manifest
   metadata:

```bash
python3 scripts/create_checkpoint.py \
  --root /absolute/path/to/project \
  --label before-handoff \
  --handoff-file /path/to/handoff.md \
  --dry-run
```

6. Review secret warnings and unusual exclusions. Never weaken mandatory security exclusions merely to include a file.
7. For private passphrase mode, create, encrypt, and upload with `--visibility private`. The command asks the user to choose and confirm a passphrase through hidden local prompts before writing the encrypted archive. Upload uses authenticated 1 MiB chunks and verifies the stored checkpoint through its metadata API:

```bash
python3 scripts/create_checkpoint.py \
  --root /absolute/path/to/project \
  --label before-handoff \
  --handoff-file /path/to/handoff.md \
  --source-agent codex \
  --agent-metadata shared \
  --agent-name "Release Gardener" \
  --agent-description "Hardened checkpoint uploads and documented the verified handoff." \
  --visibility private \
  --upload \
  --json
```

The passphrase may contain any 8 or more characters, including spaces and Unicode; a long, unique passphrase is strongly recommended. It is entered twice only during creation to catch typos. Relay and the skill never store, remember, recover, or synchronize it. Tell the user they must enter the same passphrase on the restore machine. Losing or forgetting it makes the private checkpoint unrecoverable.

For explicitly selected generated-key mode, add `--generate-key`:

```bash
python3 scripts/create_checkpoint.py \
  --root /absolute/path/to/project \
  --label before-handoff \
  --handoff-file /path/to/handoff.md \
  --visibility private \
  --generate-key \
  --upload \
  --json
```

The command generates a strong 43-character recovery key, uses it locally, includes it once in the `recoveryKey` output field, and never writes it to a key file. Return that exact key to the user in the agent response along with the checkpoint ID and a warning to save it now. Do not mask, truncate, reformat, or repeat it. The user enters it through the same hidden restore prompt on another machine. Do not use `--generate-key` unless the user explicitly selected this mode.

If encryption succeeds but upload fails, the command returns a nonzero status with `uploadError` while still including the one-time `recoveryKey`. Return the key and failure status to the user, then retry the existing encrypted archive as described below; do not recreate it.

For pseudonymous metadata, omit `--agent-name` and `--agent-description` and use `--agent-metadata pseudonymous`. The script generates names such as “Quantum Goose” or “Caffeinated Capybara.” Agent metadata is intentionally visible to Relay and share recipients; encrypted workspace metadata remains private. The script stores the exact agent profile in a permission-restricted `.metadata.json` sidecar beside the encrypted archive so a retry does not need to ask again.

If encryption succeeded but upload failed, retry the existing `.relay` file without its encryption key and without recreating the checkpoint:

```bash
python3 scripts/upload_checkpoint.py \
  /absolute/path/to/existing-checkpoint.relay \
  --api-url "$RELAY_API_URL" \
  --json
```

This verifies the archive and sidecar checksum, reads only the public encrypted header, reuses the saved agent profile (or creates a playful pseudonym for an older archive), uploads in chunks, and confirms the stored ID, size, checksum, and agent metadata through Relay's agent API. It must never prompt for or decrypt with the checkpoint secret. Do not open the dashboard to verify the upload.

Return the Relay checkpoint ID, archive checksum, agent name, agent description, metadata mode, included and excluded counts, and the local archive path. In generated-key mode, also return the exact `recoveryKey` once.

The output must be a format-v2 `.relay` file encrypted with AES-256-GCM. Derive its 256-bit cipher key from the passphrase or generated recovery key with scrypt and a fresh random salt stored in the authenticated header. Relay must never receive the decryption secret. Continue to support older format-v2 checkpoints by letting the user type their original 43-character base64url recovery key into the same hidden prompt; do not load it from a file.

## Create a public checkpoint without a key

Public checkpoints require explicit visibility, approved publication metadata, and a credential approved with `checkpoints:publish`. First generate the exact public preview without writing or uploading an artifact:

```bash
python3 scripts/create_checkpoint.py \
  --root /absolute/path/to/project \
  --visibility public \
  --public-title "Reusable release workspace" \
  --public-description "A sanitized workspace for reproducing the release workflow." \
  --agent-metadata pseudonymous \
  --dry-run \
  --json
```

After the user explicitly approves the returned paths and manifest metadata, create and upload:

```bash
python3 scripts/create_checkpoint.py \
  --root /absolute/path/to/project \
  --visibility public \
  --public-title "Reusable release workspace" \
  --public-description "A sanitized workspace for reproducing the release workflow." \
  --agent-metadata pseudonymous \
  --upload \
  --yes \
  --json
```

Public mode must not prompt for, generate, save, or upload a decryption secret, and it rejects `--generate-key`. Before upload, review the exact title, description, file paths, and sanitized manifest metadata that will become readable. Explain that Relay and anyone with the permanent URL can read the artifact and that publication is effectively irreversible. Use `--yes` only after the user explicitly approves that preview; without it, the script prints the same full preview and waits for the user to type `public`.

After Relay durably accepts a public artifact, it automatically adds the
checkpoint to the anonymous public marketplace index. The approved public title,
description, checkpoint ID, and intentionally visible shared or pseudonymous
agent profile become searchable. Relay uses those public fields for marketplace
listing and deterministic recommendations; it must never index private
workspace metadata, original handoffs, Git state, ownership details, source
ciphertext checksums, exclusion paths, or recovery keys. Return the stable
keyless download URL and the marketplace URL reported by Relay.

## Make an existing private checkpoint public

First ensure the credential has `checkpoints:publish` as described above, then use the local publication command:

```bash
python3 scripts/publish_checkpoint.py \
  --checkpoint cp_123 \
  --public-title "Reusable release workspace" \
  --public-description "A sanitized workspace for reproducing the release workflow." \
  --api-url "$RELAY_API_URL" \
  --json
```

The command authenticates the private download, verifies its checksum and encrypted ID, prompts once for the passphrase or recovery key with hidden local input, decrypts in a permission-restricted temporary directory, validates paths and hashes, re-scans for secrets, removes private-only metadata, and builds a canonical public archive containing the approved title and description. It requires explicit confirmation unless `--yes` is used after the user already approved publication. Only public archive bytes and public metadata are uploaded. The decryption secret must never appear in an argument, environment variable, URL, header, request body, log, sidecar, database field, or object metadata.

The separate public artifact is indexed in the same anonymous marketplace only
after the durable publication succeeds.

## Delete an owned checkpoint

Deletion is destructive and applies only to checkpoints owned by the authenticated Relay tenant. Before deleting, identify the exact `cp_` ID and ask one concise question that states:

- whether the checkpoint is private or public;
- that Relay will remove the stored checkpoint, active private share link, registry record, and any public artifact and marketplace listing;
- for a public checkpoint, that its Relay URL will stop working but previously downloaded, cached, mirrored, or otherwise copied content cannot be retracted;

Never infer deletion from a request to clean, hide, unlist, disconnect, log out, or remove a local file. The user must explicitly request deletion of the identified checkpoint. Do not treat deleting a public checkpoint as reversing its prior disclosure.

After confirming that the credential has `checkpoints:delete`, run:

```bash
python3 scripts/delete_checkpoint.py \
  --checkpoint cp_123 \
  --api-url "$RELAY_API_URL" \
  --json
```

The command retrieves the owner-visible metadata first and requires the user to type the exact checkpoint ID. It sends the exact ID again as the authenticated API confirmation. Use `--yes` only when the user has already explicitly confirmed that exact ID after seeing its visibility and the warnings above.

The command never deletes local checkpoint archives or their sidecars. Report whether the remote deletion succeeded, that local archives remain, and the public-copy warning when applicable. Passphrases and generated recovery keys are never saved by Relay's skills, so there is no local Relay key file to delete.

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

For an encrypted archive, the inspector always requests the passphrase or recovery key through one hidden local prompt. It never searches for or accepts a key file.

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

Private manifests record lineage, source agent, Git state, file hashes, exclusions, and a deterministic tree hash inside ciphertext. Public manifests use `formatVersion: 2`, `visibility: "public"`, and a `publication` object containing the approved title and description. The public projection removes private workspace names, raw Git remotes/status, private parent IDs, exclusion paths, and the original private handoff.

## Create a keyless share link

```bash
python3 scripts/create_share.py --checkpoint cp_123
```

The link contains no decryption secret. Tell the recipient the shared passphrase or recovery key through an appropriate private channel; the restore command requests it through a hidden local prompt. Never put the secret in the URL, command arguments, environment variables, or upload it to Relay.
