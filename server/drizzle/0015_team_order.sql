-- «Порядок в команде»: employee roles and own weekly schedules, schedule exceptions, the action log, pay rules and
-- payroll adjustments (docs/API.md «Roles», «Audit log», «Work schedules», «Payroll»).

CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`employee_id` integer,
	`source` text NOT NULL,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` integer,
	`summary` text NOT NULL,
	`changes` text,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_log_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE INDEX `audit_log_entity_idx` ON `audit_log` (`entity`,`entity_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_log_employee_idx` ON `audit_log` (`employee_id`,`at`);--> statement-breakpoint
CREATE TABLE `pay_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`employee_id` integer NOT NULL,
	`effective_from` text NOT NULL,
	`rules` text NOT NULL,
	`created_by` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pay_rules_employee_from_unique` ON `pay_rules` (`employee_id`,`effective_from`);--> statement-breakpoint
CREATE TABLE `payroll_adjustments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`employee_id` integer NOT NULL,
	`date` text NOT NULL,
	`kind` text NOT NULL,
	`amount` integer NOT NULL,
	`note` text,
	`cash_operation_id` integer,
	`created_by` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cash_operation_id`) REFERENCES `cash_operations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `payroll_adjustments_employee_idx` ON `payroll_adjustments` (`employee_id`,`date`);--> statement-breakpoint
CREATE TABLE `schedule_days` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`employee_id` integer NOT NULL,
	`date` text NOT NULL,
	`off` integer DEFAULT false NOT NULL,
	`start` text,
	`end` text,
	`breaks` text DEFAULT '[]' NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_days_employee_date_unique` ON `schedule_days` (`employee_id`,`date`);--> statement-breakpoint
ALTER TABLE `employees` ADD `role` text DEFAULT 'admin' NOT NULL;--> statement-breakpoint
ALTER TABLE `employees` ADD `weekly_schedule` text;--> statement-breakpoint
-- Roles of existing staff: the first account (created at install) owns the studio, masters become `master`, the
-- rest keep `admin`. The owner adjusts them in the app.
UPDATE `employees` SET `role` = 'owner' WHERE `id` = (SELECT min(`id`) FROM `employees`);--> statement-breakpoint
UPDATE `employees` SET `role` = 'master' WHERE `role` = 'admin' AND `is_master` = 1;
