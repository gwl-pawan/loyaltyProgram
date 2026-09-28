ALTER TABLE `LoyaltySetting`
  ADD COLUMN `birthdayRewardEnabled` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `birthdayRewardPoints` INTEGER NOT NULL DEFAULT 250,
  ADD COLUMN `birthdayRewardMinimumLeadDays` INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN `birthdayRewardTimeZone` VARCHAR(100) NOT NULL DEFAULT 'UTC';

ALTER TABLE `Customer`
  ADD COLUMN `birthMonth` INTEGER NULL,
  ADD COLUMN `birthDay` INTEGER NULL,
  ADD COLUMN `birthdayProvidedAt` DATETIME(3) NULL,
  ADD COLUMN `birthdayUpdatedAt` DATETIME(3) NULL,
  ADD COLUMN `birthdayRewardLastIssuedYear` INTEGER NULL,
  ADD COLUMN `birthdayRewardLastIssuedAt` DATETIME(3) NULL;

ALTER TABLE `EmailNotificationSetting`
  ADD COLUMN `birthdayRewardEnabled` BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX `Customer_shopId_birthMonth_birthDay_idx`
  ON `Customer`(`shopId`, `birthMonth`, `birthDay`);
