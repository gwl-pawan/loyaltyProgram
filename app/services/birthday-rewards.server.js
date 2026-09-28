import prisma from "../db.server";
import { tryQueueAndDispatchLoyaltyEmail } from "./email-delivery.server";
import { LOYALTY_EMAIL_EVENTS } from "./email-notifications.server";
import { findOrCreateShop } from "./loyalty-settings.server";
import {
  BIRTHDAY_REWARD_GRACE_DAYS,
  formatBirthday,
  getBirthdaySubmissionStatus,
  getBirthdayDateForYear,
  getBirthdayRewardDueYear,
  getDatePartsInTimeZone,
  normalizeBirthday,
} from "./birthday-rewards.shared";

export const BIRTHDAY_REWARD_ACTIVITY_TYPE = "birthday_rewarded";
export const BIRTHDAY_REWARD_TRANSACTION_TYPE = "credit";

function birthdayLockedError() {
  const error = new Error(
    "Birthday is locked after the first save. Contact store support to correct it.",
  );
  error.status = 409;
  return error;
}

function publicBirthdayProfile(customer, settings, now = new Date()) {
  const timeZone = settings?.birthdayRewardTimeZone || "UTC";
  const today = getDatePartsInTimeZone(now, timeZone);
  const birthday = normalizeBirthday({
    month: customer?.birthMonth,
    day: customer?.birthDay,
  });
  const entryLocked = Boolean(birthday || customer?.birthdayProvidedAt);
  let nextRewardDate = null;

  if (birthday) {
    let next = getBirthdayDateForYear(birthday.month, birthday.day, today.year);
    const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
    if (
      next.getTime() < todayUtc ||
      customer?.birthdayRewardLastIssuedYear === today.year
    ) {
      next = getBirthdayDateForYear(
        birthday.month,
        birthday.day,
        today.year + 1,
      );
    }
    nextRewardDate = next.toISOString().slice(0, 10);
  }

  return {
    enabled: settings?.birthdayRewardEnabled === true,
    points: Number(settings?.birthdayRewardPoints || 0),
    minimumLeadDays: Number(settings?.birthdayRewardMinimumLeadDays || 0),
    timeZone,
    birthday: birthday
      ? {
          month: birthday.month,
          day: birthday.day,
          label: formatBirthday(birthday.month, birthday.day),
        }
      : null,
    entryLocked,
    canSetBirthday: !entryLocked,
    canRemoveBirthday: Boolean(birthday),
    correctionMessage:
      "Birthday can only be entered once. Contact store support if it needs to be corrected.",
    nextRewardDate,
    lastIssuedYear: customer?.birthdayRewardLastIssuedYear || null,
    lastIssuedAt: customer?.birthdayRewardLastIssuedAt || null,
    privacy:
      "Only the birth month and day are stored; the birth year is discarded.",
  };
}

export async function getBirthdayRewardProfile(shopDomain, shopifyCustomerId) {
  const shop = await findOrCreateShop(shopDomain);
  const [settings, customer] = await Promise.all([
    prisma.loyaltySetting.findUnique({ where: { shopId: shop.id } }),
    prisma.customer.findUnique({
      where: {
        shopId_shopifyCustomerId: {
          shopId: shop.id,
          shopifyCustomerId: String(shopifyCustomerId),
        },
      },
    }),
  ]);

  return publicBirthdayProfile(customer, settings);
}

export async function saveCustomerBirthday({
  shopDomain,
  shopifyCustomerId,
  birthday,
}) {
  const normalized = normalizeBirthday(birthday);
  if (!normalized) {
    const error = new Error("Enter a valid birthday.");
    error.status = 400;
    throw error;
  }

  const shop = await findOrCreateShop(shopDomain);
  const settings = await prisma.loyaltySetting.findUnique({
    where: { shopId: shop.id },
  });
  if (!settings?.birthdayRewardEnabled) {
    const error = new Error("Birthday rewards are not currently enabled.");
    error.status = 409;
    throw error;
  }

  const now = new Date();
  const existing = await prisma.customer.findUnique({
    where: {
      shopId_shopifyCustomerId: {
        shopId: shop.id,
        shopifyCustomerId: String(shopifyCustomerId),
      },
    },
  });
  const submissionStatus = getBirthdaySubmissionStatus(existing, normalized);

  if (submissionStatus === "locked") {
    throw birthdayLockedError();
  }

  let customer;

  if (submissionStatus === "unchanged") {
    customer =
      existing.birthdayProvidedAt && existing.birthdayUpdatedAt
        ? existing
        : await prisma.customer.update({
            where: { id: existing.id },
            data: {
              birthdayProvidedAt: existing.birthdayProvidedAt || now,
              birthdayUpdatedAt: existing.birthdayUpdatedAt || now,
            },
          });
  } else if (existing) {
    const claimed = await prisma.customer.updateMany({
      where: {
        id: existing.id,
        birthMonth: null,
        birthDay: null,
        birthdayProvidedAt: null,
      },
      data: {
        birthMonth: normalized.month,
        birthDay: normalized.day,
        birthdayProvidedAt: now,
        birthdayUpdatedAt: now,
      },
    });

    customer = await prisma.customer.findUnique({
      where: { id: existing.id },
    });
    if (
      claimed.count !== 1 &&
      getBirthdaySubmissionStatus(customer, normalized) !== "unchanged"
    ) {
      throw birthdayLockedError();
    }
  } else {
    try {
      customer = await prisma.customer.create({
        data: {
          shopId: shop.id,
          shopifyCustomerId: String(shopifyCustomerId),
          birthMonth: normalized.month,
          birthDay: normalized.day,
          birthdayProvidedAt: now,
          birthdayUpdatedAt: now,
          lastActivityAt: now,
        },
      });
    } catch (error) {
      if (error?.code !== "P2002") throw error;

      customer = await prisma.customer.findUnique({
        where: {
          shopId_shopifyCustomerId: {
            shopId: shop.id,
            shopifyCustomerId: String(shopifyCustomerId),
          },
        },
      });
      if (getBirthdaySubmissionStatus(customer, normalized) !== "unchanged") {
        throw birthdayLockedError();
      }
    }
  }

  return publicBirthdayProfile(customer, settings, now);
}

export async function deleteCustomerBirthday({
  shopDomain,
  shopifyCustomerId,
}) {
  const shop = await findOrCreateShop(shopDomain);
  const settings = await prisma.loyaltySetting.findUnique({
    where: { shopId: shop.id },
  });
  const customer = await prisma.customer.findUnique({
    where: {
      shopId_shopifyCustomerId: {
        shopId: shop.id,
        shopifyCustomerId: String(shopifyCustomerId),
      },
    },
  });

  if (!customer) return publicBirthdayProfile(null, settings);

  const updated = await prisma.customer.update({
    where: { id: customer.id },
    data: {
      birthMonth: null,
      birthDay: null,
      // Keep timestamps as a non-sensitive one-time-entry lock. The actual
      // birth month and day are erased, and an admin can reset the lock when a
      // legitimate correction is needed.
      birthdayProvidedAt: customer.birthdayProvidedAt || new Date(),
      birthdayUpdatedAt:
        customer.birthdayUpdatedAt || customer.birthdayProvidedAt || new Date(),
    },
  });

  return publicBirthdayProfile(updated, settings);
}

async function issueBirthdayReward(customer, settings, year, now) {
  const points = Number(settings.birthdayRewardPoints);
  if (!Number.isInteger(points) || points <= 0) return null;

  const idempotencyKey = `birthday-reward:${customer.shopId}:${customer.id}:${year}`;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const transaction = await tx.pointTransaction.create({
        data: {
          customerId: customer.id,
          points,
          transactionType: BIRTHDAY_REWARD_TRANSACTION_TYPE,
          reason: `Birthday Reward ${year}`,
          idempotencyKey,
        },
      });

      const updatedCustomer = await tx.customer.update({
        where: { id: customer.id },
        data: {
          loyaltyPoints: { increment: points },
          lastActivityAt: now,
          birthdayRewardLastIssuedYear: year,
          birthdayRewardLastIssuedAt: now,
        },
      });

      await tx.rewardActivityLog.create({
        data: {
          customerId: customer.id,
          activityType: BIRTHDAY_REWARD_ACTIVITY_TYPE,
          message: `${points.toLocaleString("en")} birthday points added.`,
          metadata: {
            points,
            year,
            pointsBalanceAfter: updatedCustomer.loyaltyPoints,
            transactionId: transaction.id,
          },
        },
      });

      return { transaction, customer: updatedCustomer };
    });

    if (result.customer.email) {
      await tryQueueAndDispatchLoyaltyEmail({
        shopId: customer.shopId,
        customerId: customer.id,
        eventType: LOYALTY_EMAIL_EVENTS.BIRTHDAY_REWARD,
        recipientEmail: result.customer.email,
        recipientName: result.customer.name,
        subject: `Happy birthday! You received ${points} loyalty points`,
        payload: {
          points,
          year,
          pointsBalanceAfter: result.customer.loyaltyPoints,
          shopDomain: customer.shop.shopDomain,
          customerId: customer.shopifyCustomerId,
        },
        idempotencyKey: `birthday-reward-email:${customer.shopId}:${customer.id}:${year}`,
      });
    }

    return result;
  } catch (error) {
    if (error?.code === "P2002") return null;
    throw error;
  }
}

function candidateBirthdays(today) {
  const candidates = [];
  const todayDate = new Date(Date.UTC(today.year, today.month - 1, today.day));

  for (let offset = 0; offset <= BIRTHDAY_REWARD_GRACE_DAYS; offset += 1) {
    const date = new Date(todayDate);
    date.setUTCDate(date.getUTCDate() - offset);
    candidates.push({
      birthMonth: date.getUTCMonth() + 1,
      birthDay: date.getUTCDate(),
    });

    if (date.getUTCMonth() === 1 && date.getUTCDate() === 28) {
      candidates.push({ birthMonth: 2, birthDay: 29 });
    }
  }

  return candidates;
}

export async function processBirthdayRewards({
  shopDomain,
  batchSize = 250,
  now = new Date(),
} = {}) {
  const take = Math.min(Math.max(Number(batchSize) || 250, 1), 1000);
  const shops = await prisma.shop.findMany({
    where: shopDomain ? { shopDomain } : undefined,
    select: {
      id: true,
      shopDomain: true,
      loyaltySetting: true,
    },
  });
  const summary = { shops: 0, candidates: 0, rewarded: 0, points: 0 };

  for (const shop of shops) {
    const settings = shop.loyaltySetting;
    if (!settings?.birthdayRewardEnabled) continue;

    summary.shops += 1;
    const today = getDatePartsInTimeZone(
      now,
      settings.birthdayRewardTimeZone || "UTC",
    );
    const customers = await prisma.customer.findMany({
      where: {
        shopId: shop.id,
        birthdayUpdatedAt: { not: null },
        AND: [
          { OR: candidateBirthdays(today) },
          {
            OR: [
              { birthdayRewardLastIssuedYear: null },
              { birthdayRewardLastIssuedYear: { not: today.year } },
            ],
          },
        ],
      },
      orderBy: [{ birthdayUpdatedAt: "asc" }, { id: "asc" }],
      take,
      include: { shop: { select: { shopDomain: true } } },
    });
    summary.candidates += customers.length;

    for (const customer of customers) {
      const rewardYear = getBirthdayRewardDueYear({ customer, settings, now });
      if (rewardYear === null) continue;
      const issued = await issueBirthdayReward(
        customer,
        settings,
        rewardYear,
        now,
      );
      if (issued) {
        summary.rewarded += 1;
        summary.points += Number(settings.birthdayRewardPoints);
      }
    }
  }

  return summary;
}
