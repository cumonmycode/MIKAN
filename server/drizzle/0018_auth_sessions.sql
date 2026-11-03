-- Sign-in sessions: signing out ends one device, the owner sees and ends sessions (docs/API.md «Sessions»).

CREATE TABLE `auth_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`employee_id` integer NOT NULL,
	`device` text,
	`ip` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `auth_sessions_employee_idx` ON `auth_sessions` (`employee_id`,`revoked_at`);