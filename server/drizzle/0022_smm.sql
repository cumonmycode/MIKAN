CREATE TABLE `smm_account_stats` (
	`account_id` text NOT NULL,
	`day` text NOT NULL,
	`followers` integer,
	`views` integer,
	`posts` integer,
	`engagement` real,
	`reach` integer,
	`new_followers` integer,
	`source` text DEFAULT 'auto' NOT NULL,
	`raw_json` text DEFAULT '{}' NOT NULL,
	PRIMARY KEY(`account_id`, `day`),
	FOREIGN KEY (`account_id`) REFERENCES `smm_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `smm_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`profile` text NOT NULL,
	`platform` text NOT NULL,
	`title` text NOT NULL,
	`url` text,
	`handle` text,
	`tg_chat_id` text,
	`can_publish` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`followers` integer,
	`stats_json` text DEFAULT '{}' NOT NULL,
	`stats_at` integer,
	`stats_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `smm_accounts_profile_idx` ON `smm_accounts` (`profile`);--> statement-breakpoint
CREATE TABLE `smm_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` text,
	`plan_id` text,
	`author_id` integer,
	`author_name` text,
	`role` text DEFAULT 'staff' NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `smm_posts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `smm_plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `smm_comments_post_idx` ON `smm_comments` (`post_id`,`id`);--> statement-breakpoint
CREATE INDEX `smm_comments_plan_idx` ON `smm_comments` (`plan_id`,`id`);--> statement-breakpoint
CREATE TABLE `smm_dates` (
	`id` text PRIMARY KEY NOT NULL,
	`profile` text NOT NULL,
	`day` text NOT NULL,
	`title` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `smm_dates_profile_idx` ON `smm_dates` (`profile`);--> statement-breakpoint
CREATE TABLE `smm_knowledge` (
	`profile` text NOT NULL,
	`key` text NOT NULL,
	`owner_text` text DEFAULT '' NOT NULL,
	`ai_text` text DEFAULT '' NOT NULL,
	`meta_json` text DEFAULT '{}' NOT NULL,
	`progress_json` text,
	`error` text,
	`ai_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`profile`, `key`)
);
--> statement-breakpoint
CREATE TABLE `smm_library` (
	`profile` text NOT NULL,
	`drive_id` text NOT NULL,
	`folder_id` text,
	`path` text DEFAULT '' NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`mime` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'photo' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '' NOT NULL,
	`people` integer,
	`quality` integer,
	`orientation` text,
	`used_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` integer,
	`described_at` integer,
	`seen_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`profile`, `drive_id`)
);
--> statement-breakpoint
CREATE INDEX `smm_library_folder_idx` ON `smm_library` (`profile`,`folder_id`);--> statement-breakpoint
CREATE TABLE `smm_library_folders` (
	`profile` text NOT NULL,
	`drive_id` text NOT NULL,
	`parent_id` text,
	`path` text DEFAULT '' NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'photos' NOT NULL,
	`about` text DEFAULT '' NOT NULL,
	`files` integer DEFAULT 0 NOT NULL,
	`seen_at` integer NOT NULL,
	PRIMARY KEY(`profile`, `drive_id`)
);
--> statement-breakpoint
CREATE TABLE `smm_media` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`kind` text DEFAULT 'image' NOT NULL,
	`source` text DEFAULT 'ai' NOT NULL,
	`status` text DEFAULT 'done' NOT NULL,
	`url` text,
	`aspect` text,
	`prompt` text,
	`model` text,
	`polza_id` text,
	`cost_rub` real DEFAULT 0 NOT NULL,
	`error` text,
	`selected` integer DEFAULT true NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `smm_posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `smm_media_post_idx` ON `smm_media` (`post_id`,`sort`);--> statement-breakpoint
CREATE INDEX `smm_media_status_idx` ON `smm_media` (`status`);--> statement-breakpoint
CREATE TABLE `smm_memory` (
	`id` text PRIMARY KEY NOT NULL,
	`profile` text NOT NULL,
	`kind` text DEFAULT 'rule' NOT NULL,
	`text` text NOT NULL,
	`source` text DEFAULT 'staff' NOT NULL,
	`author_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `smm_memory_profile_idx` ON `smm_memory` (`profile`);--> statement-breakpoint
CREATE TABLE `smm_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`profile` text NOT NULL,
	`month` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`goals_json` text DEFAULT '[]' NOT NULL,
	`pillars_json` text DEFAULT '[]' NOT NULL,
	`busy` text,
	`busy_at` integer,
	`progress_json` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `smm_plans_profile_month_idx` ON `smm_plans` (`profile`,`month`);--> statement-breakpoint
CREATE TABLE `smm_platform_posts` (
	`account_id` text NOT NULL,
	`ext_id` text NOT NULL,
	`platform` text NOT NULL,
	`format` text DEFAULT 'post' NOT NULL,
	`published_at` integer,
	`caption` text DEFAULT '' NOT NULL,
	`permalink` text,
	`thumb_url` text,
	`views` integer,
	`reach` integer,
	`likes` integer,
	`comments` integer,
	`shares` integer,
	`saves` integer,
	`reactions` integer,
	`interactions` integer,
	`post_id` text,
	`stats_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `ext_id`),
	FOREIGN KEY (`account_id`) REFERENCES `smm_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`post_id`) REFERENCES `smm_posts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `smm_platform_posts_at_idx` ON `smm_platform_posts` (`account_id`,`published_at`);--> statement-breakpoint
CREATE TABLE `smm_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`profile` text NOT NULL,
	`plan_id` text,
	`account_id` text,
	`platform` text NOT NULL,
	`format` text DEFAULT 'post' NOT NULL,
	`status` text DEFAULT 'idea' NOT NULL,
	`publish_at` integer,
	`topic` text NOT NULL,
	`pillar` text,
	`direction` text,
	`brief` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`visual` text DEFAULT '' NOT NULL,
	`script_json` text,
	`assignee_id` integer,
	`approved_by` integer,
	`approved_at` integer,
	`review_sent_at` integer,
	`handoff_at` integer,
	`reminded_at` integer,
	`remind_count` integer DEFAULT 0 NOT NULL,
	`published_at` integer,
	`published_url` text,
	`tg_message_id` integer,
	`ext_id` text,
	`stats_json` text DEFAULT '{}' NOT NULL,
	`stats_at` integer,
	`busy` text,
	`busy_at` integer,
	`progress_json` text,
	`forecast_json` text,
	`error` text,
	`created_by` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `smm_plans`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`account_id`) REFERENCES `smm_accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`assignee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`approved_by`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `smm_posts_profile_publish_idx` ON `smm_posts` (`profile`,`publish_at`);--> statement-breakpoint
CREATE INDEX `smm_posts_status_idx` ON `smm_posts` (`status`,`publish_at`);--> statement-breakpoint
CREATE INDEX `smm_posts_plan_idx` ON `smm_posts` (`plan_id`);--> statement-breakpoint
CREATE TABLE `smm_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`profile` text NOT NULL,
	`period_from` text NOT NULL,
	`period_to` text NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`metrics_json` text DEFAULT '[]' NOT NULL,
	`recommendations_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `smm_reports_profile_idx` ON `smm_reports` (`profile`,`created_at`);--> statement-breakpoint
CREATE TABLE `smm_spend` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile` text NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`model` text NOT NULL,
	`cost_rub` real DEFAULT 0 NOT NULL,
	`note` text
);
--> statement-breakpoint
CREATE INDEX `smm_spend_profile_at_idx` ON `smm_spend` (`profile`,`at`);--> statement-breakpoint
CREATE TABLE `smm_zone_photos` (
	`id` text PRIMARY KEY NOT NULL,
	`zone_id` text NOT NULL,
	`url` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`zone_id`) REFERENCES `smm_zones`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `smm_zone_photos_zone_idx` ON `smm_zone_photos` (`zone_id`,`sort`);--> statement-breakpoint
CREATE TABLE `smm_zones` (
	`id` text PRIMARY KEY NOT NULL,
	`profile` text NOT NULL,
	`title` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`owner_text` text DEFAULT '' NOT NULL,
	`ai_text` text DEFAULT '' NOT NULL,
	`anchor` text DEFAULT '' NOT NULL,
	`progress_json` text,
	`error` text,
	`ai_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `smm_zones_profile_idx` ON `smm_zones` (`profile`,`sort`);