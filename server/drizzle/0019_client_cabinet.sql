-- Client package: masters' portfolio, the waitlist and the client cabinet sign-in links
-- (docs/API.md «Portfolio», «Waitlist», «Client cabinet»).

CREATE TABLE `client_access_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `client_access_tokens_token_hash_unique` ON `client_access_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `client_access_tokens_client_idx` ON `client_access_tokens` (`client_id`);--> statement-breakpoint
CREATE TABLE `portfolio_photos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`employee_id` integer NOT NULL,
	`service_id` integer,
	`image_url` text NOT NULL,
	`caption` text,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_by` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `portfolio_photos_employee_idx` ON `portfolio_photos` (`employee_id`,`sort`);--> statement-breakpoint
CREATE TABLE `waitlist_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` integer NOT NULL,
	`items` text NOT NULL,
	`master_id` integer,
	`date_from` text NOT NULL,
	`date_to` text NOT NULL,
	`status` text NOT NULL,
	`channel` text NOT NULL,
	`notified_at` integer,
	`appointment_id` integer,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`master_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `waitlist_entries_status_idx` ON `waitlist_entries` (`status`,`date_from`);