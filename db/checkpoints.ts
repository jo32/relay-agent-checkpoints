import { env } from "cloudflare:workers";
import { ensureRelaySchema } from "./identity";
import type { AgentMetadataMode } from "../lib/agent-metadata";

export type StoredCheckpointRecord = {
  id: string;
  ownerKey: string;
  tenantId: string;
  createdByUserId: string | null;
  workspaceName: string;
  label: string;
  sourceAgent: string;
  agentName: string;
  agentDescription: string;
  agentMetadataMode: AgentMetadataMode;
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

export type CheckpointPublicationRecord = {
  checkpointId: string;
  tenantId: string;
  objectKey: string;
  checksum: string;
  sizeBytes: number;
  formatVersion: number;
  sourceCiphertextChecksum: string | null;
  publicTitle: string;
  publicDescription: string;
  publishedAt: string;
  publishedByUserId: string | null;
};

export type CheckpointPublicationMetadata = {
  title: string;
  description: string;
  checksum: string;
  sizeBytes: number;
  formatVersion: number;
  sourceCiphertextChecksum: string | null;
  publishedAt: string;
};

export type CheckpointRecord = StoredCheckpointRecord & {
  visibility: "private" | "public";
  publication: CheckpointPublicationMetadata | null;
};

export type MarketplaceSort = "recommended" | "latest";

export type MarketplaceCheckpoint = {
  id: string;
  title: string;
  description: string;
  agent: {
    name: string;
    description: string;
    metadataMode: AgentMetadataMode;
  };
  sizeBytes: number;
  formatVersion: number;
  publishedAt: string;
  downloadUrl: string;
  metadataUrl: string;
  marketplaceUrl: string;
};

type RawMarketplaceCheckpoint = {
  id: string;
  publicTitle: string;
  publicDescription: string;
  agentName: string;
  agentDescription: string;
  agentMetadataMode: AgentMetadataMode;
  sizeBytes: number;
  formatVersion: number;
  publishedAt: string;
};

type RawPublicationColumns = {
  publicationCheckpointId: string | null;
  publicationTenantId: string | null;
  publicationObjectKey: string | null;
  publicationChecksum: string | null;
  publicationSizeBytes: number | null;
  publicationFormatVersion: number | null;
  sourceCiphertextChecksum: string | null;
  publicTitle: string | null;
  publicDescription: string | null;
  publishedAt: string | null;
  publishedByUserId: string | null;
};

type RawCheckpointRecord = StoredCheckpointRecord & RawPublicationColumns;

type RuntimeEnv = {
  DB: D1Database;
  CHECKPOINTS: R2Bucket;
};

export type ApiTokenPrincipal = {
  tenantId: string;
  userId: string | null;
  scopes: string[];
};

export const CHECKPOINT_SCOPES = [
  "checkpoints:read",
  "checkpoints:write",
  "checkpoints:share",
  "checkpoints:publish",
] as const;
export type CheckpointScope = (typeof CHECKPOINT_SCOPES)[number];
export const DEFAULT_TOKEN_SCOPES = [
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
      c.id,
      c.owner_key AS ownerKey,
      COALESCE(c.tenant_id, c.owner_key) AS tenantId,
      c.created_by_user_id AS createdByUserId,
      c.workspace_name AS workspaceName,
      c.label,
      c.source_agent AS sourceAgent,
      c.agent_name AS agentName,
      c.agent_description AS agentDescription,
      c.agent_metadata_mode AS agentMetadataMode,
      c.status,
      c.created_at AS createdAt,
      c.size_bytes AS sizeBytes,
      c.file_count AS fileCount,
      c.excluded_count AS excludedCount,
      c.parent_id AS parentId,
      c.handoff,
      c.object_key AS objectKey,
      c.checksum,
      c.encryption_version AS encryptionVersion,
      c.cipher,
      p.checkpoint_id AS publicationCheckpointId,
      p.tenant_id AS publicationTenantId,
      p.object_key AS publicationObjectKey,
      p.checksum AS publicationChecksum,
      p.size_bytes AS publicationSizeBytes,
      p.format_version AS publicationFormatVersion,
      p.source_ciphertext_checksum AS sourceCiphertextChecksum,
      p.public_title AS publicTitle,
      p.public_description AS publicDescription,
      p.published_at AS publishedAt,
      p.published_by_user_id AS publishedByUserId
    FROM checkpoints c
    LEFT JOIN checkpoint_publications p ON p.checkpoint_id = c.id
    WHERE COALESCE(c.tenant_id, c.owner_key) = ?
    ORDER BY c.created_at DESC
    LIMIT 50`,
  )
    .bind(tenantId)
    .all<RawCheckpointRecord>();

  return (result.results ?? []).map(toOwnerCheckpointDto);
}

export async function insertCheckpoint(record: StoredCheckpointRecord) {
  const { DB } = getRuntimeEnv();
  await ensureCheckpointSchema(DB);
  await checkpointInsertStatement(DB, record).run();
}

export async function insertPublicCheckpoint(
  checkpoint: StoredCheckpointRecord,
  publication: CheckpointPublicationRecord,
) {
  if (
    checkpoint.id !== publication.checkpointId ||
    checkpoint.tenantId !== publication.tenantId ||
    checkpoint.encryptionVersion !== 0 ||
    checkpoint.cipher !== "none" ||
    checkpoint.objectKey !== publication.objectKey ||
    checkpoint.checksum !== publication.checksum ||
    publication.sourceCiphertextChecksum !== null
  ) {
    throw new Error("Public checkpoint and publication metadata do not match.");
  }
  const { DB } = getRuntimeEnv();
  await ensureCheckpointSchema(DB);
  await DB.batch([
    checkpointInsertStatement(DB, checkpoint),
    publicationInsertStatement(DB, publication),
    marketplaceIndexInsertStatement(DB, checkpoint, publication),
  ]);
}

export type PublishExistingResult =
  | "created"
  | "exists"
  | "not-found"
  | "source-mismatch";

export async function insertPublicationForExistingCheckpoint(
  publication: CheckpointPublicationRecord,
): Promise<PublishExistingResult> {
  if (
    !publication.sourceCiphertextChecksum ||
    !publication.publishedByUserId
  ) {
    throw new Error(
      "Promoted checkpoints require a source checksum and publishing user.",
    );
  }
  const { DB } = getRuntimeEnv();
  await ensureCheckpointSchema(DB);
  const publicationInsert = DB.prepare(
    `INSERT INTO checkpoint_publications (
      checkpoint_id, tenant_id, object_key, checksum, size_bytes,
      format_version, source_ciphertext_checksum, public_title,
      public_description, published_at, published_by_user_id
    )
    SELECT
      c.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    FROM checkpoints c
    WHERE c.id = ?
      AND COALESCE(c.tenant_id, c.owner_key) = ?
      AND c.created_by_user_id = ?
      AND lower(c.checksum) = lower(?)
      AND c.encryption_version >= 2
      AND NOT EXISTS (
        SELECT 1 FROM checkpoint_publications p WHERE p.checkpoint_id = c.id
      )`,
  )
    .bind(
      publication.tenantId,
      publication.objectKey,
      publication.checksum,
      publication.sizeBytes,
      publication.formatVersion,
      publication.sourceCiphertextChecksum,
      publication.publicTitle,
      publication.publicDescription,
      publication.publishedAt,
      publication.publishedByUserId,
      publication.checkpointId,
      publication.tenantId,
      publication.publishedByUserId,
      publication.sourceCiphertextChecksum,
    );
  const [inserted] = await DB.batch([
    publicationInsert,
    marketplaceIndexFromPublicationStatement(DB, publication.checkpointId),
  ]);
  if (inserted.meta.changes > 0) return "created";

  const existingPublication = await findCheckpointPublication(
    publication.checkpointId,
    publication.tenantId,
  );
  if (existingPublication) return "exists";
  const source = await DB.prepare(
    `SELECT checksum
    FROM checkpoints
    WHERE id = ?
      AND COALESCE(tenant_id, owner_key) = ?
      AND created_by_user_id = ?
    LIMIT 1`,
  )
    .bind(
      publication.checkpointId,
      publication.tenantId,
      publication.publishedByUserId,
    )
    .first<{ checksum: string }>();
  return source ? "source-mismatch" : "not-found";
}

export async function findCheckpoint(id: string, tenantId: string) {
  const { DB } = getRuntimeEnv();
  await ensureCheckpointSchema(DB);
  const row = await DB.prepare(
    `SELECT
      c.id,
      c.owner_key AS ownerKey,
      COALESCE(c.tenant_id, c.owner_key) AS tenantId,
      c.created_by_user_id AS createdByUserId,
      c.workspace_name AS workspaceName,
      c.label,
      c.source_agent AS sourceAgent,
      c.agent_name AS agentName,
      c.agent_description AS agentDescription,
      c.agent_metadata_mode AS agentMetadataMode,
      c.status,
      c.created_at AS createdAt,
      c.size_bytes AS sizeBytes,
      c.file_count AS fileCount,
      c.excluded_count AS excludedCount,
      c.parent_id AS parentId,
      c.handoff,
      c.object_key AS objectKey,
      c.checksum,
      c.encryption_version AS encryptionVersion,
      c.cipher,
      p.checkpoint_id AS publicationCheckpointId,
      p.tenant_id AS publicationTenantId,
      p.object_key AS publicationObjectKey,
      p.checksum AS publicationChecksum,
      p.size_bytes AS publicationSizeBytes,
      p.format_version AS publicationFormatVersion,
      p.source_ciphertext_checksum AS sourceCiphertextChecksum,
      p.public_title AS publicTitle,
      p.public_description AS publicDescription,
      p.published_at AS publishedAt,
      p.published_by_user_id AS publishedByUserId
    FROM checkpoints c
    LEFT JOIN checkpoint_publications p ON p.checkpoint_id = c.id
    WHERE c.id = ? AND COALESCE(c.tenant_id, c.owner_key) = ?
    LIMIT 1`,
  )
    .bind(id, tenantId)
    .first<RawCheckpointRecord>();
  return row ? toCheckpointRecord(row) : null;
}

export async function findPublicCheckpoint(id: string) {
  if (!/^cp_[a-z0-9_-]{6,80}$/i.test(id)) return null;
  const { DB } = getRuntimeEnv();
  await ensureCheckpointSchema(DB);
  const row = await DB.prepare(
    `SELECT
      c.id,
      c.owner_key AS ownerKey,
      COALESCE(c.tenant_id, c.owner_key) AS tenantId,
      c.created_by_user_id AS createdByUserId,
      c.workspace_name AS workspaceName,
      c.label,
      c.source_agent AS sourceAgent,
      c.agent_name AS agentName,
      c.agent_description AS agentDescription,
      c.agent_metadata_mode AS agentMetadataMode,
      c.status,
      c.created_at AS createdAt,
      c.size_bytes AS sizeBytes,
      c.file_count AS fileCount,
      c.excluded_count AS excludedCount,
      c.parent_id AS parentId,
      c.handoff,
      c.object_key AS objectKey,
      c.checksum,
      c.encryption_version AS encryptionVersion,
      c.cipher,
      p.checkpoint_id AS publicationCheckpointId,
      p.tenant_id AS publicationTenantId,
      p.object_key AS publicationObjectKey,
      p.checksum AS publicationChecksum,
      p.size_bytes AS publicationSizeBytes,
      p.format_version AS publicationFormatVersion,
      p.source_ciphertext_checksum AS sourceCiphertextChecksum,
      p.public_title AS publicTitle,
      p.public_description AS publicDescription,
      p.published_at AS publishedAt,
      p.published_by_user_id AS publishedByUserId
    FROM checkpoint_publications p
    JOIN checkpoints c ON c.id = p.checkpoint_id
    WHERE p.checkpoint_id = ?
    LIMIT 1`,
  )
    .bind(id)
    .first<RawCheckpointRecord>();
  return row ? toCheckpointRecord(row) : null;
}

export async function listMarketplaceCheckpoints({
  query = "",
  sort = "recommended",
  page = 1,
  pageSize = 24,
}: {
  query?: string;
  sort?: MarketplaceSort;
  page?: number;
  pageSize?: number;
} = {}) {
  const { DB } = getRuntimeEnv();
  await ensureCheckpointSchema(DB);

  const normalizedQuery = normalizeMarketplaceQuery(query);
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean).slice(0, 6);
  const conditions = tokens.map(
    () => "search_text LIKE ? ESCAPE '\\'",
  );
  const whereClause = conditions.length ? conditions.join(" AND ") : "1 = 1";
  const searchParameters = tokens.map(toLikePattern);
  const safePage = Math.max(1, Math.min(10_000, Math.trunc(page) || 1));
  const safePageSize = Math.max(1, Math.min(48, Math.trunc(pageSize) || 24));
  const offset = (safePage - 1) * safePageSize;

  const queryRelevance =
    normalizedQuery && sort === "recommended"
      ? `CASE
          WHEN lower(public_title) = ? THEN 4
          WHEN instr(lower(public_title), ?) = 1 THEN 3
          WHEN instr(lower(public_title), ?) > 0 THEN 2
          WHEN instr(lower(public_description), ?) > 0 THEN 1
          ELSE 0
        END DESC,`
      : "";
  const orderParameters =
    normalizedQuery && sort === "recommended"
      ? Array(4).fill(normalizedQuery)
      : [];
  const orderClause =
    sort === "latest"
      ? "published_at DESC, checkpoint_id ASC"
      : `${queryRelevance} quality_score DESC, published_at DESC, checkpoint_id ASC`;

  const result = await DB.prepare(
    `SELECT
      checkpoint_id AS id,
      public_title AS publicTitle,
      public_description AS publicDescription,
      agent_name AS agentName,
      agent_description AS agentDescription,
      agent_metadata_mode AS agentMetadataMode,
      size_bytes AS sizeBytes,
      format_version AS formatVersion,
      published_at AS publishedAt
    FROM checkpoint_marketplace_index
    WHERE ${whereClause}
    ORDER BY ${orderClause}
    LIMIT ? OFFSET ?`,
  )
    .bind(
      ...searchParameters,
      ...orderParameters,
      safePageSize,
      offset,
    )
    .all<RawMarketplaceCheckpoint>();
  const count = await DB.prepare(
    `SELECT count(*) AS total
    FROM checkpoint_marketplace_index
    WHERE ${whereClause}`,
  )
    .bind(...searchParameters)
    .first<{ total: number }>();

  return {
    checkpoints: (result.results ?? []).map(toMarketplaceCheckpoint),
    total: Number(count?.total ?? 0),
    page: safePage,
    pageSize: safePageSize,
    hasMore: offset + (result.results?.length ?? 0) < Number(count?.total ?? 0),
    query: normalizedQuery,
    sort,
  };
}

export async function findCheckpointPublication(
  id: string,
  tenantId: string,
) {
  const { DB } = getRuntimeEnv();
  await ensureCheckpointSchema(DB);
  return DB.prepare(
    `SELECT
      checkpoint_id AS checkpointId,
      tenant_id AS tenantId,
      object_key AS objectKey,
      checksum,
      size_bytes AS sizeBytes,
      format_version AS formatVersion,
      source_ciphertext_checksum AS sourceCiphertextChecksum,
      public_title AS publicTitle,
      public_description AS publicDescription,
      published_at AS publishedAt,
      published_by_user_id AS publishedByUserId
    FROM checkpoint_publications
    WHERE checkpoint_id = ? AND tenant_id = ?
    LIMIT 1`,
  )
    .bind(id, tenantId)
    .first<CheckpointPublicationRecord>();
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
      agent_name AS agentName,
      agent_description AS agentDescription,
      agent_metadata_mode AS agentMetadataMode,
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
    .first<StoredCheckpointRecord>();
}

export async function issueApiToken(
  tenantId: string,
  userId: string,
  label: string,
  requestedScopes: readonly CheckpointScope[] = DEFAULT_TOKEN_SCOPES,
) {
  const { DB } = getRuntimeEnv();
  await ensureCheckpointSchema(DB);
  const token = `rly_${crypto.randomUUID().replaceAll("-", "")}${crypto
    .randomUUID()
    .replaceAll("-", "")}`;
  const tokenHash = await hashToken(token);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  const scopes = [...new Set(requestedScopes)].join(" ");
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
  requiredScope?: CheckpointScope,
) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const principal = await ownerForApiToken(match[1].trim());
  if (!principal) return null;
  if (requiredScope && !principal.scopes.includes(requiredScope)) return null;
  return principal;
}

export function hasCheckpointScopes(
  principal: ApiTokenPrincipal,
  ...scopes: CheckpointScope[]
) {
  return scopes.every((scope) => principal.scopes.includes(scope));
}

export function toOwnerCheckpointDto(checkpoint: CheckpointRecord | RawCheckpointRecord) {
  const normalized =
    "publicationCheckpointId" in checkpoint
      ? toCheckpointRecord(checkpoint)
      : checkpoint;
  return {
    id: normalized.id,
    workspaceName: normalized.workspaceName,
    label: normalized.label,
    sourceAgent: normalized.sourceAgent,
    agentName: normalized.agentName,
    agentDescription: normalized.agentDescription,
    agentMetadataMode: normalized.agentMetadataMode,
    status: normalized.status,
    createdAt: normalized.createdAt,
    sizeBytes: normalized.sizeBytes,
    fileCount: normalized.fileCount,
    excludedCount: normalized.excludedCount,
    parentId: normalized.parentId,
    handoff: normalized.handoff,
    checksum: normalized.checksum,
    encryptionVersion: normalized.encryptionVersion,
    cipher: normalized.cipher,
    visibility: normalized.visibility,
    publication: normalized.publication,
    marketplaceUrl: normalized.publication
      ? `/marketplace?q=${encodeURIComponent(normalized.id)}`
      : null,
  };
}

export async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function checkpointInsertStatement(db: D1Database, record: StoredCheckpointRecord) {
  return db
    .prepare(
      `INSERT INTO checkpoints (
        id, owner_key, tenant_id, created_by_user_id,
        workspace_name, label, source_agent, status, created_at,
        agent_name, agent_description, agent_metadata_mode,
        size_bytes, file_count, excluded_count, parent_id, handoff, object_key, checksum,
        encryption_version, cipher, share_token, share_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      record.agentName,
      record.agentDescription,
      record.agentMetadataMode,
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
    );
}

function publicationInsertStatement(
  db: D1Database,
  publication: CheckpointPublicationRecord,
) {
  return db
    .prepare(
      `INSERT INTO checkpoint_publications (
        checkpoint_id, tenant_id, object_key, checksum, size_bytes,
        format_version, source_ciphertext_checksum, public_title,
        public_description, published_at, published_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      publication.checkpointId,
      publication.tenantId,
      publication.objectKey,
      publication.checksum,
      publication.sizeBytes,
      publication.formatVersion,
      publication.sourceCiphertextChecksum,
      publication.publicTitle,
      publication.publicDescription,
      publication.publishedAt,
      publication.publishedByUserId,
    );
}

function marketplaceIndexInsertStatement(
  db: D1Database,
  checkpoint: StoredCheckpointRecord,
  publication: CheckpointPublicationRecord,
) {
  const searchText = normalizeMarketplaceQuery(
    [
      publication.checkpointId,
      publication.publicTitle,
      publication.publicDescription,
      checkpoint.agentName,
      checkpoint.agentDescription,
    ].join(" "),
  );
  const qualityScore =
    (publication.publicTitle.length >= 12 &&
    publication.publicTitle.length <= 80
      ? 3
      : 1) +
    (publication.publicDescription.length >= 40 &&
    publication.publicDescription.length <= 240
      ? 5
      : 2) +
    (checkpoint.agentMetadataMode === "shared" ? 2 : 1);

  return db
    .prepare(
      `INSERT INTO checkpoint_marketplace_index (
        checkpoint_id, public_title, public_description, agent_name,
        agent_description, agent_metadata_mode, search_text, quality_score,
        size_bytes, format_version, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      publication.checkpointId,
      publication.publicTitle,
      publication.publicDescription,
      checkpoint.agentName,
      checkpoint.agentDescription,
      checkpoint.agentMetadataMode,
      searchText,
      qualityScore,
      publication.sizeBytes,
      publication.formatVersion,
      publication.publishedAt,
    );
}

function marketplaceIndexFromPublicationStatement(
  db: D1Database,
  checkpointId: string,
) {
  return db
    .prepare(
      `INSERT OR IGNORE INTO checkpoint_marketplace_index (
        checkpoint_id, public_title, public_description, agent_name,
        agent_description, agent_metadata_mode, search_text, quality_score,
        size_bytes, format_version, published_at
      )
      SELECT
        p.checkpoint_id,
        p.public_title,
        p.public_description,
        c.agent_name,
        c.agent_description,
        c.agent_metadata_mode,
        lower(
          p.checkpoint_id || ' ' || p.public_title || ' ' || p.public_description || ' ' ||
          c.agent_name || ' ' || c.agent_description
        ),
        (
          CASE WHEN length(p.public_title) BETWEEN 12 AND 80 THEN 3 ELSE 1 END +
          CASE WHEN length(p.public_description) BETWEEN 40 AND 240 THEN 5 ELSE 2 END +
          CASE WHEN c.agent_metadata_mode = 'shared' THEN 2 ELSE 1 END
        ),
        p.size_bytes,
        p.format_version,
        p.published_at
      FROM checkpoint_publications p
      JOIN checkpoints c ON c.id = p.checkpoint_id
      WHERE p.checkpoint_id = ?`,
    )
    .bind(checkpointId);
}

function normalizeMarketplaceQuery(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function toLikePattern(value: string) {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

function toMarketplaceCheckpoint(
  checkpoint: RawMarketplaceCheckpoint,
): MarketplaceCheckpoint {
  const encodedId = encodeURIComponent(checkpoint.id);
  return {
    id: checkpoint.id,
    title: checkpoint.publicTitle,
    description: checkpoint.publicDescription,
    agent: {
      name: checkpoint.agentName,
      description: checkpoint.agentDescription,
      metadataMode: checkpoint.agentMetadataMode,
    },
    sizeBytes: checkpoint.sizeBytes,
    formatVersion: checkpoint.formatVersion,
    publishedAt: checkpoint.publishedAt,
    downloadUrl: `/api/public/checkpoints/${encodedId}/download`,
    metadataUrl: `/api/public/checkpoints/${encodedId}`,
    marketplaceUrl: `/marketplace?q=${encodedId}`,
  };
}

function toCheckpointRecord(row: RawCheckpointRecord): CheckpointRecord {
  const publication =
    row.publicationCheckpointId &&
    row.publicationChecksum &&
    row.publicationSizeBytes !== null &&
    row.publicationFormatVersion !== null &&
    row.publicTitle &&
    row.publicDescription &&
    row.publishedAt
      ? {
          title: row.publicTitle,
          description: row.publicDescription,
          checksum: row.publicationChecksum,
          sizeBytes: row.publicationSizeBytes,
          formatVersion: row.publicationFormatVersion,
          sourceCiphertextChecksum: row.sourceCiphertextChecksum,
          publishedAt: row.publishedAt,
        }
      : null;
  return {
    id: row.id,
    ownerKey: row.ownerKey,
    tenantId: row.tenantId,
    createdByUserId: row.createdByUserId,
    workspaceName: row.workspaceName,
    label: row.label,
    sourceAgent: row.sourceAgent,
    agentName: row.agentName,
    agentDescription: row.agentDescription,
    agentMetadataMode: row.agentMetadataMode,
    status: row.status,
    createdAt: row.createdAt,
    sizeBytes: row.sizeBytes,
    fileCount: row.fileCount,
    excludedCount: row.excludedCount,
    parentId: row.parentId,
    handoff: row.handoff,
    objectKey: row.objectKey,
    checksum: row.checksum,
    encryptionVersion: row.encryptionVersion,
    cipher: row.cipher,
    shareToken: row.shareToken,
    shareExpiresAt: row.shareExpiresAt,
    visibility: publication ? "public" : "private",
    publication,
  };
}
