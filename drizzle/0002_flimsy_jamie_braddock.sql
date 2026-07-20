ALTER TABLE `checkpoints` ADD `encryption_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `checkpoints` ADD `cipher` text DEFAULT 'none' NOT NULL;