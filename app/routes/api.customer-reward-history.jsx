import prisma from "../db.server";
import { logError } from "../services/errors.server";
import { getCustomerStoreCreditSnapshot } from "../services/store-credit.server";
import { tryExpireCustomerPoints } from "../services/points-expiry.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};
const ORDER_APPLIED_ACTIVITY_TYPES = new Set([
  "discount_applied",
  "gift_card_applied",
]);

function json(data, init = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      ...CORS_HEADERS,
      ...init.headers,
    },
  });
}

function normalizeShopDomain(shop) {
  if (!shop) {
    return null;
  }

  try {
    return new URL(shop).hostname;
  } catch {
    return String(shop).trim() || null;
  }
}

function getShopifyCustomerId(customerId) {
  if (!customerId) {
    return null;
  }

  return String(customerId).split("/").pop();
}

function getMetadataValue(metadata, key) {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  return metadata[key] ?? null;
}

function getActivityLabel(activityType) {
  const labels = {
    discount_created: "Discount created",
    discount_applied: "Discount applied",
    discount_expired: "Discount expired",
    discount_failed: "Discount failed",
    gift_card_created: "Gift card created",
    gift_card_applied: "Gift card applied",
    gift_card_failed: "Gift card failed",
    store_credit_created: "Store credit added",
    store_credit_failed: "Store credit failed",
    points_refunded: "Points refunded",
    points_expired: "Points expired",
  };
  return labels[activityType] || activityType || "Activity";
}

function getActivityIcon(activityType) {
  const icons = {
    discount_created: "✓",
    discount_applied: "✓",
    discount_expired: "⏱",
    discount_failed: "✕",
    gift_card_created: "✓",
    gift_card_applied: "✓",
    gift_card_failed: "✕",
    store_credit_created: "✓",
    store_credit_failed: "✕",
    points_refunded: "↻",
    points_expired: "⏱",
  };
  return icons[activityType] || "•";
}

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  try {
    const url = new URL(request.url);
    const customerId = url.searchParams.get("customerId");
    const shop = url.searchParams.get("shop");

    const shopifyCustomerId = getShopifyCustomerId(customerId);
    const shopDomain = normalizeShopDomain(shop);

    if (!shopifyCustomerId) {
      return json(
        {
          success: false,
          message: "Customer ID is not available",
          history: [],
        },
        { status: 400 },
      );
    }

    const customer = await prisma.customer.findFirst({
      where: {
        shopifyCustomerId,
        ...(shopDomain
          ? {
              shop: {
                shopDomain,
              },
            }
          : {}),
      },
      select: {
        id: true,
      },
    });

    if (!customer) {
      return json({
        success: true,
        customerId: null,
        history: [],
        storeCreditAccounts: [],
        storeCreditHistory: [],
      });
    }

    await tryExpireCustomerPoints(customer.id);

    const storeCreditSnapshot = await getCustomerStoreCreditSnapshot({
      shopDomain,
      customerId: shopifyCustomerId,
      includeTransactions: true,
      operation: "Load customer store credit history",
    });

    const history = await prisma.rewardActivityLog.findMany({
      where: {
        customerId: customer.id,
      },
      select: {
        id: true,
        activityType: true,
        message: true,
        rewardCode: true,
        createdAt: true,
        metadata: true,
        reward: {
          select: {
            pointsUsed: true,
            discountAmount: true,
            orderId: true,
            status: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 50,
    });

    const formattedHistory = history.map((item) => ({
      id: item.id,
      activityType: item.activityType,
      label: getActivityLabel(item.activityType),
      icon: getActivityIcon(item.activityType),
      message: item.message,
      rewardCode: item.rewardCode,
      createdAt: item.createdAt,
      orderId: ORDER_APPLIED_ACTIVITY_TYPES.has(item.activityType)
        ? getMetadataValue(item.metadata, "orderId") ||
          item.reward?.orderId ||
          null
        : null,
      orderName: ORDER_APPLIED_ACTIVITY_TYPES.has(item.activityType)
        ? getMetadataValue(item.metadata, "orderName") || null
        : null,
      pointsUsed:
        item.reward?.pointsUsed ||
        getMetadataValue(item.metadata, "pointsUsed") ||
        getMetadataValue(item.metadata, "pointsExpired"),
      discountAmount:
        item.reward?.discountAmount ||
        getMetadataValue(item.metadata, "discountAmount") ||
        getMetadataValue(item.metadata, "amount"),
    }));

    return json({
      success: true,
      customerId: customer.id,
      history: formattedHistory,
      storeCreditBalance: storeCreditSnapshot?.balance || null,
      storeCreditAccounts: storeCreditSnapshot?.accounts || [],
      storeCreditHistory: storeCreditSnapshot?.transactions || [],
    });
  } catch (error) {
    logError("customer-reward-history", error, {
      requestUrl: request.url,
    });

    return json(
      {
        success: false,
        message: "Could not load reward history",
        history: [],
        storeCreditAccounts: [],
        storeCreditHistory: [],
      },
      { status: 500 },
    );
  }
};

export const headers = () => CORS_HEADERS;
