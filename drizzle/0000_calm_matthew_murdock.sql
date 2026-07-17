CREATE TABLE `api_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`token_prefix` text NOT NULL,
	`owner_key` text NOT NULL,
	`label` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text
);
--> statement-breakpoint
CREATE INDEX `api_tokens_owner_idx` ON `api_tokens` (`owner_key`);--> statement-breakpoint
CREATE TABLE `checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_key` text NOT NULL,
	`workspace_name` text NOT NULL,
	`label` text NOT NULL,
	`source_agent` text NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`created_at` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`file_count` integer NOT NULL,
	`excluded_count` integer NOT NULL,
	`parent_id` text,
	`handoff` text DEFAULT '' NOT NULL,
	`object_key` text NOT NULL,
	`checksum` text NOT NULL,
	`share_token` text,
	`share_expires_at` text
);
--> statement-breakpoint
CREATE INDEX `checkpoints_owner_created_idx` ON `checkpoints` (`owner_key`,`created_at`);