import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  calculateSpendPoints,
  getLoyaltySettings,
} from "../services/loyalty-settings.server";
import {
  createRewardActivityLog,
  REWARD_ACTIVITY_TYPES,
} from "../services/reward-activity.server";
import {
  webhookAuthenticationError,
  webhookProcessingError,
} from "../services/errors.server";
import { tryQueueAndDispatchLoyaltyEmail } from "../services/email-delivery.server";
import { LOYALTY_EMAIL_EVENTS } from "../services/email-notifications.server";

function getOrderId(payload) {
  return String(
    payload?.order?.admin_graphql_api_id || payload?.order?.id || "",
  );
}

function getOrderName(payload) {
  return String(
    payload?.order?.name || payload?.order?.order_number || "",
  ).trim();
}

function getRefundId(payload) {
  return String(payload?.admin_graphql_api_id || payload?.id || "").trim();
}

function getRefundDate(payload) {
  const dateValue = payload?.processed_at || payload?.created_at;
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

function getMoneyAmount(value) {
  const directAmount = Number(value);

  if (Number.isFinite(directAmount)) {
    return directAmount;
  }

  const nestedAmount = Number(value?.shop_money?.amount || value?.amount);

  return Number.isFinite(nestedAmount) ? nestedAmount : 0;
}

function getRefundAmount(payload) {
  const transactionTotal = (payload?.transactions || []).reduce(
    (sum, transaction) => {
      const kind = String(transaction?.kind || "").toLowerCase();
      const status = String(transaction?.status || "").toLowerCase();

      if (kind && kind !== "refund") {
        return sum;
      }

      if (status && !["success", "succeeded"].includes(status)) {
        return sum;
      }

      return sum + Math.abs(Number(transaction?.amount || 0));
    },
    0,
  );

  if (transactionTotal > 0) {
    return transactionTotal;
  }

  return (payload?.refund_line_items || []).reduce((sum, item) => {
    const subtotal = getMoneyAmount(item?.subtotal_set || item?.subtotal);
    const tax = getMoneyAmount(item?.total_tax_set || item?.total_tax);

    return sum + Math.abs(subtotal) + Math.abs(tax);
  }, 0);
}

function isUniqueConstraintError(error) {
  return error?.code === "P2002";
}

async function recordRefundMetric(
  customerId,
  orderId,
  refundId,
  refundAmount,
  refundedAt,
) {
  const normalizedRefundId = String(refundId || "").trim();
  const normalizedOrderId = String(orderId || "").trim();
  const normalizedRefundAmount = Math.max(Number(refundAmount) || 0, 0);

  if (!normalizedRefundId) {
    await prisma.customer.update({
      where: {
        id: customerId,
      },
      data: {
        lastActivityAt: refundedAt,
      },
    });

    return {
      created: true,
      amountApplied: normalizedRefundAmount,
    };
  }

  try {
    const amountApplied = await prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({
        where: {
          id: customerId,
        },
        select: {
          lifetimeSpend: true,
          lastActivityAt: true,
        },
      });
      const orderMetric = normalizedOrderId
        ? await tx.customerOrderMetric.findUnique({
            where: {
              customerId_shopifyOrderId: {
                customerId,
                shopifyOrderId: normalizedOrderId,
              },
            },
          })
        : null;
      const remainingOrderAmount = orderMetric
        ? Math.max(
            Number(orderMetric.orderTotal || 0) -
              Number(orderMetric.refundedTotal || 0),
            0,
          )
        : normalizedRefundAmount;
      const cappedRefundAmount = Math.min(
        normalizedRefundAmount,
        remainingOrderAmount,
      );

      await tx.customerRefundMetric.create({
        data: {
          customerId,
          customerOrderMetricId: orderMetric?.id || null,
          shopifyRefundId: normalizedRefundId,
          refundAmount: cappedRefundAmount,
          refundedAt,
        },
      });

      if (orderMetric && cappedRefundAmount > 0) {
        await tx.customerOrderMetric.update({
          where: {
            id: orderMetric.id,
          },
          data: {
            refundedTotal: {
              increment: cappedRefundAmount,
            },
          },
        });
      }

      await tx.customer.update({
        where: {
          id: customerId,
        },
        data: {
          lifetimeSpend: Math.max(
            Number(customer?.lifetimeSpend || 0) - cappedRefundAmount,
            0,
          ),
          lastActivityAt: getLatestDate(customer?.lastActivityAt, refundedAt),
        },
      });

      return cappedRefundAmount;
    });

    return {
      created: true,
      amountApplied,
    };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return {
        created: false,
        amountApplied: 0,
      };
    }

    throw error;
  }
}

export const action = async ({ request }) => {
  let webhook;

  try {
    webhook = await authenticate.webhook(request);
  } catch (error) {
    return webhookAuthenticationError("refunds/create", error);
  }

  const { payload, shop } = webhook;

  try {
    const customerData = payload?.order?.customer;

    if (!customerData) {
      return new Response("No customer");
    }

    const refundAmount = getRefundAmount(payload);

    const { shop: loyaltyShop, settings } = await getLoyaltySettings(shop);

    const customer = await prisma.customer.findFirst({
      where: {
        shopId: loyaltyShop.id,
        shopifyCustomerId: String(customerData.id),
      },
    });

    if (!customer) {
      return new Response("Customer not found");
    }

    const orderId = getOrderId(payload);
    const orderName = getOrderName(payload);
    const refundId = getRefundId(payload);
    const refundMetric = await recordRefundMetric(
      customer.id,
      orderId,
      refundId,
      refundAmount,
      getRefundDate(payload),
    );
    const pointsToDeduct = refundMetric.created
      ? calculateSpendPoints(
          refundAmount,
          settings.refundSpendAmount,
          settings.refundSpendPoints,
        )
      : 0;

    if (pointsToDeduct > 0) {
      // deduct points
      await prisma.customer.update({
        where: {
          id: customer.id,
        },
        data: {
          loyaltyPoints: {
            decrement: pointsToDeduct,
          },
          lastActivityAt: new Date(),
        },
      });

      // transaction log
      await prisma.pointTransaction.create({
        data: {
          customerId: customer.id,
          points: pointsToDeduct,
          transactionType: "debit",
          reason: "Refund Deduction",
        },
      });

      if (customer.email) {
        await tryQueueAndDispatchLoyaltyEmail({
          shopId: loyaltyShop.id,
          customerId: customer.id,
          eventType: LOYALTY_EMAIL_EVENTS.REFUND_POINTS,
          recipientEmail: customer.email,
          recipientName: customer.name,
          subject: `${pointsToDeduct} loyalty points were deducted after your refund`,
          payload: {
            pointsDeducted: pointsToDeduct,
            refundAmount,
            refundId,
            orderId,
            orderName,
            shopDomain: shop,
            customerId: customer.shopifyCustomerId,
          },
          idempotencyKey: `refund-points:${loyaltyShop.id}:${customer.id}:${refundId}`,
        });
      }
    }

    if (orderId) {
      const redeemedRewards = await prisma.reward.findMany({
        where: {
          customerId: customer.id,
          rewardType: "discount",
          status: "redeemed",
          orderId,
        },
      });

      for (const reward of redeemedRewards) {
        await prisma.$transaction(async (tx) => {
          const updatedReward = await tx.reward.updateMany({
            where: {
              id: reward.id,
              status: "redeemed",
            },
            data: {
              status: "refunded",
            },
          });

          if (updatedReward.count === 0) {
            return;
          }

          await tx.customer.update({
            where: {
              id: customer.id,
            },
            data: {
              loyaltyPoints: {
                increment: reward.pointsUsed,
              },
              lastActivityAt: new Date(),
            },
          });

          await tx.pointTransaction.create({
            data: {
              customerId: customer.id,
              points: reward.pointsUsed,
              transactionType: "credit",
              reason: `Reward Points Refunded:${orderId}:${reward.rewardCode}`,
            },
          });

          await createRewardActivityLog(tx, {
            customerId: customer.id,
            rewardId: reward.id,
            rewardCode: reward.rewardCode,
            activityType: REWARD_ACTIVITY_TYPES.POINTS_REFUNDED,
            message: "Points refunded for a refunded loyalty discount order.",
            metadata: {
              orderId,
              orderName,
              pointsRefunded: reward.pointsUsed,
              discountAmount: reward.discountAmount,
            },
          });
        });

        if (customer.email) {
          await tryQueueAndDispatchLoyaltyEmail({
            shopId: loyaltyShop.id,
            customerId: customer.id,
            eventType: LOYALTY_EMAIL_EVENTS.REFUND_POINTS,
            recipientEmail: customer.email,
            recipientName: customer.name,
            subject: `${reward.pointsUsed} loyalty points were returned`,
            payload: {
              pointsRefunded: reward.pointsUsed,
              rewardCode: reward.rewardCode,
              discountAmount: reward.discountAmount,
              refundId,
              orderId,
              orderName,
              shopDomain: shop,
              customerId: customer.shopifyCustomerId,
            },
            idempotencyKey: `reward-points-refunded:${loyaltyShop.id}:${reward.id}:${refundId}`,
          });
        }
      }
    }

    return new Response("Refund processed");
  } catch (error) {
    return webhookProcessingError("refunds/create", error, { shop });
  }
};
