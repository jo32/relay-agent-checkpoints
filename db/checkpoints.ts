import { env } from "cloudflare:workers";
import { ensureRelaySchema } from "./identity";

export type CheckpointRecord = {
  id: string;
  ownerKey: string;
  tenantId: string;
  createdByUserId: string | null;
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
  encryptionVersion: number;
  cipher: string;
  shareToken?: string | null;
  shareExpiresAt?: string | null;
};

type RuntimeEnv = {
  DB: D1Database;
  CHECKPOINTS: R2Bucket;
};

export type ApiTokenPrincipal = {
  tenantId: string;
  userId: string | null;
  scopes: string[];
};

const DEFAULT_TOKEN_SCOPES = [
  "checkpoints:read",
  "checkpoints:write",
  "checkpoints:share",
] as const;

export function getRuntimeEnv(): RuntimeEnv {
  const runtime = env as unknown as Partial<RuntimeEnv>;
  if (!runtime.DB || !runtime.CHECKPOINTS) {
    throw new Error("Checkpoint storage is unavailable.");
  }
  return runtime as RuntimeEnv;
}

export async function ensureCheckpointSchema(db: D1Database) {
  await ensureRelaySchema(db);
}

export async function listCheckpoints(tenantId: string) {
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
      checksum,
      encryption_version AS encryptionVersion,
      cipher
    FROM checkpoints
    WHERE COALESCE(tenant_id, owner_key) = ?
    ORDER BY created_at DESC
    LIMIT 50`,
  )
    .bind(tenantId)
    .all<
      Omit<
        CheckpointRecord,
        "ownerKey" | "tenantId" | "createdByUserId" | "objectKey"
      >
    >();

  return result.results ?? [];
}

export async function insertCheckpoint(record: CheckpointRecord) {
  const { DB } = getRuntimeEnv();
  await ensureCheckpointSchema(DB);
  await DB.prepare(
    `INSERT INTO checkpoints (
      id, owner_key, tenant_id, created_by_user_id,
      workspace_name, label, source_agent, status, created_at,
      size_bytes, file_count, excluded_count, parent_id, handoff, object_key, checksum,
      encryption_version, cipher, share_token, share_expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      record.id,
      record.ownerKey,
      record.tenantId,
      record.createdByUserId,
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
      record.encryptionVersion,
      record.cipher,
      record.shareToken ?? null,
      record.shareExpiresAt ?? null,
    )
    .run();
}

export async function findCheckpoint(id: string, tenantId: string) {
  const { DB } = getRuntimeEnv();
  await ensureCheckpointSchema(DB);
  return DB.prepare(
    `SELECT
      id,
      owner_key AS ownerKey,
      COALESCE(tenant_id, owner_key) AS tenantId,
      created_by_user_id AS createdByUserId,
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
      encryption_version AS encryptionVersion,
      cipher
    FROM checkpoints
    WHERE id = ? AND COALESCE(tenant_id, owner_key) = ?
    LIMIT 1`,
  )
    .bind(id, tenantId)
    .first<CheckpointRecord>();
}

export async function checkpointIdExists(id: string) {
  const { DB } = getRuntimeEnv();
  await ensureCheckpointSchema(DB);
  const record = await DB.prepare(
    "SELECT 1 AS present FROM checkpoints WHERE id = ? LIMIT 1",
  )
    .bind(id)
    .first<{ present: number }>();
  return Boolean(record);
}

export async function createShareToken(id: string, tenantId: string) {
  const { DB } = getRuntimeEnv();
  await ensureCheckpointSchema(DB);
  const token = crypto.randomUUID().replaceAll("-", "");
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const result = await DB.prepare(
    `UPDATE checkpoints
    SET share_token = ?, share_expires_at = ?
    WHERE id = ?
      AND COALESCE(tenant_id, owner_key) = ?
      AND encryption_version >= 2`,
  )
    .bind(tokenHash, expiresAt, id, tenantId)
    .run();

  return result.meta.changes > 0 ? { token, expiresAt } : null;
}

export async function findSharedCheckpoint(token: string) {
  const { DB } = getRuntimeEnv();
  await ensureCheckpointSchema(DB);
  const tokenHash = await hashToken(token);
  return DB.prepare(
    `SELECT
      id,
      owner_key AS ownerKey,
      COALESCE(tenant_id, owner_key) AS tenantId,
      created_by_user_id AS createdByUserId,
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
      encryption_version AS encryptionVersion,
      cipher,
      share_token AS shareToken,
      share_expires_at AS shareExpiresAt
    FROM checkpoints
    WHERE (share_token = ? OR share_token = ?)
      AND share_expires_at > ?
    LIMIT 1`,
  )
    .bind(tokenHash, token, new Date().toISOString())
    .first<CheckpointRecord>();
}

export async function issueApiToken(
  tenantId: string,
  userId: string,
  label: string,
) {
  const { DB } = getRuntimeEnv();
  await ensureCheckpointSchema(DB);
  const token = `rly_${crypto.randomUUID().replaceAll("-", "")}${crypto
    .randomUUID()
    .replaceAll("-", "")}`;
  const tokenHash = await hashToken(token);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  const scopes = DEFAULT_TOKEN_SCOPES.join(" ");
  await DB.prepare(
    `INSERT INTO api_tokens (
      token_hash, token_prefix, owner_key, tenant_id, created_by_user_id,
      label, scopes, created_at, last_used_at, expires_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
  )
    .bind(
      tokenHash,
      token.slice(0, 12),
      tenantId,
      tenantId,
      userId,
      label,
      scopes,
      createdAt,
      expiresAt,
    )
    .run();
  return { token, prefix: token.slice(0, 12), createdAt, expiresAt, scopes };
}

export async function ownerForApiToken(token: string) {
  if (!/^rly_[a-f0-9]{64}$/i.test(token)) return null;
  const { DB } = getRuntimeEnv();
  await ensureCheckpointSchema(DB);
  const tokenHash = await hashToken(token);
  const record = await DB.prepare(
    `SELECT
      COALESCE(tenant_id, owner_key) AS tenantId,
      created_by_user_id AS userId,
      COALESCE(
        scopes,
        'checkpoints:read checkpoints:write checkpoints:share'
      ) AS scopes
    FROM api_tokens
    WHERE token_hash = ?
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > ?)
    LIMIT 1`,
  )
    .bind(tokenHash, new Date().toISOString())
    .first<{ tenantId: string; userId: string | null; scopes: string }>();
  if (!record) return null;
  await DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?")
    .bind(new Date().toISOString(), tokenHash)
    .run();
  return {
    tenantId: record.tenantId,
    userId: record.userId,
    scopes: record.scopes.split(/\s+/).filter(Boolean),
  } satisfies ApiTokenPrincipal;
}

export async function authenticateApiToken(
  request: Request,
  requiredScope?: (typeof DEFAULT_TOKEN_SCOPES)[number],
) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const principal = await ownerForApiToken(match[1].trim());
  if (!principal) return null;
  if (requiredScope && !principal.scopes.includes(requiredScope)) return null;
  return principal;
}

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
