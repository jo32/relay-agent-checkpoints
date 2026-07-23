CREATE TABLE `checkpoint_publications` (
	`checkpoint_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`object_key` text NOT NULL,
	`checksum` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`format_version` integer DEFAULT 1 NOT NULL,
	`source_ciphertext_checksum` text,
	`public_title` text NOT NULL,
	`public_description` text NOT NULL,
	`published_at` text NOT NULL,
	`published_by_user_id` text,
	FOREIGN KEY (`checkpoint_id`) REFERENCES `checkpoints`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkpoint_publications_object_key_uidx` ON `checkpoint_publications` (`object_key`);--> statement-breakpoint
CREATE INDEX `checkpoint_publications_tenant_published_idx` ON `checkpoint_publications` (`tenant_id`,`published_at`);--> statement-breakpoint
ALTER TABLE `device_authorizations` ADD `requested_scopes` text DEFAULT 'checkpoints:read checkpoints:write checkpoints:share' NOT NULL;