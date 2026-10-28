-- Post-visit follow-ups of the bot: services.healing_check_days («Как заживает?» that many days after the visit) and
-- services.jewelry_change_weeks (a jewelry change suggested that many weeks after it); NULL = never.
-- Fresh procedures (a new piercing or tattoo) get the healing check a week after the visit.
ALTER TABLE `services` ADD `healing_check_days` integer;--> statement-breakpoint
ALTER TABLE `services` ADD `jewelry_change_weeks` integer;--> statement-breakpoint
UPDATE `services` SET `healing_check_days` = 7 WHERE `fresh_procedure` = 1;
