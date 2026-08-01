ALTER TABLE `checkpoint_marketplace_index` ADD `artifact_type` text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE `checkpoint_marketplace_index` ADD `skill_name` text;--> statement-breakpoint
ALTER TABLE `checkpoint_marketplace_index` ADD `skill_description` text;--> statement-breakpoint
CREATE INDEX `checkpoint_marketplace_artifact_idx` ON `checkpoint_marketplace_index` (`artifact_type`,`published_at`);--> statement-breakpoint
ALTER TABLE `checkpoints` ADD `artifact_type` text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE `checkpoints` ADD `skill_name` text;--> statement-breakpoint
ALTER TABLE `checkpoints` ADD `skill_description` text;