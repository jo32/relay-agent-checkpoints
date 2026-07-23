CREATE TABLE `checkpoint_marketplace_index` (
	`checkpoint_id` text PRIMARY KEY NOT NULL,
	`public_title` text NOT NULL,
	`public_description` text NOT NULL,
	`agent_name` text NOT NULL,
	`agent_description` text NOT NULL,
	`agent_metadata_mode` text NOT NULL,
	`search_text` text NOT NULL,
	`quality_score` integer DEFAULT 0 NOT NULL,
	`size_bytes` integer NOT NULL,
	`format_version` integer NOT NULL,
	`published_at` text NOT NULL,
	FOREIGN KEY (`checkpoint_id`) REFERENCES `checkpoint_publications`(`checkpoint_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `checkpoint_marketplace_published_idx` ON `checkpoint_marketplace_index` (`published_at`);--> statement-breakpoint
CREATE INDEX `checkpoint_marketplace_recommended_idx` ON `checkpoint_marketplace_index` (`quality_score`,`published_at`);