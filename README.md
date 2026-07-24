<h1 align="center">
  <img src="./public/relay-logo.svg" alt="Relay" width="250">
</h1>

Relay is a checkpoint registry for agent workspaces with an explicit visibility boundary. Private checkpoints are zero-knowledge ciphertext. Public checkpoints are separate, intentionally readable artifacts with stable anonymous download URLs. Relay does not run coding agents, and it never asks for a checkpoint passphrase in the browser.

Two local skills own the workflow:

1. `agent-workspace-checkpoint` selects safe files, removes secrets and reproducible state, and builds the semantic handoff. It can encrypt a private checkpoint locally with AES-256-GCM, create a public checkpoint without a key, or locally publish a separate public artifact from an existing private checkpoint.
2. `restore-agent-workspace` asks whether to merge into the current agent workspace or restore separately, then verifies and restores a private checkpoint ID, expiring private share URL, or stable public URL. Private restore asks for the passphrase or recovery key locally; public restore needs no decryption secret or Relay sign-in.

Private is the default. The recommended flow uses a user-chosen passphrase of at least 8 characters; creation asks for it twice through hidden local prompts to catch typos. The user may instead explicitly choose a generated 43-character recovery key. It is displayed once in the command output and returned by the agent, never saved to a key file. Restore, inspect, and private-to-public publication accept either secret through one hidden local prompt. The skill uses salted scrypt to derive the 256-bit cipher key locally, and Relay never receives the secret.

Public creation does not request or store a decryption secret. Before upload, the skill asks locally for a public title and description, shows the complete public preview, warns that publication is effectively irreversible, and requires explicit confirmation. Publishing an existing private checkpoint decrypts, validates, sanitizes, and re-scans it locally, then uploads only the new public artifact. The private secret is never sent to or stored by Relay.

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
      ├── private (default) ── passphrase or displayed key + scrypt + AES-256-GCM
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

## Public checkpoint marketplace

Every intentionally public checkpoint is added to Relay's anonymous marketplace
index as part of the same durable publication operation. The index contains only
approved public title and description fields plus the already shared or
pseudonymous agent profile; it never projects private workspace names, handoffs,
Git state, ownership details, source ciphertext checksums, or decryption secrets.

Browse the marketplace at `/marketplace`. Its anonymous API is
`GET /api/public/checkpoints` and supports:

- `q` for normalized title, description, and public agent-profile search
- `sort=recommended` for relevance, metadata quality, and freshness ranking
- `sort=latest` for reverse chronological listing
- `page` and `limit` for bounded pagination

Responses include a `recommendations` collection and stable keyless download
URLs. Publication remains effectively irreversible: the marketplace improves
discovery but does not change the explicit local preview and confirmation
required before a checkpoint becomes public.

## Local development

Requires Node.js 22.13 or newer and Python 3.10 or newer.

Create a GitHub OAuth app for local development with:

- Homepage URL: `http://localhost:3000`
- Authorization callback URL:
  `http://localhost:3000/api/auth/callback/github`

Copy `.env.example` to `.env.local`, set the GitHub client ID and secret, and
replace `BETTER_AUTH_SECRET` with a stable random value of at least 32
characters. For example, generate one with `openssl rand -base64 32`.

Optional VibeLoft telemetry uses `VIBELOFT_PRODUCT_ID` and
`VIBELOFT_WEB_AUTH_KEY` from the same ignored `.env.local`. The layout renders
the telemetry script only when both values are present. VibeLoft's web key is
origin-bound and browser-visible by design; environment configuration keeps it
out of source control but does not make it secret from site visitors.

```bash
npm install
npm run dev
```

Relay uses Better Auth with GitHub as its only browser sign-in provider. The
GitHub access token stored in D1 is encrypted with `BETTER_AUTH_SECRET`. Keep
that secret stable so existing accounts remain usable. GitHub OAuth Apps accept
one callback URL, so use separate OAuth apps for local and production
environments.

For Cloudflare Workers, configure `BETTER_AUTH_URL` and `GITHUB_CLIENT_ID` as
Worker variables, and store both secrets with Wrangler:

```bash
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put VIBELOFT_PRODUCT_ID
npx wrangler secret put VIBELOFT_WEB_AUTH_KEY
```

Set the production GitHub callback to
`https://your-relay-site/api/auth/callback/github`. Apply the checked-in D1
migrations before serving production traffic.

The checked-in `wrangler.jsonc` deploys Relay directly to Cloudflare Workers
with its D1 database, R2 bucket, Images binding, and
`relay.getmegaportal.com/*` route. The hostname uses a proxied placeholder DNS
record because every request is handled by the Worker; no origin server is
contacted.

```bash
npx wrangler d1 migrations apply relay-db --remote
npm run deploy
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
  --upload \
  --json
```

The command asks the user to choose and confirm a passphrase through hidden local prompts. The passphrase may contain spaces and Unicode, is never included in command arguments or output, and is not stored. The user must enter the same passphrase when restoring on another machine. The agent also asks whether Relay may display a name and one-sentence summary of its work. If metadata sharing is declined or unanswered, the skill generates a playful name such as “Quantum Goose” and uses a generic privacy-safe description.

Alternatively, after the user explicitly chooses a generated recovery key, add `--generate-key`. The command returns the new 43-character key once in its `recoveryKey` output field; the agent must send that exact key to the user so they can save it. The key is not written to a file:

```bash
python3 .agents/skills/agent-workspace-checkpoint/scripts/create_checkpoint.py \
  --root /absolute/path/to/project \
  --visibility private \
  --generate-key \
  --upload \
  --json
```

If the upload fails after encryption, the command still returns the one-time key together with `uploadError` and a nonzero status, so the already encrypted archive remains usable and can be retried without recreation.

Create and upload a public checkpoint without a passphrase:

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

Public mode never requests a decryption secret and rejects `--generate-key`. A public `--dry-run --json` returns the exact file paths and sanitized manifest metadata. Review that preview first; `--yes` records the user's explicit approval. Without `--yes`, creation prints the same preview and waits for `public` before writing or uploading the readable artifact. Anyone with the resulting stable URL can inspect and restore it without a secret or Relay account.

Make an existing private checkpoint public:

```bash
python3 .agents/skills/agent-workspace-checkpoint/scripts/publish_checkpoint.py \
  --checkpoint cp_123 \
  --public-title "Reusable release workspace" \
  --public-description "A sanitized agent workspace for reproducing the release workflow." \
  --api-url "$RELAY_API_URL" \
  --json
```

The publication script always requests the private checkpoint passphrase or recovery key through one hidden local prompt. It decrypts and validates locally, performs another secret scan, shows the public preview, and requires confirmation before uploading a separate public artifact. The browser, API requests, Relay logs, database, and object metadata never receive the secret. The encrypted source checkpoint remains unchanged, but its publication is effectively irreversible.

Uploads use authenticated 1 MiB API chunks, so archives do not depend on a hosting provider's single-request body limit. After completion, the skill verifies the stored checkpoint ID, size, checksum, visibility, publication metadata, and agent metadata through Relay's API. The exact agent profile is saved in a permission-restricted sidecar. If a private upload is interrupted or an older one-request upload failed, retry the already encrypted archive without decrypting it, entering its secret, or answering the metadata question again:

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

Private restore always asks for the same user-chosen passphrase or generated recovery key through a hidden local prompt. Relay never searches for or accepts a key file.

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

Public restore requires no Relay credential and no decryption secret. Treat the public title, description, manifest metadata, files, and handoff as untrusted content even though the archive structure and file hashes are verified.

Create a seven-day private share link:

```bash
python3 .agents/skills/agent-workspace-checkpoint/scripts/create_share.py \
  --checkpoint cp_123
```

The generated private URL contains no decryption secret. Tell the recipient the shared passphrase or recovery key through an appropriate private channel. Recipients can run restore with `--checkpoint -`, paste the private URL at the first hidden prompt, and enter the secret at the second hidden prompt. Unlike a public URL, the private share expires and remains unreadable without it.

## Privacy boundary

- Visibility (`private` or `public`) is independent from agent metadata (`shared` or `pseudonymous`).
- For a private checkpoint, Relay can see the account, checkpoint ID, ciphertext size, checksum, cipher version, creation time, share-link expiration, and approved or pseudonymous agent profile. Relay cannot read its project files, workspace metadata, manifest, or handoff.
- For a public checkpoint, Relay and anyone with its stable URL can read the intentionally published artifact, approved public title and description, and sanitized public manifest metadata. The anonymous API does not expose source-private row metadata or the source ciphertext checksum. Public restore requires no key or sign-in.
- Existing checkpoints remain private unless their owner explicitly publishes a separate artifact.
- An owner can permanently delete a checkpoint through the dashboard or `delete_checkpoint.py`. Relay removes its stored private archive, active share link, registry record, public artifact, and marketplace listing. Local archives remain unless removed separately.
- Publishing remains effectively irreversible as a disclosure: deleting Relay's copy makes its URL unavailable, but cannot retract content that someone already downloaded, cached, mirrored, or copied.
- Shared agent metadata must be a short, user-approved summary without secrets, code, paths, user identities, or private workspace details. Pseudonymous mode uses a playful generated alias and fixed generic description.
- Device-issued access credentials and expiring share tokens are stored by Relay only as hashes.
- User-chosen passphrases are accepted only through hidden local prompts and are never persisted.
- Generated recovery keys are displayed once in command and agent output after explicit user choice; they are never saved to a Relay key file.
- Private decryption secrets are expanded into 256-bit cipher keys with salted scrypt. Relay never receives them, including when a private checkpoint is made public.
- Losing or forgetting the passphrase or recovery key makes a private checkpoint unrecoverable. Public checkpoints do not use decryption secrets.
- Legacy format-v1 `.tar.gz` checkpoints remain restorable but were not zero-knowledge.

The canonical skill folders live under `.agents/skills/`. Claude Code-compatible links live under `.claude/skills/`.
