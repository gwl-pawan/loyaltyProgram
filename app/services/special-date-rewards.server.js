import prisma from "../db.server";
import { tryQueueAndDispatchLoyaltyEmail } from "./email-delivery.server";
import { LOYALTY_EMAIL_EVENTS } from "./email-notifications.server";
import { findOrCreateShop } from "./loyalty-settings.server";
import {
  BIRTHDAY_REWARD_GRACE_DAYS,
  formatBirthday,
  getBirthdayDateForYear,
  getDatePartsInTimeZone,
  normalizeBirthday,
} from "./birthday-rewards.shared";
import {
  getSpecialDateRewardConfigurations,
  getSpecialDateRewardDueYear,
  normalizeSpecialDateSlot,
} from "./special-date-rewards.shared";

export const SPECIAL_DATE_REWARD_ACTIVITY_TYPE = "special_date_rewarded";

function getRewardConfiguration(settings, slot) {
  return getSpecialDateRewardConfigurations(settings).find(
    (reward) => reward.slot === normalizeSpecialDateSlot(slot),
  );
}

function getNextRewardDate(customer, reward, settings, now) {
  const date = normalizeBirthday({
    month: customer?.[reward.monthField],
    day: customer?.[reward.dayField],
  });
  if (!date) return null;

  const today = getDatePartsInTimeZone(
    now,
    settings?.birthdayRewardTimeZone || "UTC",
  );
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
  let next = getBirthdayDateForYear(date.month, date.day, today.year);
  if (
    next.getTime() < todayUtc ||
    customer?.[reward.lastIssuedYearField] === today.year
  ) {
    next = getBirthdayDateForYear(date.month, date.day, today.year + 1);
  }
  return next.toISOString().slice(0, 10);
}

function publicSpecialDateProfile(customer, settings, now = new Date()) {
  return {
    minimumLeadDays: Number(settings?.specialDateRewardMinimumLeadDays || 0),
    timeZone: settings?.birthdayRewardTimeZone || "UTC",
    privacy:
      "Only the month and day are stored; any year supplied is discarded.",
    rewards: getSpecialDateRewardConfigurations(settings).map((reward) => {
      const date = normalizeBirthday({
        month: customer?.[reward.monthField],
        day: customer?.[reward.dayField],
      });
      return {
        slot: reward.slot,
        enabled: reward.enabled,
        heading: reward.heading,
        points: reward.points,
        date: date
          ? {
              month: date.month,
              day: date.day,
              label: formatBirthday(date.month, date.day),
            }
          : null,
        canSetDate: reward.enabled,
        canRemoveDate: Boolean(date),
        nextRewardDate: getNextRewardDate(customer, reward, settings, now),
        lastIssuedYear: customer?.[reward.lastIssuedYearField] || null,
        lastIssuedAt: customer?.[reward.lastIssuedAtField] || null,
      };
    }),
  };
}

async function getShopSettingsAndCustomer(shopDomain, shopifyCustomerId) {
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
  return { shop, settings, customer };
}

export async function getSpecialDateRewardProfile(
  shopDomain,
  shopifyCustomerId,
) {
  const { settings, customer } = await getShopSettingsAndCustomer(
    shopDomain,
    shopifyCustomerId,
  );
  return publicSpecialDateProfile(customer, settings);
}

export async function saveCustomerSpecialDate({
  shopDomain,
  shopifyCustomerId,
  slot,
  date,
}) {
  const normalizedSlot = normalizeSpecialDateSlot(slot);
  const normalizedDate = normalizeBirthday(date);
  if (!normalizedSlot || !normalizedDate) {
    const error = new Error("Select a valid special date.");
    error.status = 400;
    throw error;
  }

  const {
    shop,
    settings,
    customer: existing,
  } = await getShopSettingsAndCustomer(shopDomain, shopifyCustomerId);
  const reward = getRewardConfiguration(settings, normalizedSlot);
  if (!reward?.enabled) {
    const error = new Error("This special date reward is not enabled.");
    error.status = 409;
    throw error;
  }

  const now = new Date();
  const data = {
    [reward.monthField]: normalizedDate.month,
    [reward.dayField]: normalizedDate.day,
    [reward.providedAtField]: existing?.[reward.providedAtField] || now,
    [reward.updatedAtField]: now,
    lastActivityAt: now,
  };
  const customer = existing
    ? await prisma.customer.update({ where: { id: existing.id }, data })
    : await prisma.customer.create({
        data: {
          shopId: shop.id,
          shopifyCustomerId: String(shopifyCustomerId),
          ...data,
        },
      });

  return publicSpecialDateProfile(customer, settings, now);
}

export async function deleteCustomerSpecialDate({
  shopDomain,
  shopifyCustomerId,
  slot,
}) {
  const normalizedSlot = normalizeSpecialDateSlot(slot);
  if (!normalizedSlot) {
    const error = new Error("Select a valid special date reward.");
    error.status = 400;
    throw error;
  }

  const { settings, customer } = await getShopSettingsAndCustomer(
    shopDomain,
    shopifyCustomerId,
  );
  const reward = getRewardConfiguration(settings, normalizedSlot);
  if (!customer) return publicSpecialDateProfile(null, settings);

  const updated = await prisma.customer.update({
    where: { id: customer.id },
    data: {
      [reward.monthField]: null,
      [reward.dayField]: null,
      [reward.updatedAtField]: null,
    },
  });
  return publicSpecialDateProfile(updated, settings);
}

async function issueSpecialDateReward(customer, reward, year, now) {
  const idempotencyKey = `special-date-reward:${customer.shopId}:${customer.id}:${reward.slot}:${year}`;
  const rewardDate = normalizeBirthday({
    month: customer[reward.monthField],
    day: customer[reward.dayField],
  });

  try {
    const result = await prisma.$transaction(async (tx) => {
      const transaction = await tx.pointTransaction.create({
        data: {
          customerId: customer.id,
          points: reward.points,
          transactionType: "credit",
          reason: `${reward.heading} ${year}`,
          idempotencyKey,
        },
      });
      const updatedCustomer = await tx.customer.update({
        where: { id: customer.id },
        data: {
          loyaltyPoints: { increment: reward.points },
          lastActivityAt: now,
          [reward.lastIssuedYearField]: year,
          [reward.lastIssuedAtField]: now,
        },
      });

      await tx.rewardActivityLog.create({
        data: {
          customerId: customer.id,
          activityType: SPECIAL_DATE_REWARD_ACTIVITY_TYPE,
          message: `${reward.points.toLocaleString("en")} points added for ${reward.heading}.`,
          metadata: {
            slot: reward.slot,
            heading: reward.heading,
            rewardDate,
            points: reward.points,
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
        eventType: LOYALTY_EMAIL_EVENTS.SPECIAL_DATE_REWARD,
        recipientEmail: result.customer.email,
        recipientName: result.customer.name,
        subject: `${reward.heading}: You received ${reward.points} loyalty points`,
        payload: {
          points: reward.points,
          pointsBalanceAfter: result.customer.loyaltyPoints,
          rewardHeading: reward.heading,
          rewardDate,
          rewardSlot: reward.slot,
          year,
          shopDomain: customer.shop.shopDomain,
          customerId: customer.shopifyCustomerId,
        },
        idempotencyKey: `special-date-reward-email:${customer.shopId}:${customer.id}:${reward.slot}:${year}`,
      });
    }

    return result;
  } catch (error) {
    if (error?.code === "P2002") return null;
    throw error;
  }
}

function candidateDates(today, reward) {
  const candidates = [];
  const todayDate = new Date(Date.UTC(today.year, today.month - 1, today.day));
  for (let offset = 0; offset <= BIRTHDAY_REWARD_GRACE_DAYS; offset += 1) {
    const date = new Date(todayDate);
    date.setUTCDate(date.getUTCDate() - offset);
    candidates.push({
      [reward.monthField]: date.getUTCMonth() + 1,
      [reward.dayField]: date.getUTCDate(),
    });
    if (date.getUTCMonth() === 1 && date.getUTCDate() === 28) {
      candidates.push({
        [reward.monthField]: 2,
        [reward.dayField]: 29,
      });
    }
  }
  return candidates;
}

export async function processSpecialDateRewards({
  shopDomain,
  batchSize = 250,
  now = new Date(),
} = {}) {
  const take = Math.min(Math.max(Number(batchSize) || 250, 1), 1000);
  const shops = await prisma.shop.findMany({
    where: shopDomain ? { shopDomain } : undefined,
    select: { id: true, shopDomain: true, loyaltySetting: true },
  });
  const summary = {
    shops: 0,
    rewardDates: 0,
    candidates: 0,
    rewarded: 0,
    points: 0,
  };

  for (const shop of shops) {
    const settings = shop.loyaltySetting;
    if (!settings) continue;
    const rewards = getSpecialDateRewardConfigurations(settings).filter(
      (reward) => reward.enabled,
    );
    if (rewards.length === 0) continue;
    summary.shops += 1;
    const today = getDatePartsInTimeZone(
      now,
      settings.birthdayRewardTimeZone || "UTC",
    );

    for (const reward of rewards) {
      summary.rewardDates += 1;
      const customers = await prisma.customer.findMany({
        where: {
          shopId: shop.id,
          [reward.updatedAtField]: { not: null },
          AND: [
            { OR: candidateDates(today, reward) },
            {
              OR: [
                { [reward.lastIssuedYearField]: null },
                { [reward.lastIssuedYearField]: { not: today.year } },
              ],
            },
          ],
        },
        orderBy: [{ [reward.updatedAtField]: "asc" }, { id: "asc" }],
        take,
        include: { shop: { select: { shopDomain: true } } },
      });
      summary.candidates += customers.length;

      for (const customer of customers) {
        const rewardYear = getSpecialDateRewardDueYear({
          customer,
          reward,
          settings,
          now,
        });
        if (rewardYear === null) continue;
        const issued = await issueSpecialDateReward(
          customer,
          reward,
          rewardYear,
          now,
        );
        if (issued) {
          summary.rewarded += 1;
          summary.points += reward.points;
        }
      }
    }
  }

  return summary;
}
