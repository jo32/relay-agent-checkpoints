---
name: agent-workspace-checkpoint
description: Connect a local agent to Relay; create, publish, and delete private encrypted or intentionally public keyless checkpoints for complete agent workspaces or individual reusable skills without sending recovery keys. Use for safe project handoffs, skill sharing, immutable-until-deleted snapshots, public artifacts, private-to-public publication, and owner-requested removal.
---

# Agent Workspace Checkpoint

Create a safe archive of either a complete agent workspace or one reusable skill directory with an explicit visibility choice. Skill checkpoints require a root `SKILL.md` whose name matches the directory and package only that directory. Private checkpoints use a locally generated or privately entered recovery key and upload only AES-256-GCM ciphertext. Public checkpoints use no key and upload an intentionally readable canonical archive with an approved public title and description. Publishing an existing private checkpoint decrypts, validates, sanitizes, and re-scans it locally, then uploads only a separate public artifact. Recovery keys are never sent to Relay. Do not restore or execute a checkpoint with this skill; use `$restore-agent-workspace` for that.

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

Never request a Relay access credential or encryption key in chat. Never place either secret in the archive, project files, logs, URLs, or handoff text. `RELAY_API_TOKEN` and `--api-token` remain supported only for explicit backward-compatible automation.

## Create and upload

1. Connect to Relay as described above if the saved credential is unavailable or expired.
2. Identify whether the user wants the complete agent workspace (default) or one skill. For a skill, identify the exact skill directory, verify that it contains a regular root `SKILL.md`, and use `--artifact-type skill` with that directory as `--root`. Never widen a skill request to the containing project.
3. Before a non-dry-run creation, ask one short question covering all choices:
   - “Should I save the complete agent workspace (recommended/default) or one reusable skill?”
   - “Should this checkpoint be private (recommended/default) or intentionally public?”
   - For private: “Should I generate and securely save a recovery key, or let you enter one privately?”
   - For public: “What public title and one-sentence public description should accompany it?”
   - “May Relay display a name and one-sentence description of what this agent did, or should I use a playful pseudonym with a generic privacy-safe description?”
   Do not ask again for choices the user already provided. Treat private, generated-key, and pseudonymous metadata as safe defaults. Public visibility must always be explicit.
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
7. For private mode, create, encrypt, and upload with `--visibility private` and either `--generate-key` or `--prompt-key`. Upload uses authenticated 1 MiB chunks and verifies the stored checkpoint through its metadata API:

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
  --generate-key \
  --upload \
  --json
```

The generated 43-character recovery key is saved under the protected Relay configuration directory with file mode `0600`. Return the recovery-key file path, but never read or reveal its contents in chat. Tell the user to keep that file private and back it up separately from the checkpoint.

For one skill, point `--root` at the skill directory and add `--artifact-type skill`. The script validates the root `SKILL.md` name and description, requires the directory name to match, records those fields in the authenticated manifest, and saves a protected artifact sidecar so upload retries preserve the type.

If the user chooses their own key, add `--prompt-key` instead of `--generate-key`. Only this path uses a hidden local prompt, and the user enters the key once—never ask them to repeat it for confirmation. The key may contain any 8 or more characters, including spaces and Unicode; a longer, unique passphrase is strongly recommended. Never request the key in chat or place it in command arguments, environment variables, project files, logs, handoff text, or API requests.

For pseudonymous metadata, omit `--agent-name` and `--agent-description` and use `--agent-metadata pseudonymous`. The script generates names such as “Quantum Goose” or “Caffeinated Capybara.” Agent metadata is intentionally visible to Relay and share recipients; encrypted workspace metadata remains private. The script stores the exact agent profile in a permission-restricted `.metadata.json` sidecar beside the encrypted archive so a retry does not need to ask again.

If encryption succeeded but upload failed, retry the existing `.relay` file without its encryption key and without recreating the checkpoint:

```bash
python3 scripts/upload_checkpoint.py \
  /absolute/path/to/existing-checkpoint.relay \
  --api-url "$RELAY_API_URL" \
  --json
```

This verifies the archive and sidecar checksum, reads only the public encrypted header, reuses the saved agent profile (or creates a playful pseudonym for an older archive), uploads in chunks, and confirms the stored ID, size, checksum, and agent metadata through Relay's agent API. It must never prompt for or decrypt with the checkpoint key. Do not open the dashboard to verify the upload.

Return the Relay checkpoint ID, archive checksum, agent name, agent description, metadata mode, included and excluded counts, and the local archive path.

The output must be a format-v2 `.relay` file encrypted with AES-256-GCM. Derive its 256-bit cipher key with scrypt and a fresh random salt stored in the authenticated header. Relay must never receive the recovery key. Generated keys are stored only in the protected local key directory; user-entered keys are never stored, remembered, recovered, or synchronized. Losing both the key and every backup makes the checkpoint unrecoverable. Continue to support restoring older format-v2 checkpoints that used a 43-character base64url key directly.

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

Public mode must not generate, prompt for, save, or upload a recovery key, and it rejects `--generate-key` and `--prompt-key`. Before upload, review the exact title, description, file paths, and sanitized manifest metadata that will become readable. Explain that Relay and anyone with the permanent URL can read the artifact and that publication is effectively irreversible. Use `--yes` only after the user explicitly approves that preview; without it, the script prints the same full preview and waits for the user to type `public`.

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

The command authenticates the private download, verifies its checksum and encrypted ID, loads the protected local key or prompts once with hidden input, decrypts in a permission-restricted temporary directory, validates paths and hashes, re-scans for secrets, removes private-only metadata, and builds a canonical public archive containing the approved title and description. It requires explicit confirmation unless `--yes` is used after the user already approved publication. Only public archive bytes and public metadata are uploaded. The key must never appear in an argument, environment variable, URL, header, request body, log, sidecar, database field, or object metadata.

The separate public artifact is indexed in the same anonymous marketplace only
after the durable publication succeeds.

## Delete an owned checkpoint

Deletion is destructive and applies only to checkpoints owned by the authenticated Relay tenant. Before deleting, identify the exact `cp_` ID and ask one concise question that states:

- whether the checkpoint is private or public;
- that Relay will remove the stored checkpoint, active private share link, registry record, and any public artifact and marketplace listing;
- for a public checkpoint, that its Relay URL will stop working but previously downloaded, cached, mirrored, or otherwise copied content cannot be retracted;
- whether the protected locally saved generated recovery key should also be deleted.

Never infer deletion from a request to clean, hide, unlist, disconnect, log out, or remove a local file. The user must explicitly request deletion of the identified checkpoint. Do not treat deleting a public checkpoint as reversing its prior disclosure.

After confirming that the credential has `checkpoints:delete`, run:

```bash
python3 scripts/delete_checkpoint.py \
  --checkpoint cp_123 \
  --api-url "$RELAY_API_URL" \
  --json
```

The command retrieves the owner-visible metadata first and requires the user to type the exact checkpoint ID. It sends the exact ID again as the authenticated API confirmation. Use `--yes` only when the user has already explicitly confirmed that exact ID after seeing its visibility and the warnings above.

Add `--delete-local-key` only if the user explicitly chose to remove Relay's locally saved generated recovery key too:

```bash
python3 scripts/delete_checkpoint.py \
  --checkpoint cp_123 \
  --api-url "$RELAY_API_URL" \
  --delete-local-key \
  --yes \
  --json
```

Deleting the local key can make any remaining private local archive permanently unrecoverable. The command never deletes local checkpoint archives or their sidecars. Report whether the remote deletion succeeded, whether a local key was requested and removed, that local archives remain, and the public-copy warning when applicable. Never read or reveal the key while deleting it.

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

Private manifests record lineage, source agent, Git state, file hashes, exclusions, and a deterministic tree hash inside ciphertext. Public manifests use `formatVersion: 2`, `visibility: "public"`, and a `publication` object containing the approved title and description. The public projection removes private workspace names, raw Git remotes/status, private parent IDs, exclusion paths, and the original private handoff.

All new manifests also include `artifactType: "agent" | "skill"`. Skill manifests include a `skill` object with the validated `SKILL.md` name and description. Existing manifests without `artifactType` remain agent checkpoints for compatibility.

## Create a keyless share link

```bash
python3 scripts/create_share.py --checkpoint cp_123
```

The link contains no encryption key. Send the link and the recovery-key file or user-managed key through separate appropriate secure channels. A recipient can pass a protected recovery-key file with `--key-file`; otherwise restore uses the hidden key prompt. Never put the key in the URL or upload it to Relay.
