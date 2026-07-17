import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const checkpoints = sqliteTable(
  "checkpoints",
  {
    id: text("id").primaryKey(),
    ownerKey: text("owner_key").notNull(),
    workspaceName: text("workspace_name").notNull(),
    label: text("label").notNull(),
    sourceAgent: text("source_agent").notNull(),
    status: text("status").notNull().default("ready"),
    createdAt: text("created_at").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    fileCount: integer("file_count").notNull(),
    excludedCount: integer("excluded_count").notNull(),
    parentId: text("parent_id"),
    handoff: text("handoff").notNull().default(""),
    objectKey: text("object_key").notNull(),
    checksum: text("checksum").notNull(),
    shareToken: text("share_token"),
    shareExpiresAt: text("share_expires_at"),
  },
  (table) => [
    index("checkpoints_owner_created_idx").on(table.ownerKey, table.createdAt),
  ],
);

export type Checkpoint = typeof checkpoints.$inferSelect;

export const apiTokens = sqliteTable(
  "api_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    tokenPrefix: text("token_prefix").notNull(),
    ownerKey: text("owner_key").notNull(),
    label: text("label").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
  },
  (table) => [index("api_tokens_owner_idx").on(table.ownerKey)],
);
