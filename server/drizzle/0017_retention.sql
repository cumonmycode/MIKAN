-- Client retention: loyalty bonuses, gift certificates, Telegram campaigns, birthday and win-back messages
-- (docs/API.md «Loyalty bonuses», «Gift certificates», «Campaigns», «Birthday and win-back»).

CREATE TABLE `bonus_operations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` integer NOT NULL,
	`type` text NOT NULL,
	`amount` integer NOT NULL,
	`remaining` integer DEFAULT 0 NOT NULL,
	`expires_at` integer,
	`sale_id` integer,
	`note` text,
	`employee_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `bonus_operations_client_idx` ON `bonus_operations` (`client_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `bonus_operations_expiry_idx` ON `bonus_operations` (`expires_at`);--> statement-breakpoint
CREATE TABLE `campaign_recipients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaign_id` integer NOT NULL,
	`client_id` integer NOT NULL,
	`chat_id` integer NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`sent_at` integer,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_recipients_unique` ON `campaign_recipients` (`campaign_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `campaign_recipients_status_idx` ON `campaign_recipients` (`campaign_id`,`status`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`text` text NOT NULL,
	`image_url` text,
	`button` text,
	`segment` text NOT NULL,
	`status` text NOT NULL,
	`scheduled_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`created_by` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `campaigns_status_idx` ON `campaigns` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE TABLE `certificate_operations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`certificate_id` integer NOT NULL,
	`type` text NOT NULL,
	`amount` integer NOT NULL,
	`sale_id` integer,
	`employee_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`certificate_id`) REFERENCES `gift_certificates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `certificate_operations_certificate_idx` ON `certificate_operations` (`certificate_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `gift_certificates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`amount` integer NOT NULL,
	`balance` integer NOT NULL,
	`status` text NOT NULL,
	`expires_at` integer,
	`buyer_client_id` integer,
	`recipient_name` text,
	`note` text,
	`sale_id` integer,
	`created_by` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`buyer_client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gift_certificates_code_unique` ON `gift_certificates` (`code`);--> statement-breakpoint
CREATE INDEX `gift_certificates_status_idx` ON `gift_certificates` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `retention_sends` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` integer NOT NULL,
	`kind` text NOT NULL,
	`period_key` text NOT NULL,
	`sent_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `retention_sends_unique` ON `retention_sends` (`client_id`,`kind`,`period_key`);--> statement-breakpoint
ALTER TABLE `clients` ADD `marketing_opt_out` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sale_items` ADD `certificate_id` integer;--> statement-breakpoint
ALTER TABLE `sales` ADD `pay_bonus` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sales` ADD `pay_certificate` integer DEFAULT 0 NOT NULL;