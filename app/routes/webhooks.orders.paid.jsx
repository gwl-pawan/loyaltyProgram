import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  addOrderRewardPoints,
  settleOrderRedemptions,
  settleGiftCardRedemptions,
} from "../services/order-points.server";
import { issueQualifiedReferralRewards } from "../services/referrals.server";
import {
  logError,
  webhookAuthenticationError,
  webhookProcessingError,
} from "../services/errors.server";

function summarizeOrderPaidPayload(payload) {
  return {
    orderId: payload?.admin_graphql_api_id || payload?.id || null,
    orderName: payload?.name || payload?.order_number || null,
    totalPrice: payload?.current_total_price || payload?.total_price || null,
    currency: payload?.currency || payload?.presentment_currency || null,
    processedAt: payload?.processed_at || null,
    loyaltyDiscountCodeCount: Array.isArray(payload?.discount_codes)
      ? payload.discount_codes.length
      : 0,
    giftCardPaymentCount: Array.isArray(payload?.gift_cards)
      ? payload.gift_cards.length
      : 0,
  };
}

async function createWebhookLog(topic, payload) {
  try {
    return await prisma.webhookLog.create({
      data: {
        topic,
        payload: summarizeOrderPaidPayload(payload),
        processed: false,
      },
    });
  } catch (error) {
    logError("orders/paid:webhook-log-create", error, { topic });
    return null;
  }
}

async function markWebhookLogProcessed(log) {
  if (!log) {
    return;
  }

  try {
    await prisma.webhookLog.update({
      where: {
        id: log.id,
      },
      data: {
        processed: true,
      },
    });
  } catch (error) {
    logError("orders/paid:webhook-log-update", error, { logId: log.id });
  }
}

export const action = async ({ request }) => {
  let webhook;

  try {
    webhook = await authenticate.webhook(request);
  } catch (error) {
    return webhookAuthenticationError("orders/paid", error);
  }

  const { shop, payload } = webhook;
  const webhookLog = await createWebhookLog("orders/paid", payload);

  try {
    await addOrderRewardPoints(shop, payload);
    await issueQualifiedReferralRewards(shop, payload);
    await settleOrderRedemptions(shop, payload);
    await settleGiftCardRedemptions(shop, payload);
    await markWebhookLogProcessed(webhookLog);

    return new Response("Webhook processed", {
      status: 200,
    });
  } catch (error) {
    return webhookProcessingError("orders/paid", error, { shop });
  }
};
