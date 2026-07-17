import { env } from "cloudflare:workers";

export type CheckpointRecord = {
  id: string;
  ownerKey: string;
  workspaceName: string;
  label: string;
  sourceAgent: string;
  status: string;
  createdAt: string;
  sizeBytes: number;
  fileCount: number;
  excludedCount: number;
  parentId: string | null;
  handoff: string;
  objectKey: string;
  checksum: string;
  shareToken?: string | null;
  shareExpiresAt?: string | null;
};

type RuntimeEnv = {
  DB: D1Database;
  CHECKPOINTS: R2Bucket;
};

export function getRuntimeEnv(): RuntimeEnv {
  const runtime = env as unknown as Partial<RuntimeEnv>;
  if (!runtime.DB || !runtime.CHECKPOINTS) {
    throw new Error("Checkpoint storage is unavailable.");
  }
  return runtime as RuntimeEnv;
}

export async function ensureCheckpointSchema(db: D1Database) {
  await db.batch([
    db
      .prepare(
        `CREATE TABLE IF NOT EXISTS checkpoints (
          id TEXT PRIMARY KEY,
          owner_key TEXT NOT NULL,
          workspace_name TEXT NOT NULL,
          label TEXT NOT NULL,
          source_agent TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'ready',
          created_at TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          file_count INTEGER NOT NULL,
          excluded_count INTEGER NOT NULL,
          parent_id TEXT,
          handoff TEXT NOT NULL DEFAULT '',
          object_key TEXT NOT NULL,
          checksum TEXT NOT NULL,
          share_token TEXT,
          share_expires_at TEXT
        )`,
      ),
    db
      .prepare(
        "CREATE INDEX IF NOT EXISTS checkpoints_owner_created_idx ON checkpoints(owner_key, created_at DESC)",
      ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS api_tokens (
        token_hash TEXT PRIMARY KEY,
        token_prefix TEXT NOT NULL,
        owner_key TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      )`,
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS api_tokens_owner_idx ON api_tokens(owner_key)",
    ),
  ]);
}

export async function listCheckpoints(ownerKey: string) {
  const { DB } = getRuntimeEnv();
  await ensureCheckpointSchema(DB);
  const result = await DB.prepare(
    `SELECT
      id,
      workspace_name AS workspaceName,
      label,
      source_agent AS sourceAgent,
      status,
      created_at AS createdAt,
      size_bytes AS sizeBytes,
      file_count AS fileCount,
      excluded_count AS excludedCount,
      parent_id AS parentId,
      handoff,
      checksum
    FROM checkpoints
    WHERE owner_key = ?
    ORDER BY created_at DESC
    LIMIT 50`,
  )
    .bind(ownerKey)
    .all<Omit<CheckpointRecord, "ownerKey" | "objectKey">>();

  return result.results ?? [];
}

export async function insertCheckpoint(record: CheckpointRecord) {
  const { DB } = getRuntimeEnv();
  await ensureCheckpointSchema(DB);
  await DB.prepare(
    `INSERT INTO checkpoints (
      id, owner_key, workspace_name, label, source_agent, status, created_at,
      size_bytes, file_count, excluded_count, parent_id, handoff, object_key, checksum,
      share_token, share_expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      record.id,
      record.ownerKey,
      record.workspaceName,
      record.label,
      record.sourceAgent,
      record.status,
      record.createdAt,
      record.sizeBytes,
      record.fileCount,
      record.excludedCount,
      record.parentId,
      record.handoff,
      record.objectKey,
      record.checksum,
      record.shareToken ?? null,
      record.shareExpiresAt ?? null,
    )
    .run();
}

export async function findCheckpoint(id: string, ownerKey: string) {
  const { DB } = getRuntimeEnv();
  await ensureCheckpointSchema(DB);
  return DB.prepare(
    `SELECT
      id,
      owner_key AS ownerKey,
      workspace_name AS workspaceName,
      label,
      source_agent AS sourceAgent,
      status,
      created_at AS createdAt,
      size_bytes AS sizeBytes,
      file_count AS fileCount,
      excluded_count AS excludedCount,
      parent_id AS parentId,
      handoff,
      object_key AS objectKey,
      checksum
    FROM checkpoints
    WHERE id = ? AND owner_key = ?
    LIMIT 1`,
  )
    .bind(id, ownerKey)
    .first<CheckpointRecord>();
}

export async function createShareToken(id: string, ownerKey: string) {
  const { DB } = getRuntimeEnv();
  await ensureCheckpointSchema(DB);
  const token = crypto.randomUUID().replaceAll("-", "");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const result = await DB.prepare(
    "UPDATE checkpoints SET share_token = ?, share_expires_at = ? WHERE id = ? AND owner_key = ?",
  )
    .bind(token, expiresAt, id, ownerKey)
    .run();

  return result.meta.changes > 0 ? { token, expiresAt } : null;
}

export async function findSharedCheckpoint(token: string) {
  const { DB } = getRuntimeEnv();
  await ensureCheckpointSchema(DB);
  return DB.prepare(
    `SELECT
      id,
      owner_key AS ownerKey,
      workspace_name AS workspaceName,
      label,
      source_agent AS sourceAgent,
      status,
      created_at AS createdAt,
      size_bytes AS sizeBytes,
      file_count AS fileCount,
      excluded_count AS excludedCount,
      parent_id AS parentId,
      handoff,
      object_key AS objectKey,
      checksum,
      share_token AS shareToken,
      share_expires_at AS shareExpiresAt
    FROM checkpoints
    WHERE share_token = ? AND share_expires_at > ?
    LIMIT 1`,
  )
    .bind(token, new Date().toISOString())
    .first<CheckpointRecord>();
}

export async function issueApiToken(ownerKey: string, label: string) {
  const { DB } = getRuntimeEnv();
  await ensureCheckpointSchema(DB);
  const token = `rly_${crypto.randomUUID().replaceAll("-", "")}${crypto
    .randomUUID()
    .replaceAll("-", "")}`;
  const tokenHash = await hashToken(token);
  const createdAt = new Date().toISOString();
  await DB.prepare(
    `INSERT INTO api_tokens (
      token_hash, token_prefix, owner_key, label, created_at, last_used_at
    ) VALUES (?, ?, ?, ?, ?, NULL)`,
  )
    .bind(tokenHash, token.slice(0, 12), ownerKey, label, createdAt)
    .run();
  return { token, prefix: token.slice(0, 12), createdAt };
}

export async function ownerForApiToken(token: string) {
  if (!/^rly_[a-f0-9]{64}$/i.test(token)) return null;
  const { DB } = getRuntimeEnv();
  await ensureCheckpointSchema(DB);
  const tokenHash = await hashToken(token);
  const record = await DB.prepare(
    "SELECT owner_key AS ownerKey FROM api_tokens WHERE token_hash = ? LIMIT 1",
  )
    .bind(tokenHash)
    .first<{ ownerKey: string }>();
  if (!record) return null;
  await DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?")
    .bind(new Date().toISOString(), tokenHash)
    .run();
  return record.ownerKey;
}

export async function authenticateApiToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? ownerForApiToken(match[1].trim()) : null;
}

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
