-- The bot asks a client for the birthday once (docs/API.md «Collecting birthdays»).

ALTER TABLE `clients` ADD `birthday_asked_at` integer;