ALTER TABLE `checkpoints` ADD `agent_name` text DEFAULT 'Mysterious Marmot' NOT NULL;--> statement-breakpoint
ALTER TABLE `checkpoints` ADD `agent_description` text DEFAULT 'A privacy-minded helper that summarized progress and prepared an encrypted workspace handoff.' NOT NULL;--> statement-breakpoint
ALTER TABLE `checkpoints` ADD `agent_metadata_mode` text DEFAULT 'pseudonymous' NOT NULL;