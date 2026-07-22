import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const checkpoints = sqliteTable(
  "checkpoints",
  {
    id: text("id").primaryKey(),
    ownerKey: text("owner_key").notNull(),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id"),
    workspaceName: text("workspace_name").notNull(),
    label: text("label").notNull(),
    sourceAgent: text("source_agent").notNull(),
    agentName: text("agent_name").notNull().default("Mysterious Marmot"),
    agentDescription: text("agent_description")
      .notNull()
      .default(
        "A privacy-minded helper that summarized progress and prepared an encrypted workspace handoff.",
      ),
    agentMetadataMode: text("agent_metadata_mode")
      .notNull()
      .default("pseudonymous"),
    status: text("status").notNull().default("ready"),
    createdAt: text("created_at").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    fileCount: integer("file_count").notNull(),
    excludedCount: integer("excluded_count").notNull(),
    parentId: text("parent_id"),
    handoff: text("handoff").notNull().default(""),
    objectKey: text("object_key").notNull(),
    checksum: text("checksum").notNull(),
    encryptionVersion: integer("encryption_version").notNull().default(1),
    cipher: text("cipher").notNull().default("none"),
    shareToken: text("share_token"),
    shareExpiresAt: text("share_expires_at"),
  },
  (table) => [
    index("checkpoints_owner_created_idx").on(table.ownerKey, table.createdAt),
    index("checkpoints_tenant_created_idx").on(table.tenantId, table.createdAt),
  ],
);

export type Checkpoint = typeof checkpoints.$inferSelect;

export const apiTokens = sqliteTable(
  "api_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    tokenPrefix: text("token_prefix").notNull(),
    ownerKey: text("owner_key").notNull(),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id"),
    label: text("label").notNull(),
    scopes: text("scopes")
      .notNull()
      .default("checkpoints:read checkpoints:write checkpoints:share"),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
    expiresAt: text("expires_at"),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    index("api_tokens_owner_idx").on(table.ownerKey),
    index("api_tokens_tenant_idx").on(table.tenantId),
  ],
);

export const deviceAuthorizations = sqliteTable(
  "device_authorizations",
  {
    deviceCodeHash: text("device_code_hash").primaryKey(),
    userCodeHash: text("user_code_hash").notNull(),
    clientName: text("client_name").notNull(),
    status: text("status").notNull().default("pending"),
    tenantId: text("tenant_id"),
    userId: text("user_id"),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    approvedAt: text("approved_at"),
    consumedAt: text("consumed_at"),
  },
  (table) => [
    uniqueIndex("device_authorizations_user_code_uidx").on(table.userCodeHash),
    index("device_authorizations_expires_idx").on(table.expiresAt),
  ],
);
