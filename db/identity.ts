type MembershipRow = {
  organizationId: string;
  organizationName: string;
  role: string;
};

let schemaPromise: Promise<void> | null = null;

const CORE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS user (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    email_verified INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY NOT NULL,
    expires_at INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    active_organization_id TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS session_userId_idx ON session(user_id)",
  `CREATE TABLE IF NOT EXISTS account (
    id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    access_token TEXT,
    refresh_token TEXT,
    id_token TEXT,
    access_token_expires_at INTEGER,
    refresh_token_expires_at INTEGER,
    scope TEXT,
    password TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS account_userId_idx ON account(user_id)",
  `CREATE TABLE IF NOT EXISTS verification (
    id TEXT PRIMARY KEY NOT NULL,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification(identifier)",
  `CREATE TABLE IF NOT EXISTS organization (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    logo TEXT,
    created_at INTEGER NOT NULL,
    metadata TEXT
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS organization_slug_uidx ON organization(slug)",
  `CREATE TABLE IF NOT EXISTS member (
    id TEXT PRIMARY KEY NOT NULL,
    organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS member_organizationId_idx ON member(organization_id)",
  "CREATE INDEX IF NOT EXISTS member_userId_idx ON member(user_id)",
  `CREATE TABLE IF NOT EXISTS invitation (
    id TEXT PRIMARY KEY NOT NULL,
    organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    inviter_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE
  )`,
  "CREATE INDEX IF NOT EXISTS invitation_organizationId_idx ON invitation(organization_id)",
  "CREATE INDEX IF NOT EXISTS invitation_email_idx ON invitation(email)",
] as const;

const PRODUCT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY,
    owner_key TEXT NOT NULL,
    tenant_id TEXT,
    created_by_user_id TEXT,
    workspace_name TEXT NOT NULL,
    label TEXT NOT NULL,
    source_agent TEXT NOT NULL,
    agent_name TEXT NOT NULL DEFAULT 'Mysterious Marmot',
    agent_description TEXT NOT NULL DEFAULT 'A privacy-minded helper that summarized progress and prepared an encrypted workspace handoff.',
    agent_metadata_mode TEXT NOT NULL DEFAULT 'pseudonymous',
    status TEXT NOT NULL DEFAULT 'ready',
    created_at TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    file_count INTEGER NOT NULL,
    excluded_count INTEGER NOT NULL,
    parent_id TEXT,
    handoff TEXT NOT NULL DEFAULT '',
    object_key TEXT NOT NULL,
    checksum TEXT NOT NULL,
    encryption_version INTEGER NOT NULL DEFAULT 1,
    cipher TEXT NOT NULL DEFAULT 'none',
    share_token TEXT,
    share_expires_at TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS checkpoints_owner_created_idx ON checkpoints(owner_key, created_at DESC)",
  `CREATE TABLE IF NOT EXISTS api_tokens (
    token_hash TEXT PRIMARY KEY,
    token_prefix TEXT NOT NULL,
    owner_key TEXT NOT NULL,
    tenant_id TEXT,
    created_by_user_id TEXT,
    label TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT 'checkpoints:read checkpoints:write checkpoints:share',
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    expires_at TEXT,
    revoked_at TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS api_tokens_owner_idx ON api_tokens(owner_key)",
  `CREATE TABLE IF NOT EXISTS checkpoint_publications (
    checkpoint_id TEXT PRIMARY KEY REFERENCES checkpoints(id),
    tenant_id TEXT NOT NULL,
    object_key TEXT NOT NULL,
    checksum TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    format_version INTEGER NOT NULL DEFAULT 1,
    source_ciphertext_checksum TEXT,
    public_title TEXT NOT NULL,
    public_description TEXT NOT NULL,
    published_at TEXT NOT NULL,
    published_by_user_id TEXT
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS checkpoint_publications_object_key_uidx ON checkpoint_publications(object_key)",
  "CREATE INDEX IF NOT EXISTS checkpoint_publications_tenant_published_idx ON checkpoint_publications(tenant_id, published_at DESC)",
  `CREATE TABLE IF NOT EXISTS checkpoint_marketplace_index (
    checkpoint_id TEXT PRIMARY KEY REFERENCES checkpoint_publications(checkpoint_id),
    public_title TEXT NOT NULL,
    public_description TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    agent_description TEXT NOT NULL,
    agent_metadata_mode TEXT NOT NULL,
    search_text TEXT NOT NULL,
    quality_score INTEGER NOT NULL DEFAULT 0,
    size_bytes INTEGER NOT NULL,
    format_version INTEGER NOT NULL,
    published_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS checkpoint_marketplace_published_idx ON checkpoint_marketplace_index(published_at DESC)",
  "CREATE INDEX IF NOT EXISTS checkpoint_marketplace_recommended_idx ON checkpoint_marketplace_index(quality_score DESC, published_at DESC)",
  `CREATE TABLE IF NOT EXISTS device_authorizations (
    device_code_hash TEXT PRIMARY KEY,
    user_code_hash TEXT NOT NULL,
    client_name TEXT NOT NULL,
    requested_scopes TEXT NOT NULL DEFAULT 'checkpoints:read checkpoints:write checkpoints:share',
    status TEXT NOT NULL DEFAULT 'pending',
    tenant_id TEXT,
    user_id TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    approved_at TEXT,
    consumed_at TEXT
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS device_authorizations_user_code_uidx ON device_authorizations(user_code_hash)",
  "CREATE INDEX IF NOT EXISTS device_authorizations_expires_idx ON device_authorizations(expires_at)",
] as const;

export async function ensureRelaySchema(db: D1Database): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = ensureSchema(db).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  await schemaPromise;
}

async function ensureSchema(db: D1Database): Promise<void> {
  await db.batch(
    [...CORE_SCHEMA, ...PRODUCT_SCHEMA].map((statement) => db.prepare(statement)),
  );

  await ensureColumn(db, "checkpoints", "tenant_id", "TEXT");
  await ensureColumn(db, "checkpoints", "created_by_user_id", "TEXT");
  await ensureColumn(
    db,
    "checkpoints",
    "encryption_version",
    "INTEGER NOT NULL DEFAULT 1",
  );
  await ensureColumn(
    db,
    "checkpoints",
    "cipher",
    "TEXT NOT NULL DEFAULT 'none'",
  );
  await ensureColumn(
    db,
    "checkpoints",
    "agent_name",
    "TEXT NOT NULL DEFAULT 'Mysterious Marmot'",
  );
  await ensureColumn(
    db,
    "checkpoints",
    "agent_description",
    "TEXT NOT NULL DEFAULT 'A privacy-minded helper that summarized progress and prepared an encrypted workspace handoff.'",
  );
  await ensureColumn(
    db,
    "checkpoints",
    "agent_metadata_mode",
    "TEXT NOT NULL DEFAULT 'pseudonymous'",
  );
  await ensureColumn(db, "api_tokens", "tenant_id", "TEXT");
  await ensureColumn(db, "api_tokens", "created_by_user_id", "TEXT");
  await ensureColumn(
    db,
    "api_tokens",
    "scopes",
    "TEXT NOT NULL DEFAULT 'checkpoints:read checkpoints:write checkpoints:share'",
  );
  await ensureColumn(db, "api_tokens", "expires_at", "TEXT");
  await ensureColumn(db, "api_tokens", "revoked_at", "TEXT");
  await ensureColumn(
    db,
    "device_authorizations",
    "requested_scopes",
    "TEXT NOT NULL DEFAULT 'checkpoints:read checkpoints:write checkpoints:share'",
  );

  await db.batch([
    db.prepare(
      "CREATE INDEX IF NOT EXISTS checkpoints_tenant_created_idx ON checkpoints(tenant_id, created_at DESC)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS api_tokens_tenant_idx ON api_tokens(tenant_id)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS checkpoint_publications_tenant_published_idx ON checkpoint_publications(tenant_id, published_at DESC)",
    ),
    db.prepare(
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
      JOIN checkpoints c ON c.id = p.checkpoint_id`,
    ),
  ]);
}

async function ensureColumn(
  db: D1Database,
  table: "checkpoints" | "api_tokens" | "device_authorizations",
  column: string,
  definition: string,
): Promise<void> {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  if (result.results.some((field) => field.name === column)) return;
  await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

export async function ensurePersonalOrganization(
  db: D1Database,
  userId: string,
  displayName: string,
): Promise<MembershipRow> {
  const existing = await db
    .prepare(
      `SELECT
        organization.id AS organizationId,
        organization.name AS organizationName,
        member.role
      FROM member
      JOIN organization ON organization.id = member.organization_id
      WHERE member.user_id = ?
      ORDER BY CASE member.role WHEN 'owner' THEN 0 ELSE 1 END, member.created_at
      LIMIT 1`,
    )
    .bind(userId)
    .first<MembershipRow>();
  if (existing) return existing;

  const organizationId = createId("org");
  const now = Date.now();
  const organizationName = `${displayName || "Relay"}'s workspace`;
  const slug = `personal-${userId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 18)}-${crypto.randomUUID().slice(0, 6)}`;

  await db.batch([
    db
      .prepare(
        `INSERT INTO organization (
          id, name, slug, logo, created_at, metadata
        ) VALUES (?, ?, ?, NULL, ?, ?)`,
      )
      .bind(organizationId, organizationName, slug, now, JSON.stringify({ personal: true })),
    db
      .prepare(
        `INSERT INTO member (
          id, organization_id, user_id, role, created_at
        ) VALUES (?, ?, ?, 'owner', ?)`,
      )
      .bind(createId("mem"), organizationId, userId, now),
  ]);

  return {
    organizationId,
    organizationName,
    role: "owner",
  };
}

export async function claimLegacyOwnership(
  db: D1Database,
  email: string,
  tenantId: string,
  userId: string,
): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase();
  await db.batch([
    db
      .prepare(
        `UPDATE checkpoints
        SET owner_key = ?, tenant_id = ?, created_by_user_id = COALESCE(created_by_user_id, ?)
        WHERE lower(owner_key) = ? OR tenant_id = ?`,
      )
      .bind(tenantId, tenantId, userId, normalizedEmail, tenantId),
    db
      .prepare(
        `UPDATE api_tokens
        SET owner_key = ?, tenant_id = ?, created_by_user_id = COALESCE(created_by_user_id, ?)
        WHERE lower(owner_key) = ? OR tenant_id = ?`,
      )
      .bind(tenantId, tenantId, userId, normalizedEmail, tenantId),
  ]);
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
