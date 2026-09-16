ALTER TABLE `LoyaltySetting`
  ADD COLUMN `referralProgramEnabled` BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN `referralAdvocatePoints` INTEGER NOT NULL DEFAULT 200,
  ADD COLUMN `referralFriendPoints` INTEGER NOT NULL DEFAULT 100;

ALTER TABLE `Customer` ADD COLUMN `referralCode` VARCHAR(191) NULL;
CREATE UNIQUE INDEX `Customer_shopId_referralCode_key` ON `Customer`(`shopId`, `referralCode`);

CREATE TABLE `Referral` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `shopId` INTEGER NOT NULL,
  `advocateCustomerId` INTEGER NOT NULL,
  `referredCustomerId` INTEGER NULL,
  `referralCode` VARCHAR(191) NOT NULL,
  `visitorToken` VARCHAR(191) NOT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'clicked',
  `landingUrl` TEXT NULL,
  `qualifiedOrderId` VARCHAR(191) NULL,
  `clickedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `claimedAt` DATETIME(3) NULL,
  `qualifiedAt` DATETIME(3) NULL,
  `rewardedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `Referral_referredCustomerId_key`(`referredCustomerId`),
  UNIQUE INDEX `Referral_visitorToken_key`(`visitorToken`),
  UNIQUE INDEX `Referral_shopId_visitorToken_key`(`shopId`, `visitorToken`),
  INDEX `Referral_shopId_referralCode_status_idx`(`shopId`, `referralCode`, `status`),
  INDEX `Referral_advocateCustomerId_createdAt_idx`(`advocateCustomerId`, `createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `Referral_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `Referral_advocateCustomerId_fkey` FOREIGN KEY (`advocateCustomerId`) REFERENCES `Customer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `Referral_referredCustomerId_fkey` FOREIGN KEY (`referredCustomerId`) REFERENCES `Customer`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
