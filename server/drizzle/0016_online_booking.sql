-- «Все каналы записи»: online bookings (channel, settlement state, payment hold, the client page token) and staff
-- push devices (docs/API.md «Online booking», «Push notifications»).

CREATE TABLE `push_devices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`employee_id` integer NOT NULL,
	`token` text NOT NULL,
	`environment` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_devices_token_unique` ON `push_devices` (`token`);--> statement-breakpoint
CREATE INDEX `push_devices_employee_idx` ON `push_devices` (`employee_id`);--> statement-breakpoint
ALTER TABLE `appointments` ADD `channel` text DEFAULT 'app' NOT NULL;--> statement-breakpoint
ALTER TABLE `appointments` ADD `online_state` text;--> statement-breakpoint
ALTER TABLE `appointments` ADD `hold_until` integer;--> statement-breakpoint
ALTER TABLE `appointments` ADD `public_token` text;--> statement-breakpoint
CREATE UNIQUE INDEX `appointments_public_token_unique` ON `appointments` (`public_token`);--> statement-breakpoint
CREATE INDEX `appointments_online_idx` ON `appointments` (`online_state`);