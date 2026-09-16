import prisma from "../db.server";
import { logError, runShopifyGraphql } from "./errors.server";

const RANGE_DAYS = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "365d": 365,
};
const REWARD_TYPES = new Set(["all", "discount", "gift_card", "store_credit"]);
const CUSTOMER_SEGMENTS = new Set(["all", "active", "earners", "redeemers"]);

export function normalizeAnalyticsFilters(url) {
  const rangeValue = url.searchParams.get("range") || "30d";
  const rewardTypeValue = url.searchParams.get("rewardType") || "all";
  const customerSegmentValue = url.searchParams.get("customerSegment") || "all";
  const range =
    rangeValue === "all" || RANGE_DAYS[rangeValue] ? rangeValue : "30d";
  const rewardType = REWARD_TYPES.has(rewardTypeValue)
    ? rewardTypeValue
    : "all";
  const customerSegment = CUSTOMER_SEGMENTS.has(customerSegmentValue)
    ? customerSegmentValue
    : "all";
  const startDate =
    range === "all"
      ? null
      : new Date(Date.now() - RANGE_DAYS[range] * 24 * 60 * 60 * 1000);

  return { range, rewardType, customerSegment, startDate };
}

function isCompletedReward(reward) {
  if (reward.rewardType === "store_credit") {
    return reward.status === "active";
  }

  return Boolean(reward.appliedAt);
}

function getRewardDate(reward) {
  return new Date(reward.appliedAt || reward.createdAt);
}

function getSelectedCustomerIds(segment, transactions, completedRewards) {
  if (segment === "all") return null;

  const earnerIds = new Set(
    transactions
      .filter((transaction) => transaction.transactionType === "credit")
      .map((transaction) => transaction.customerId),
  );
  const redeemerIds = new Set(
    completedRewards.map((reward) => reward.customerId),
  );

  if (segment === "earners") return earnerIds;
  if (segment === "redeemers") return redeemerIds;

  return new Set([...earnerIds, ...redeemerIds]);
}

function getBucketSettings(filters, dates) {
  const now = new Date();
  let start = filters.startDate;

  if (!start) {
    const validDates = dates.filter((date) => !Number.isNaN(date.getTime()));
    start = validDates.length
      ? new Date(Math.min(...validDates.map((date) => date.getTime())))
      : new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
  }

  const totalDays = Math.max(
    1,
    Math.ceil((now.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)),
  );
  const bucketDays = totalDays <= 31 ? 1 : totalDays <= 120 ? 7 : 30;
  const bucketCount = Math.min(18, Math.ceil(totalDays / bucketDays));
  const chartStart = new Date(
    now.getTime() - bucketCount * bucketDays * 24 * 60 * 60 * 1000,
  );

  return { bucketCount, bucketDays, chartStart, now };
}

function buildRedemptionTrend(rewards, filters) {
  const settings = getBucketSettings(filters, rewards.map(getRewardDate));
  const bucketMs = settings.bucketDays * 24 * 60 * 60 * 1000;
  const labelFormatter = new Intl.DateTimeFormat("en", {
    month: "short",
    day: settings.bucketDays < 30 ? "numeric" : undefined,
  });
  const buckets = Array.from({ length: settings.bucketCount }, (_, index) => {
    const start = new Date(settings.chartStart.getTime() + index * bucketMs);
    return {
      start,
      end: new Date(start.getTime() + bucketMs),
      label: labelFormatter.format(start),
      redemptions: 0,
      points: 0,
      value: 0,
    };
  });

  rewards.forEach((reward) => {
    const date = getRewardDate(reward);
    const index = Math.floor(
      (date.getTime() - settings.chartStart.getTime()) / bucketMs,
    );

    if (index < 0 || index >= buckets.length) return;
    buckets[index].redemptions += 1;
    buckets[index].points += reward.pointsUsed || 0;
    buckets[index].value += Number(reward.discountAmount || 0);
  });

  return buckets.map((bucket) => ({
    label: bucket.label,
    redemptions: bucket.redemptions,
    points: bucket.points,
    value: bucket.value,
  }));
}

async function loadShopCurrency(admin) {
  const data = await runShopifyGraphql(
    admin,
    `#graphql
      query LoyaltyAnalyticsCurrency {
        shop {
          currencyCode
        }
      }
    `,
    { operation: "Load loyalty analytics currency" },
  );

  return data.shop?.currencyCode || "USD";
}

function normalizeShopifyOrderId(orderId) {
  const id = String(orderId || "").trim();

  if (/^\d+$/.test(id)) return `gid://shopify/Order/${id}`;
  return id.startsWith("gid://shopify/Order/") ? id : "";
}

async function loadAttributedOrders(admin, orderIds) {
  const uniqueOrderIds = Array.from(
    new Set(orderIds.map(normalizeShopifyOrderId).filter(Boolean)),
  );

  if (uniqueOrderIds.length === 0) return [];

  const orders = [];

  for (let index = 0; index < uniqueOrderIds.length; index += 100) {
    const ids = uniqueOrderIds.slice(index, index + 100);
    const data = await runShopifyGraphql(
      admin,
      `#graphql
        query LoyaltyAnalyticsOrders($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Order {
              id
              name
              currentTotalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
      `,
      {
        variables: { ids },
        operation: "Load loyalty attributed orders",
      },
    );

    orders.push(...(data.nodes || []).filter(Boolean));
  }

  return orders;
}

export async function loadLoyaltyAnalytics({ admin, shopId, filters }) {
  const dateFilter = filters.startDate ? { gte: filters.startDate } : undefined;
  const customerScope = { shopId };
  const rewardDateScope = dateFilter
    ? {
        OR: [{ createdAt: dateFilter }, { appliedAt: dateFilter }],
      }
    : {};
  const rewardTypeScope =
    filters.rewardType === "all" ? {} : { rewardType: filters.rewardType };

  const [customers, transactions, rewards, currencyCode] = await Promise.all([
    prisma.customer.findMany({
      where: customerScope,
      select: {
        id: true,
        createdAt: true,
        loyaltyPoints: true,
      },
    }),
    prisma.pointTransaction.findMany({
      where: {
        customer: customerScope,
        ...(dateFilter ? { createdAt: dateFilter } : {}),
      },
      select: {
        customerId: true,
        points: true,
        transactionType: true,
        createdAt: true,
      },
    }),
    prisma.reward.findMany({
      where: {
        customer: customerScope,
        ...rewardTypeScope,
        ...rewardDateScope,
      },
      select: {
        id: true,
        customerId: true,
        rewardType: true,
        status: true,
        pointsUsed: true,
        discountAmount: true,
        orderId: true,
        createdAt: true,
        appliedAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    loadShopCurrency(admin).catch((error) => {
      logError("loyalty-analytics:currency", error, { shopId });
      return "USD";
    }),
  ]);

  const allCompletedRewards = rewards.filter(isCompletedReward);
  const selectedCustomerIds = getSelectedCustomerIds(
    filters.customerSegment,
    transactions,
    allCompletedRewards,
  );
  const customerIsSelected = (customerId) =>
    selectedCustomerIds === null || selectedCustomerIds.has(customerId);
  const selectedTransactions = transactions.filter((transaction) =>
    customerIsSelected(transaction.customerId),
  );
  const completedRewards = allCompletedRewards.filter((reward) =>
    customerIsSelected(reward.customerId),
  );
  const activeCustomerIds = new Set([
    ...selectedTransactions.map((transaction) => transaction.customerId),
    ...completedRewards.map((reward) => reward.customerId),
  ]);
  const earnerIds = new Set(
    selectedTransactions
      .filter((transaction) => transaction.transactionType === "credit")
      .map((transaction) => transaction.customerId),
  );
  const redeemerCounts = completedRewards.reduce((counts, reward) => {
    counts.set(reward.customerId, (counts.get(reward.customerId) || 0) + 1);
    return counts;
  }, new Map());
  const newMembers = customers.filter(
    (customer) =>
      (!filters.startDate || customer.createdAt >= filters.startDate) &&
      customerIsSelected(customer.id),
  ).length;
  const pointsEarned = selectedTransactions
    .filter((transaction) => transaction.transactionType === "credit")
    .reduce((total, transaction) => total + transaction.points, 0);
  const pointsRedeemed = completedRewards.reduce(
    (total, reward) => total + reward.pointsUsed,
    0,
  );
  const redemptionValue = completedRewards.reduce(
    (total, reward) => total + Number(reward.discountAmount || 0),
    0,
  );
  const appliedActivityLogs =
    completedRewards.length > 0
      ? await prisma.rewardActivityLog.findMany({
          where: {
            rewardId: { in: completedRewards.map((reward) => reward.id) },
            activityType: { in: ["discount_applied", "gift_card_applied"] },
          },
          select: { metadata: true },
        })
      : [];
  const attributedOrderTotals = new Map();

  appliedActivityLogs.forEach((activity) => {
    const metadata = activity.metadata;
    const orderId = normalizeShopifyOrderId(metadata?.orderId);
    const orderTotal = Number(metadata?.orderTotal);

    if (orderId && Number.isFinite(orderTotal)) {
      attributedOrderTotals.set(orderId, orderTotal);
    }
  });
  let attributedOrders = [];

  try {
    attributedOrders = await loadAttributedOrders(
      admin,
      completedRewards.map((reward) => reward.orderId),
    );
  } catch (error) {
    logError("loyalty-analytics:orders", error, {
      shopId,
      orderCount: completedRewards.filter((reward) => reward.orderId).length,
    });
  }
  attributedOrders.forEach((order) => {
    attributedOrderTotals.set(
      order.id,
      Number(order.currentTotalPriceSet?.shopMoney?.amount || 0),
    );
  });
  const attributedRevenue = Array.from(attributedOrderTotals.values()).reduce(
    (total, amount) => total + amount,
    0,
  );
  const attributedOrderCount = attributedOrderTotals.size;
  const rewardMix = ["discount", "gift_card", "store_credit"].map((type) => ({
    type,
    count: completedRewards.filter((reward) => reward.rewardType === type)
      .length,
    value: completedRewards
      .filter((reward) => reward.rewardType === type)
      .reduce((total, reward) => total + Number(reward.discountAmount || 0), 0),
  }));

  return {
    currencyCode,
    revenue: {
      attributedRevenue,
      attributedOrders: attributedOrderCount,
      averageOrderValue:
        attributedOrderCount > 0 ? attributedRevenue / attributedOrderCount : 0,
      redemptionValue,
      revenueToRewardRatio:
        redemptionValue > 0 ? attributedRevenue / redemptionValue : 0,
    },
    redemptions: {
      count: completedRewards.length,
      pointsEarned,
      pointsRedeemed,
      trend: buildRedemptionTrend(completedRewards, filters),
      rewardMix,
    },
    engagement: {
      totalMembers: customers.filter((customer) =>
        customerIsSelected(customer.id),
      ).length,
      activeMembers: activeCustomerIds.size,
      earners: earnerIds.size,
      redeemers: redeemerCounts.size,
      repeatRedeemers: Array.from(redeemerCounts.values()).filter(
        (count) => count > 1,
      ).length,
      newMembers,
      engagementRate:
        customers.length > 0
          ? (activeCustomerIds.size / customers.length) * 100
          : 0,
    },
  };
}
