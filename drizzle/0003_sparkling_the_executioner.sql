CREATE TABLE `device_authorizations` (
	`device_code_hash` text PRIMARY KEY NOT NULL,
	`user_code_hash` text NOT NULL,
	`client_name` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`tenant_id` text,
	`user_id` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`approved_at` text,
	`consumed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_authorizations_user_code_uidx` ON `device_authorizations` (`user_code_hash`);--> statement-breakpoint
CREATE INDEX `device_authorizations_expires_idx` ON `device_authorizations` (`expires_at`);