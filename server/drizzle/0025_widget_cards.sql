CREATE TABLE `widget_cards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`message_id` integer NOT NULL,
	`appointment_id` integer NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`chat_data` text NOT NULL,
	`pressed` text,
	`pressed_at` integer,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `widget_cards_message_unique` ON `widget_cards` (`chat_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `widget_cards_active_idx` ON `widget_cards` (`active`,`appointment_id`);