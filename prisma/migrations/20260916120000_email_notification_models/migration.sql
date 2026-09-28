CREATE TABLE `EmailNotificationSetting` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `shopId` INTEGER NOT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `signupBonusEnabled` BOOLEAN NOT NULL DEFAULT true,
  `orderPointsEnabled` BOOLEAN NOT NULL DEFAULT true,
  `rewardCreatedEnabled` BOOLEAN NOT NULL DEFAULT true,
  `rewardAppliedEnabled` BOOLEAN NOT NULL DEFAULT true,
  `refundEnabled` BOOLEAN NOT NULL DEFAULT true,
  `pointsExpiryEnabled` BOOLEAN NOT NULL DEFAULT true,
  `referralEnabled` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `EmailNotificationSetting_shopId_key`(`shopId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `EmailNotification` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `shopId` INTEGER NOT NULL,
  `customerId` INTEGER NULL,
  `eventType` VARCHAR(191) NOT NULL,
  `recipientEmail` VARCHAR(191) NOT NULL,
  `recipientName` VARCHAR(191) NULL,
  `subject` VARCHAR(191) NOT NULL,
  `payload` JSON NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
  `provider` VARCHAR(191) NULL,
  `providerId` VARCHAR(191) NULL,
  `errorMessage` TEXT NULL,
  `idempotencyKey` VARCHAR(191) NOT NULL,
  `sentAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `EmailNotification_idempotencyKey_key`(`idempotencyKey`),
  INDEX `EmailNotification_shopId_createdAt_idx`(`shopId`, `createdAt`),
  INDEX `EmailNotification_customerId_createdAt_idx`(`customerId`, `createdAt`),
  INDEX `EmailNotification_eventType_idx`(`eventType`),
  INDEX `EmailNotification_status_createdAt_idx`(`status`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `EmailNotificationSetting`
  ADD CONSTRAINT `EmailNotificationSetting_shopId_fkey`
  FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `EmailNotification`
  ADD CONSTRAINT `EmailNotification_shopId_fkey`
  FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `EmailNotification`
  ADD CONSTRAINT `EmailNotification_customerId_fkey`
  FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
