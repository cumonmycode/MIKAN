CREATE TABLE `sale_refund_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`refund_id` integer NOT NULL,
	`sale_item_id` integer NOT NULL,
	`quantity` integer NOT NULL,
	`amount` integer NOT NULL,
	FOREIGN KEY (`refund_id`) REFERENCES `sale_refunds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sale_item_id`) REFERENCES `sale_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sale_refund_items_refund_idx` ON `sale_refund_items` (`refund_id`);--> statement-breakpoint
CREATE INDEX `sale_refund_items_item_idx` ON `sale_refund_items` (`sale_item_id`);--> statement-breakpoint
CREATE TABLE `sale_refunds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sale_id` integer NOT NULL,
	`amount` integer NOT NULL,
	`pay_cash` integer DEFAULT 0 NOT NULL,
	`pay_card` integer DEFAULT 0 NOT NULL,
	`pay_transfer` integer DEFAULT 0 NOT NULL,
	`pay_qr` integer DEFAULT 0 NOT NULL,
	`pay_deposit` integer DEFAULT 0 NOT NULL,
	`pay_bonus` integer DEFAULT 0 NOT NULL,
	`pay_certificate` integer DEFAULT 0 NOT NULL,
	`bonus_taken_back` integer DEFAULT 0 NOT NULL,
	`restock` integer NOT NULL,
	`reason` text NOT NULL,
	`employee_id` integer,
	`shift_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shift_id`) REFERENCES `cash_shifts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sale_refunds_sale_idx` ON `sale_refunds` (`sale_id`);--> statement-breakpoint
CREATE INDEX `sale_refunds_shift_idx` ON `sale_refunds` (`shift_id`);--> statement-breakpoint
CREATE INDEX `sale_refunds_created_idx` ON `sale_refunds` (`created_at`);--> statement-breakpoint
CREATE TABLE `stock_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`number` integer NOT NULL,
	`supplier` text,
	`note` text,
	`employee_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_deliveries_number_unique` ON `stock_deliveries` (`number`);--> statement-breakpoint
DROP INDEX `deposit_operations_sale_type_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `deposit_operations_sale_apply_unique` ON `deposit_operations` (`sale_id`) WHERE sale_id is not null and type = 'apply';--> statement-breakpoint
ALTER TABLE `sale_items` ADD `refunded_quantity` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sales` ADD `refunded_total` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sales` ADD `receipt_sent_at` integer;--> statement-breakpoint
ALTER TABLE `services` ADD `master_prices_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `stock_movements` ADD `delivery_id` integer REFERENCES stock_deliveries(id);--> statement-breakpoint
CREATE INDEX `stock_movements_delivery_idx` ON `stock_movements` (`delivery_id`);--> statement-breakpoint
-- Backfill: every sale refunded before partial refunds existed becomes one refund of everything.
INSERT INTO `sale_refunds` (`sale_id`, `amount`, `pay_cash`, `pay_card`, `pay_transfer`, `pay_qr`, `pay_deposit`, `pay_bonus`, `pay_certificate`, `bonus_taken_back`, `restock`, `reason`, `employee_id`, `shift_id`, `created_at`)
SELECT s.`id`, s.`total`, s.`pay_cash`, s.`pay_card`, s.`pay_transfer`, s.`pay_qr`, s.`pay_deposit`, s.`pay_bonus`, s.`pay_certificate`,
  COALESCE((SELECT -SUM(b.`amount`) FROM `bonus_operations` b WHERE b.`sale_id` = s.`id` AND b.`type` = 'reverse' AND b.`amount` < 0), 0),
  EXISTS (SELECT 1 FROM `stock_movements` m WHERE m.`sale_id` = s.`id` AND m.`type` = 'return'),
  COALESCE(s.`refund_reason`, ''), s.`refunded_by_id`, s.`refund_shift_id`, COALESCE(s.`refunded_at`, s.`created_at`)
FROM `sales` s WHERE s.`status` = 'refunded' ORDER BY s.`id`;
--> statement-breakpoint
-- A line returned what it was paid: a certificate line its nominal (never discounted), the others their total less
-- their share of the discount (rounded down; the rest of the rubles to the last of them, so the lines add up).
INSERT INTO `sale_refund_items` (`refund_id`, `sale_item_id`, `quantity`, `amount`)
SELECT r.`id`, i.`id`, i.`quantity`,
  CASE WHEN i.`certificate_id` IS NOT NULL OR i.`type` = 'certificate' THEN i.`total`
  ELSE COALESCE(i.`total` * (s.`total` - c.`nominal`) / NULLIF(s.`subtotal` - c.`nominal`, 0), 0) END
FROM `sale_refunds` r
  JOIN `sales` s ON s.`id` = r.`sale_id`
  JOIN `sale_items` i ON i.`sale_id` = r.`sale_id`
  JOIN (SELECT `sale_id`, COALESCE(SUM(CASE WHEN `certificate_id` IS NOT NULL OR `type` = 'certificate' THEN `total` ELSE 0 END), 0) AS `nominal`
        FROM `sale_items` GROUP BY `sale_id`) c ON c.`sale_id` = r.`sale_id`
ORDER BY r.`id`, i.`id`;
--> statement-breakpoint
UPDATE `sale_refund_items` SET `amount` = `amount` + (
  SELECT r.`amount` - SUM(x.`amount`) FROM `sale_refund_items` x JOIN `sale_refunds` r ON r.`id` = x.`refund_id`
  WHERE x.`refund_id` = `sale_refund_items`.`refund_id`
)
WHERE `id` IN (
  SELECT MAX(x.`id`) FROM `sale_refund_items` x JOIN `sale_items` i ON i.`id` = x.`sale_item_id`
  WHERE i.`certificate_id` IS NULL AND i.`type` != 'certificate' GROUP BY x.`refund_id`
);
--> statement-breakpoint
UPDATE `sale_items` SET `refunded_quantity` = `quantity` WHERE `sale_id` IN (SELECT `id` FROM `sales` WHERE `status` = 'refunded');
--> statement-breakpoint
UPDATE `sales` SET `refunded_total` = `total` WHERE `status` = 'refunded';
