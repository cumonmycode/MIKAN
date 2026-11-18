CREATE TABLE `studio_expenses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`amount` integer NOT NULL,
	`repeat` text NOT NULL,
	`date` text NOT NULL,
	`end_date` text,
	`note` text,
	`created_by` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `studio_expenses_date_idx` ON `studio_expenses` (`date`);