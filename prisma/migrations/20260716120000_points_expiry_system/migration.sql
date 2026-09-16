ALTER TABLE `LoyaltySetting`
  ADD COLUMN `pointsExpiryEnabled` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `pointsExpiryValue` INTEGER NOT NULL DEFAULT 12,
  ADD COLUMN `pointsExpiryUnit` VARCHAR(191) NOT NULL DEFAULT 'months',
  ADD COLUMN `pointsExpiryApplyToExisting` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `pointsExpiryStartedAt` DATETIME(3) NULL,
  ADD COLUMN `pointsExpiryLastRunAt` DATETIME(3) NULL;

ALTER TABLE `PointTransaction`
  ADD COLUMN `expiresAt` DATETIME(3) NULL,
  ADD COLUMN `expiredAt` DATETIME(3) NULL,
  ADD COLUMN `sourceTransactionId` INTEGER NULL,
  ADD COLUMN `idempotencyKey` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `PointTransaction_idempotencyKey_key`
  ON `PointTransaction`(`idempotencyKey`);

CREATE INDEX `PointTransaction_customerId_createdAt_idx`
  ON `PointTransaction`(`customerId`, `createdAt`);

CREATE INDEX `PointTransaction_transactionType_expiresAt_idx`
  ON `PointTransaction`(`transactionType`, `expiresAt`);

CREATE INDEX `PointTransaction_sourceTransactionId_idx`
  ON `PointTransaction`(`sourceTransactionId`);
