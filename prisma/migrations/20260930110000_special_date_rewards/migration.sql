ALTER TABLE `LoyaltySetting`
  ADD COLUMN `specialDateReward1Enabled` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `specialDateReward1Heading` VARCHAR(160) NOT NULL DEFAULT 'Special day reward 1',
  ADD COLUMN `specialDateReward1Date` VARCHAR(5) NOT NULL DEFAULT '01-01',
  ADD COLUMN `specialDateReward1Points` INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN `specialDateReward2Enabled` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `specialDateReward2Heading` VARCHAR(160) NOT NULL DEFAULT 'Special day reward 2',
  ADD COLUMN `specialDateReward2Date` VARCHAR(5) NOT NULL DEFAULT '12-31',
  ADD COLUMN `specialDateReward2Points` INTEGER NOT NULL DEFAULT 100;

ALTER TABLE `Customer`
  ADD COLUMN `specialDateReward1LastIssuedYear` INTEGER NULL,
  ADD COLUMN `specialDateReward1LastIssuedAt` DATETIME(3) NULL,
  ADD COLUMN `specialDateReward2LastIssuedYear` INTEGER NULL,
  ADD COLUMN `specialDateReward2LastIssuedAt` DATETIME(3) NULL;

ALTER TABLE `EmailNotificationSetting`
  ADD COLUMN `specialDateRewardEnabled` BOOLEAN NOT NULL DEFAULT true;
