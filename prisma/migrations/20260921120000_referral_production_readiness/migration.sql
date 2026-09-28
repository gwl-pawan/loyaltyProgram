ALTER TABLE `LoyaltySetting`
  ADD COLUMN `referralAttributionDays` INTEGER NOT NULL DEFAULT 30;

ALTER TABLE `Referral`
  ADD COLUMN `expiresAt` DATETIME(3) NULL;

DROP INDEX `Referral_visitorToken_key` ON `Referral`;

CREATE INDEX `Referral_shopId_status_expiresAt_idx`
  ON `Referral`(`shopId`, `status`, `expiresAt`);
