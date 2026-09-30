ALTER TABLE `LoyaltySetting`
  ADD COLUMN `specialDateRewardMinimumLeadDays` INTEGER NOT NULL DEFAULT 30;

ALTER TABLE `Customer`
  ADD COLUMN `specialDate1Month` INTEGER NULL,
  ADD COLUMN `specialDate1Day` INTEGER NULL,
  ADD COLUMN `specialDate1ProvidedAt` DATETIME(3) NULL,
  ADD COLUMN `specialDate1UpdatedAt` DATETIME(3) NULL,
  ADD COLUMN `specialDate2Month` INTEGER NULL,
  ADD COLUMN `specialDate2Day` INTEGER NULL,
  ADD COLUMN `specialDate2ProvidedAt` DATETIME(3) NULL,
  ADD COLUMN `specialDate2UpdatedAt` DATETIME(3) NULL;

CREATE INDEX `Customer_shopId_specialDate1Month_specialDate1Day_idx`
  ON `Customer`(`shopId`, `specialDate1Month`, `specialDate1Day`);

CREATE INDEX `Customer_shopId_specialDate2Month_specialDate2Day_idx`
  ON `Customer`(`shopId`, `specialDate2Month`, `specialDate2Day`);
