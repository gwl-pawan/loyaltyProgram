import prisma from "../db.server";
import { tryQueueAndDispatchLoyaltyEmail } from "./email-delivery.server";
import { LOYALTY_EMAIL_EVENTS } from "./email-notifications.server";
import { logError } from "./errors.server";
import {
  addExpiryPeriod,
  calculateExpiredPointLots,
  toDate,
} from "./points-expiry.shared";

export { addExpiryPeriod, calculateExpiredPointLots };

export const POINTS_EXPIRED_ACTIVITY_TYPE = "points_expired";
export const POINTS_EXPIRY_TRANSACTION_TYPE = "expiry";

const EXPIRY_IDEMPOTENCY_PREFIX = "points-expiry:";
const VALID_EXPIRY_UNITS = new Set(["days", "months"]);

function normalizeExpiryRule(settings) {
  const value = Number(settings?.pointsExpiryValue);
  const unit = VALID_EXPIRY_UNITS.has(settings?.pointsExpiryUnit)
    ? settings.pointsExpiryUnit
    : "months";

  return {
    enabled: settings?.pointsExpiryEnabled === true,
    value: Number.isInteger(value) && value > 0 ? value : 12,
    unit,
    applyToExisting: settings?.pointsExpiryApplyToExisting === true,
    startedAt: settings?.pointsExpiryStartedAt
      ? toDate(settings.pointsExpiryStartedAt)
      : null,
  };
}

async function initializeCreditExpiryDates(customerId, settings, now) {
  const rule = normalizeExpiryRule(settings);

  if (!rule.enabled) return 0;

  const unassignedCredits = await prisma.pointTransaction.findMany({
    where: {
      customerId,
      transactionType: "credit",
      points: { gt: 0 },
      expiresAt: null,
    },
    select: {
      id: true,
      createdAt: true,
    },
  });
  const startedAt = rule.startedAt || toDate(now);

  await Promise.all(
    unassignedCredits.map((credit) => {
      const earnedAt = toDate(credit.createdAt);
      const anchor =
        rule.applyToExisting || earnedAt >= startedAt ? earnedAt : startedAt;

      return prisma.pointTransaction.updateMany({
        where: {
          id: credit.id,
          expiresAt: null,
        },
        data: {
          expiresAt: addExpiryPeriod(anchor, rule.value, rule.unit),
        },
      });
    }),
  );

  return unassignedCredits.length;
}

async function finalizeExpiredLot(customerId, lot, now) {
  const idempotencyKey = `${EXPIRY_IDEMPOTENCY_PREFIX}${lot.sourceTransactionId}`;

  try {
    return await prisma.$transaction(async (tx) => {
      const marked = await tx.pointTransaction.updateMany({
        where: {
          id: lot.sourceTransactionId,
          customerId,
          transactionType: "credit",
          expiredAt: null,
        },
        data: {
          expiredAt: now,
        },
      });

      if (marked.count === 0) return null;

      const customer = await tx.customer.findUnique({
        where: { id: customerId },
        select: { loyaltyPoints: true },
      });
      const availablePoints = Math.max(0, customer?.loyaltyPoints || 0);
      const pointsToExpire = Math.min(lot.points, availablePoints);

      if (pointsToExpire <= 0) {
        return {
          pointsExpired: 0,
          balance: availablePoints,
          sourceTransactionId: lot.sourceTransactionId,
        };
      }

      const updatedCustomer = await tx.customer.updateMany({
        where: {
          id: customerId,
          loyaltyPoints: { gte: pointsToExpire },
        },
        data: {
          loyaltyPoints: { decrement: pointsToExpire },
        },
      });

      if (updatedCustomer.count === 0) {
        const error = new Error("Customer points changed during expiry");
        error.code = "POINTS_BALANCE_CHANGED";
        throw error;
      }

      const balance = availablePoints - pointsToExpire;

      await tx.pointTransaction.create({
        data: {
          customerId,
          points: pointsToExpire,
          transactionType: POINTS_EXPIRY_TRANSACTION_TYPE,
          reason: `Points expired from earning transaction ${lot.sourceTransactionId}`,
          sourceTransactionId: lot.sourceTransactionId,
          idempotencyKey,
        },
      });

      await tx.rewardActivityLog.create({
        data: {
          customerId,
          activityType: POINTS_EXPIRED_ACTIVITY_TYPE,
          message: `${pointsToExpire.toLocaleString("en")} points expired.`,
          metadata: {
            pointsExpired: pointsToExpire,
            pointsBalanceAfter: balance,
            sourceTransactionId: lot.sourceTransactionId,
            earnedAt: lot.earnedAt,
            expiresAt: lot.expiresAt,
          },
        },
      });

      return {
        pointsExpired: pointsToExpire,
        balance,
        sourceTransactionId: lot.sourceTransactionId,
      };
    });
  } catch (error) {
    if (error?.code === "P2002") return null;
    throw error;
  }
}

export async function expireCustomerPoints(
  customerId,
  { now = new Date() } = {},
) {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: {
      id: true,
      name: true,
      email: true,
      shopifyCustomerId: true,
      loyaltyPoints: true,
      shop: {
        select: {
          id: true,
          shopDomain: true,
          loyaltySetting: true,
        },
      },
    },
  });
  const settings = customer?.shop?.loyaltySetting;
  const rule = normalizeExpiryRule(settings);

  if (!customer || !rule.enabled) {
    return {
      customerId,
      pointsExpired: 0,
      balance: customer?.loyaltyPoints || 0,
      processedLots: 0,
    };
  }

  await initializeCreditExpiryDates(customerId, settings, now);

  const transactions = await prisma.pointTransaction.findMany({
    where: {
      customerId,
      createdAt: { lte: now },
    },
    select: {
      id: true,
      points: true,
      transactionType: true,
      createdAt: true,
      expiresAt: true,
      expiredAt: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const expiredLots = calculateExpiredPointLots(transactions, now);
  const results = [];

  for (const lot of expiredLots) {
    try {
      const result = await finalizeExpiredLot(customerId, lot, now);
      if (result) {
        results.push(result);

        if (result.pointsExpired > 0 && customer.email) {
          await tryQueueAndDispatchLoyaltyEmail({
            shopId: customer.shop.id,
            customerId: customer.id,
            eventType: LOYALTY_EMAIL_EVENTS.POINTS_EXPIRED,
            recipientEmail: customer.email,
            recipientName: customer.name,
            subject: `${result.pointsExpired} loyalty points expired`,
            payload: {
              pointsExpired: result.pointsExpired,
              pointsBalanceAfter: result.balance,
              sourceTransactionId: result.sourceTransactionId,
              shopDomain: customer.shop.shopDomain,
              customerId: customer.shopifyCustomerId,
              expiredAt: now,
              earnedAt: lot.earnedAt,
              expiresAt: lot.expiresAt,
            },
            idempotencyKey: `points-expired:${customer.id}:${result.sourceTransactionId}`,
          });
        }
      }
    } catch (error) {
      if (error?.code !== "POINTS_BALANCE_CHANGED") throw error;
      logError("points-expiry:balance-changed", error, { customerId });
    }
  }

  const refreshedCustomer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { loyaltyPoints: true },
  });

  return {
    customerId,
    pointsExpired: results.reduce(
      (total, result) => total + result.pointsExpired,
      0,
    ),
    balance: refreshedCustomer?.loyaltyPoints || 0,
    processedLots: results.length,
  };
}

export async function tryExpireCustomerPoints(customerId, options) {
  try {
    return await expireCustomerPoints(customerId, options);
  } catch (error) {
    logError("points-expiry:customer", error, { customerId });
    return null;
  }
}

export async function processPointsExpiry({
  shopId,
  shopDomain,
  customerId,
  now = new Date(),
  batchSize = 100,
} = {}) {
  const normalizedBatchSize = Math.min(
    500,
    Math.max(1, Number(batchSize) || 100),
  );
  const shops = await prisma.shop.findMany({
    where: {
      ...(shopId ? { id: Number(shopId) } : {}),
      ...(shopDomain ? { shopDomain } : {}),
      loyaltySetting: {
        pointsExpiryEnabled: true,
      },
    },
    select: {
      id: true,
      shopDomain: true,
      customers: {
        where: {
          ...(customerId ? { id: Number(customerId) } : {}),
          transactions: {
            some: {
              transactionType: "credit",
              points: { gt: 0 },
              expiredAt: null,
              OR: [{ expiresAt: null }, { expiresAt: { lte: now } }],
            },
          },
        },
        select: { id: true },
        orderBy: { id: "asc" },
        take: normalizedBatchSize,
      },
    },
  });
  const summary = {
    shopsProcessed: 0,
    customersProcessed: 0,
    lotsProcessed: 0,
    pointsExpired: 0,
    failures: [],
    results: [],
  };

  for (const shop of shops) {
    for (const customer of shop.customers) {
      try {
        const result = await expireCustomerPoints(customer.id, { now });
        summary.customersProcessed += 1;
        summary.lotsProcessed += result.processedLots;
        summary.pointsExpired += result.pointsExpired;

        if (result.pointsExpired > 0) {
          summary.results.push({
            shop: shop.shopDomain,
            ...result,
          });
        }
      } catch (error) {
        logError("points-expiry:batch-customer", error, {
          shop: shop.shopDomain,
          customerId: customer.id,
        });
        summary.failures.push({
          shop: shop.shopDomain,
          customerId: customer.id,
          message: error?.message || "Point expiry failed",
        });
      }
    }

    await prisma.loyaltySetting.updateMany({
      where: { shopId: shop.id },
      data: { pointsExpiryLastRunAt: now },
    });
    summary.shopsProcessed += 1;
  }

  return summary;
}
