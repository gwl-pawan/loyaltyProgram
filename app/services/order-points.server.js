import prisma from "../db.server";
import {
  calculateSpendPoints,
  getLoyaltySettings,
} from "./loyalty-settings.server";
import {
  createRewardActivityLog,
  expirePendingDiscountRedemptions,
  REWARD_ACTIVITY_TYPES,
  tryCreateRewardActivityLog,
} from "./reward-activity.server";

const GENERIC_GIFT_CARD_MATCH_WINDOW_MS = 30 * 60 * 1000;

function getOrderId(payload) {
  return String(payload?.admin_graphql_api_id || payload?.id || "");
}

function getOrderName(payload) {
  return String(payload?.name || payload?.order_number || "").trim();
}

function getOrderTotal(payload) {
  return Number(
    payload?.current_total_price ||
      payload?.total_price ||
      payload?.subtotal_price ||
      0,
  );
}

function getOrderDate(payload) {
  const dateValue =
    payload?.processed_at ||
    payload?.created_at ||
    payload?.updated_at ||
    payload?.closed_at;
  const date = dateValue ? new Date(dateValue) : null;

  return date && !Number.isNaN(date.getTime()) ? date : new Date();
}

function getLatestDate(currentValue, nextValue) {
  const currentDate = currentValue ? new Date(currentValue) : null;
  const nextDate = nextValue ? new Date(nextValue) : null;

  if (!nextDate || Number.isNaN(nextDate.getTime())) {
    return currentDate || null;
  }

  if (!currentDate || Number.isNaN(currentDate.getTime())) {
    return nextDate;
  }

  return nextDate > currentDate ? nextDate : currentDate;
}

function isUniqueConstraintError(error) {
  return error?.code === "P2002";
}

async function updateCustomerActivity(
  tx,
  customerId,
  activityDate,
  fields = {},
) {
  const customer = await tx.customer.findUnique({
    where: {
      id: customerId,
    },
    select: {
      lastActivityAt: true,
      lastOrderAt: true,
    },
  });

  if (!customer) {
    return null;
  }

  return tx.customer.update({
    where: {
      id: customerId,
    },
    data: {
      ...fields,
      lastActivityAt: getLatestDate(customer.lastActivityAt, activityDate),
      ...(fields.lastOrderAt
        ? {
            lastOrderAt: getLatestDate(
              customer.lastOrderAt,
              fields.lastOrderAt,
            ),
          }
        : {}),
    },
  });
}

async function trackPaidOrderMetrics(
  customerId,
  orderId,
  orderTotal,
  orderDate,
) {
  const normalizedOrderId = String(orderId || "").trim();
  const normalizedOrderTotal = Math.max(Number(orderTotal) || 0, 0);

  if (!normalizedOrderId) {
    await prisma.$transaction((tx) =>
      updateCustomerActivity(tx, customerId, orderDate, {
        lastOrderAt: orderDate,
      }),
    );
    return {
      tracked: false,
      message: "Order metrics skipped because order ID was missing",
    };
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.customerOrderMetric.create({
        data: {
          customerId,
          shopifyOrderId: normalizedOrderId,
          orderTotal: normalizedOrderTotal,
          orderedAt: orderDate,
        },
      });

      await updateCustomerActivity(tx, customerId, orderDate, {
        lifetimeSpend: {
          increment: normalizedOrderTotal,
        },
        orderCount: {
          increment: 1,
        },
        lastOrderAt: orderDate,
      });
    });

    return {
      tracked: true,
    };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return {
        tracked: false,
        message: "Order metrics already tracked",
      };
    }

    throw error;
  }
}

function getDiscountCodes(payload) {
  const codes = new Set();
  const addCode = (code) => {
    if (typeof code === "string" && code.trim()) {
      codes.add(code.trim());
    }
  };

  for (const discount of payload?.discount_codes || []) {
    addCode(discount?.code);
  }

  for (const discount of payload?.current_discount_codes || []) {
    addCode(discount?.code);
  }

  for (const application of payload?.discount_applications || []) {
    addCode(application?.code);
    addCode(application?.title);
  }

  return Array.from(codes);
}

function normalizeGiftCardCode(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}

function getLastCharacters(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized.length >= 4 ? normalized.slice(-4) : normalized || null;
}

function getCustomerName(customerData) {
  return `${customerData?.first_name || ""} ${customerData?.last_name || ""}`.trim();
}

function getGiftCardPayments(payload) {
  const giftCards = Array.isArray(payload?.gift_cards)
    ? payload.gift_cards
    : [];

  if (giftCards.length > 0) {
    return giftCards.map((card) => ({
      amount: Number(card?.amount || card?.presentment_amount || 0),
      code: card?.code || card?.gift_card_code || null,
      lastCharacters: getLastCharacters(card?.last_characters || card?.code),
    }));
  }

  const transactions = Array.isArray(payload?.transactions)
    ? payload.transactions
    : [];

  const giftCardTransactions = transactions.filter((transaction) => {
    const gateway = String(transaction?.gateway || "").toLowerCase();
    const sourceName = String(transaction?.source_name || "").toLowerCase();
    const paymentDetails = transaction?.payment_details || {};
    const creditCardCompany = String(
      paymentDetails?.credit_card_company || "",
    ).toLowerCase();

    return (
      gateway.includes("gift") ||
      sourceName.includes("gift") ||
      creditCardCompany.includes("gift")
    );
  });

  if (giftCardTransactions.length > 0) {
    return giftCardTransactions.map((transaction) => {
      const paymentDetails = transaction?.payment_details || {};
      return {
        amount: Number(transaction?.amount || 0),
        code: null,
        lastCharacters: getLastCharacters(
          transaction?.receipt?.gift_card_last_characters ||
            paymentDetails?.credit_card_number,
        ),
      };
    });
  }

  const paymentDetails = payload?.payment_details;
  if (paymentDetails && typeof paymentDetails === "object") {
    const company = String(
      paymentDetails.credit_card_company || "",
    ).toLowerCase();
    if (company.includes("gift")) {
      return [
        {
          amount: Number(paymentDetails.amount || 0),
          code: null,
          lastCharacters: getLastCharacters(paymentDetails.credit_card_number),
        },
      ];
    }
  }

  const paymentGatewayNames = Array.isArray(payload?.payment_gateway_names)
    ? payload.payment_gateway_names
    : [];

  if (
    paymentGatewayNames.some((name) =>
      String(name || "")
        .toLowerCase()
        .includes("gift"),
    )
  ) {
    return [
      {
        amount: 0,
        code: null,
        lastCharacters: null,
        genericGatewayOnly: true,
      },
    ];
  }

  return [];
}

function findRecentGiftCardReward(candidateRewards, matchedIds, orderDate) {
  return candidateRewards
    .filter((candidate) => {
      if (matchedIds.has(candidate.id) || !candidate.createdAt) {
        return false;
      }

      const ageMs =
        orderDate.getTime() - new Date(candidate.createdAt).getTime();
      return ageMs >= 0 && ageMs <= GENERIC_GIFT_CARD_MATCH_WINDOW_MS;
    })
    .sort(
      (left, right) => new Date(right.createdAt) - new Date(left.createdAt),
    )[0];
}

export async function addOrderRewardPoints(shopDomain, payload) {
  const customerData = payload?.customer;
  const orderId = getOrderId(payload);
  const orderTotal = getOrderTotal(payload);

  if (!customerData?.id) {
    return {
      status: "skipped",
      message: "No customer found",
    };
  }

  const { shop, settings } = await getLoyaltySettings(shopDomain);
  const points = calculateSpendPoints(
    orderTotal,
    settings.orderSpendAmount,
    settings.orderSpendPoints,
  );

  const reason = orderId ? `Order Reward:${orderId}` : "Order Reward";

  let customer = await prisma.customer.findFirst({
    where: {
      shopId: shop.id,
      shopifyCustomerId: String(customerData.id),
    },
  });

  if (!customer) {
    customer = await prisma.customer.create({
      data: {
        shopId: shop.id,
        shopifyCustomerId: String(customerData.id),
        name: getCustomerName(customerData),
        email: customerData.email,
        loyaltyPoints: 0,
      },
    });
  }

  await trackPaidOrderMetrics(
    customer.id,
    orderId,
    orderTotal,
    getOrderDate(payload),
  );

  if (orderId) {
    const existingTransaction = await prisma.pointTransaction.findFirst({
      where: {
        customerId: customer.id,
        transactionType: "credit",
        reason,
      },
    });

    if (existingTransaction) {
      return {
        status: "skipped",
        message: "Order already rewarded",
        customer,
        points,
      };
    }
  }

  if (points <= 0) {
    return {
      status: "skipped",
      message: "Order total did not meet the points threshold",
      customer,
      points,
      orderTotal,
    };
  }

  const updatedCustomer = await prisma.$transaction(async (tx) => {
    const nextCustomer = await tx.customer.update({
      where: {
        id: customer.id,
      },
        data: {
          loyaltyPoints: {
            increment: points,
          },
          lastActivityAt: new Date(),
        },
      });

    await tx.pointTransaction.create({
      data: {
        customerId: customer.id,
        points,
        transactionType: "credit",
        reason,
      },
    });

    return nextCustomer;
  });

  return {
    status: "credited",
    customer: updatedCustomer,
    points,
    orderTotal,
  };
}

export async function settleOrderRedemptions(shopDomain, payload) {
  const orderId = getOrderId(payload);
  const orderName = getOrderName(payload);
  const orderTotal = getOrderTotal(payload);
  const currencyCode =
    payload?.currency || payload?.presentment_currency || null;
  const discountCodes = getDiscountCodes(payload);

  await expirePendingDiscountRedemptions();

  if (!orderId || discountCodes.length === 0) {
    return {
      status: "skipped",
      message: "No loyalty discount codes found",
      settled: 0,
    };
  }

  const shop = await prisma.shop.findUnique({
    where: {
      shopDomain,
    },
  });

  if (!shop) {
    return {
      status: "skipped",
      message: "Shop not found",
      settled: 0,
    };
  }

  const pendingRewards = await prisma.reward.findMany({
    where: {
      rewardCode: {
        in: discountCodes,
      },
      status: "pending",
      customer: {
        shopId: shop.id,
      },
    },
    include: {
      customer: true,
    },
  });

  if (pendingRewards.length === 0) {
    return {
      status: "skipped",
      message: "No pending loyalty redemptions found",
      settled: 0,
    };
  }

  const settledRewards = [];

  for (const reward of pendingRewards) {
    const reason = `Reward Redemption:${orderId}:${reward.rewardCode}`;
    const appliedAt = new Date();

    let settled;

    try {
      settled = await prisma.$transaction(async (tx) => {
        const updatedReward = await tx.reward.updateMany({
          where: {
            id: reward.id,
            status: "pending",
          },
          data: {
            status: "redeemed",
            orderId,
            appliedAt,
          },
        });

        if (updatedReward.count === 0) {
          return null;
        }

        await tx.customer.update({
          where: {
            id: reward.customerId,
          },
          data: {
            loyaltyPoints: {
              decrement: reward.pointsUsed,
            },
            lastActivityAt: appliedAt,
          },
        });

        await tx.pointTransaction.create({
          data: {
            customerId: reward.customerId,
            points: reward.pointsUsed,
            transactionType: "debit",
            reason,
          },
        });

        await createRewardActivityLog(tx, {
          customerId: reward.customerId,
          rewardId: reward.id,
          rewardCode: reward.rewardCode,
          activityType: REWARD_ACTIVITY_TYPES.DISCOUNT_APPLIED,
          message: "Discount applied to a paid order.",
          metadata: {
            orderId,
            orderName,
            orderTotal,
            currencyCode,
            pointsUsed: reward.pointsUsed,
            discountAmount: reward.discountAmount,
            appliedAt,
          },
        });

        return reward;
      });
    } catch (error) {
      await tryCreateRewardActivityLog({
        customerId: reward.customerId,
        rewardId: reward.id,
        rewardCode: reward.rewardCode,
        activityType: REWARD_ACTIVITY_TYPES.DISCOUNT_FAILED,
        message: error?.message || "Could not apply discount redemption.",
        metadata: {
          orderId,
          orderName,
          pointsUsed: reward.pointsUsed,
        },
      });

      throw error;
    }

    if (settled) {
      settledRewards.push(settled);
    }
  }

  return {
    status: settledRewards.length > 0 ? "settled" : "skipped",
    settled: settledRewards.length,
    rewards: settledRewards,
  };
}

export async function settleGiftCardRedemptions(shopDomain, payload) {
  const orderId = getOrderId(payload);
  const orderName = getOrderName(payload);
  const orderTotal = getOrderTotal(payload);
  const currencyCode =
    payload?.currency || payload?.presentment_currency || null;
  const orderDate = getOrderDate(payload);
  const customerData = payload?.customer;
  const giftCardPayments = getGiftCardPayments(payload);

  if (giftCardPayments.length === 0) {
    return {
      status: "skipped",
      message: "No gift card payment detected",
      settled: 0,
    };
  }

  if (!customerData?.id) {
    return {
      status: "skipped",
      message: "No customer found",
      settled: 0,
    };
  }

  const shop = await prisma.shop.findUnique({
    where: {
      shopDomain,
    },
  });

  if (!shop) {
    return {
      status: "skipped",
      message: "Shop not found",
      settled: 0,
    };
  }

  const customer = await prisma.customer.findFirst({
    where: {
      shopId: shop.id,
      shopifyCustomerId: String(customerData.id),
    },
  });

  if (!customer) {
    return {
      status: "skipped",
      message: "Customer not found",
      settled: 0,
    };
  }

  const candidateRewards = await prisma.reward.findMany({
    where: {
      customerId: customer.id,
      rewardType: "gift_card",
      orderId: null,
    },
    orderBy: {
      createdAt: "asc",
    },
  });

  if (candidateRewards.length === 0) {
    return {
      status: "skipped",
      message: "No active gift card rewards found",
      settled: 0,
    };
  }

  const matchedRewards = [];
  const matchedIds = new Set();

  for (const payment of giftCardPayments) {
    const amount = Number(payment.amount || 0);
    const code = normalizeGiftCardCode(payment.code);
    const lastCharacters =
      typeof payment.lastCharacters === "string"
        ? getLastCharacters(payment.lastCharacters)
        : null;

    let reward = null;

    if (code) {
      reward = candidateRewards.find(
        (candidate) =>
          !matchedIds.has(candidate.id) &&
          normalizeGiftCardCode(candidate.rewardCode) === code,
      );
    }

    if (!reward && lastCharacters) {
      reward = candidateRewards.find((candidate) => {
        if (matchedIds.has(candidate.id)) {
          return false;
        }

        const candidateLastCharacters = getLastCharacters(candidate.rewardCode);
        return candidateLastCharacters === lastCharacters;
      });
    }

    if (!reward && amount > 0) {
      reward = candidateRewards.find((candidate) => {
        if (matchedIds.has(candidate.id)) {
          return false;
        }

        const candidateAmount = Number(candidate.discountAmount || 0);
        return Math.abs(candidateAmount - amount) < 0.01;
      });
    }

    if (!reward && payment.genericGatewayOnly) {
      reward = findRecentGiftCardReward(
        candidateRewards,
        matchedIds,
        orderDate,
      );
    }

    if (!reward && candidateRewards.length - matchedIds.size === 1) {
      reward = candidateRewards.find(
        (candidate) => !matchedIds.has(candidate.id),
      );
    }

    if (!reward) {
      break;
    }

    matchedIds.add(reward.id);
    matchedRewards.push(reward);
  }

  if (matchedRewards.length === 0) {
    return {
      status: "skipped",
      message: "Gift card payment detected but no matching reward found",
      settled: 0,
    };
  }

  const settledRewards = [];

  for (const reward of matchedRewards) {
    const appliedAt = new Date();

    try {
      const updatedReward = await prisma.$transaction(async (tx) => {
        const appliedReward = await tx.reward.update({
          where: {
            id: reward.id,
          },
          data: {
            orderId,
            appliedAt,
          },
        });

        // Deduct points from customer when gift card is applied after order payment
        await tx.customer.update({
          where: {
            id: reward.customerId,
          },
          data: {
            loyaltyPoints: {
              decrement: reward.pointsUsed,
            },
            lastActivityAt: appliedAt,
          },
        });

        // Create point transaction record
        await tx.pointTransaction.create({
          data: {
            customerId: reward.customerId,
            points: reward.pointsUsed,
            transactionType: "debit",
            reason: "Gift Card Redemption",
          },
        });

        await createRewardActivityLog(tx, {
          customerId: reward.customerId,
          rewardId: reward.id,
          rewardCode: reward.rewardCode,
          activityType: REWARD_ACTIVITY_TYPES.GIFT_CARD_APPLIED,
          message: "Gift card applied to a paid order.",
          metadata: {
            orderId,
            orderName,
            orderTotal,
            currencyCode,
            amount: reward.discountAmount,
            pointsUsed: reward.pointsUsed,
            appliedAt: appliedAt.toISOString(),
          },
        });

        return appliedReward;
      });

      settledRewards.push(updatedReward);
    } catch (error) {
      console.error(
        `[settleGiftCardRedemptions] Error applying gift card ${reward.rewardCode}`,
        error,
      );

      await tryCreateRewardActivityLog({
        customerId: reward.customerId,
        rewardId: reward.id,
        rewardCode: reward.rewardCode,
        activityType: REWARD_ACTIVITY_TYPES.GIFT_CARD_FAILED,
        message: error?.message || "Could not apply gift card redemption.",
        metadata: {
          orderId,
          orderName,
          amount: reward.discountAmount,
          error: error?.message,
        },
      });

      throw error;
    }
  }

  return {
    status: "settled",
    settled: settledRewards.length,
    rewards: settledRewards,
  };
}
