ALTER TABLE `LoyaltySetting`
  ADD COLUMN `vipSpendThreshold` DOUBLE NOT NULL DEFAULT 50000,
  ADD COLUMN `inactiveCustomerDays` INTEGER NOT NULL DEFAULT 90,
  ADD COLUMN `topSpenderPercent` INTEGER NOT NULL DEFAULT 10;

ALTER TABLE `Customer`
  ADD COLUMN `lifetimeSpend` DOUBLE NOT NULL DEFAULT 0,
  ADD COLUMN `orderCount` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `lastOrderAt` DATETIME(3) NULL,
  ADD COLUMN `lastActivityAt` DATETIME(3) NULL;

CREATE INDEX `Customer_shopId_lifetimeSpend_idx` ON `Customer`(`shopId`, `lifetimeSpend`);
CREATE INDEX `Customer_shopId_lastActivityAt_idx` ON `Customer`(`shopId`, `lastActivityAt`);

CREATE TABLE `CustomerOrderMetric` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `customerId` INTEGER NOT NULL,
  `shopifyOrderId` VARCHAR(191) NOT NULL,
  `orderTotal` DOUBLE NOT NULL,
  `refundedTotal` DOUBLE NOT NULL DEFAULT 0,
  `orderedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `CustomerOrderMetric_customerId_shopifyOrderId_key`(`customerId`, `shopifyOrderId`),
  INDEX `CustomerOrderMetric_customerId_orderedAt_idx`(`customerId`, `orderedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CustomerRefundMetric` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `customerId` INTEGER NOT NULL,
  `customerOrderMetricId` INTEGER NULL,
  `shopifyRefundId` VARCHAR(191) NOT NULL,
  `refundAmount` DOUBLE NOT NULL,
  `refundedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `CustomerRefundMetric_customerId_shopifyRefundId_key`(`customerId`, `shopifyRefundId`),
  INDEX `CustomerRefundMetric_customerOrderMetricId_idx`(`customerOrderMetricId`),
  INDEX `CustomerRefundMetric_customerId_refundedAt_idx`(`customerId`, `refundedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CustomerOrderMetric`
  ADD CONSTRAINT `CustomerOrderMetric_customerId_fkey`
  FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `CustomerRefundMetric`
  ADD CONSTRAINT `CustomerRefundMetric_customerId_fkey`
  FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `CustomerRefundMetric`
  ADD CONSTRAINT `CustomerRefundMetric_customerOrderMetricId_fkey`
  FOREIGN KEY (`customerOrderMetricId`) REFERENCES `CustomerOrderMetric`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
