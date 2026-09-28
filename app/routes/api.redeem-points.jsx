import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import {
  DEFAULT_LOYALTY_SETTINGS,
  filterRewardsByRuleContext,
  getRewardOptionsForPreference,
  getStoreCreditRewardOption,
} from "../services/loyalty-settings.server";
import {
  createRewardActivityLog,
  expirePendingDiscountRedemptions,
  REWARD_ACTIVITY_TYPES,
  tryCreateRewardActivityLog,
} from "../services/reward-activity.server";
import { isRewardsRedemptionEnabled } from "../services/shop-plan.server";
import {
  AppError,
  logError,
  parseJsonRequest,
  runShopifyGraphql,
} from "../services/errors.server";
import { tryQueueAndDispatchLoyaltyEmail } from "../services/email-delivery.server";
import { LOYALTY_EMAIL_EVENTS } from "../services/email-notifications.server";
import { normalizeCheckoutReward } from "../services/checkout-reward.js";
import { tryExpireCustomerPoints } from "../services/points-expiry.server.js";

// CORS HEADERS
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};
const DISCOUNT_EXPIRY_HOURS = 24;
const PENDING_REDEMPTION_MESSAGE =
  "A loyalty reward is already applied to this order.";

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

function normalizeAppliedDiscountCodes(value) {
  if (!Array.isArray(value)) {
    return null;
  }

  return value
    .map((item) =>
      typeof item === "string"
        ? item
        : item?.code || item?.discountCode || item?.title,
    )
    .filter(Boolean)
    .map((code) => String(code).trim().toUpperCase());
}

function getSelectedReward(rewardOptions, rewardType, redeemPoints) {
  const storeCreditReward = rewardOptions.find(
    (reward) => reward.type === "store_credit",
  );
  const exactReward = rewardOptions.find(
    (reward) =>
      reward.points === redeemPoints &&
      (reward.type || "discount") === rewardType,
  );

  if (exactReward || rewardType !== "store_credit" || !storeCreditReward) {
    return exactReward;
  }

  if (redeemPoints % storeCreditReward.points !== 0) {
    return null;
  }

  return {
    ...storeCreditReward,
    points: redeemPoints,
    amount: Number(
      (
        storeCreditReward.amount *
        (redeemPoints / storeCreditReward.points)
      ).toFixed(2),
    ),
  };
}

function isMissingLoyaltySettingFieldError(error) {
  const message = String(error?.message || "");

  return (
    error?.code === "P2022" ||
    message.includes("redemptionRewards") ||
    message.includes("checkoutRedemptionEnabled") ||
    message.includes("storeCreditRedemptionEnabled") ||
    message.includes("preferredIntegration") ||
    message.includes("isShopifyPlus") ||
    message.includes("isPartnerDevelopment") ||
    message.includes("Unknown field")
  );
}

function hasLoyaltySettingField(fieldName) {
  const fields = prisma._runtimeDataModel?.models?.LoyaltySetting?.fields || [];

  return fields.some((field) => field.name === fieldName);
}

function isStoreCreditPermissionError(error) {
  const message = String(error?.message || "");

  return (
    message.includes("store_credit") ||
    message.includes("store credit") ||
    message.includes("customers permission") ||
    message.includes("Customer permission")
  );
}

function getPermissionErrorMessage(rewardType) {
  if (rewardType === "store_credit") {
    return "Store credit redemption needs updated app permissions. Reauthorize the app, then try again.";
  }

  if (rewardType === "gift_card") {
    return "Gift card redemption needs updated app permissions. Reauthorize the app, then try again.";
  }

  return "Reward redemption needs updated app permissions. Reauthorize the app, then try again.";
}

function isStoreCreditRedemptionEnabled(settings) {
  return settings?.storeCreditRedemptionEnabled !== false;
}

function includeStoreCreditReward(rewards, settings, ruleContext) {
  if (!isStoreCreditRedemptionEnabled(settings)) {
    return rewards.filter((reward) => reward.type !== "store_credit");
  }

  const storeCreditReward = filterRewardsByRuleContext(
    [getStoreCreditRewardOption(settings?.redemptionRewards)].filter(Boolean),
    ruleContext,
  )[0];

  if (
    !storeCreditReward ||
    rewards.some((reward) => reward.type === "store_credit")
  ) {
    return rewards;
  }

  return [...rewards, storeCreditReward].sort((a, b) => a.points - b.points);
}

async function getGrantedAccessScopes(shopDomain) {
  if (!shopDomain) {
    return null;
  }

  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    const data = await runShopifyGraphql(
      admin,
      `#graphql
        query RedeemAppAccessScopes {
          currentAppInstallation {
            accessScopes {
              handle
            }
          }
        }
      `,
      { operation: "Load redeem app access scopes" },
    );

    return new Set(
      (data.currentAppInstallation?.accessScopes || [])
        .map((scope) => scope.handle)
        .filter(Boolean),
    );
  } catch (error) {
    logError("redeem-points:access-scopes", error, { shopDomain });
    return null;
  }
}

function filterRewardsByGrantedScopes(rewards, grantedScopes) {
  if (!grantedScopes) {
    return rewards;
  }

  return rewards.filter((reward) => {
    const type = reward.type || "discount";

    if (type === "gift_card") {
      return grantedScopes.has("write_gift_cards");
    }

    if (type === "store_credit") {
      return grantedScopes.has("write_store_credit_account_transactions");
    }

    return grantedScopes.has("write_discounts");
  });
}

async function getRewardOptions(shopId, ruleContext, shopDomain) {
  const grantedScopes = await getGrantedAccessScopes(shopDomain);

  if (!hasLoyaltySettingField("redemptionRewards")) {
    return filterRewardsByGrantedScopes(
      filterRewardsByRuleContext(getRewardOptionsForPreference(), ruleContext),
      grantedScopes,
    );
  }

  try {
    const settings = await prisma.loyaltySetting.findUnique({
      where: {
        shopId,
      },
      select: {
        redemptionRewards: true,
        ...(hasLoyaltySettingField("storeCreditRedemptionEnabled")
          ? {
              storeCreditRedemptionEnabled: true,
            }
          : {}),
      },
    });

    const rewards = filterRewardsByRuleContext(
      getRewardOptionsForPreference(settings?.redemptionRewards),
      ruleContext,
    );

    return filterRewardsByGrantedScopes(
      includeStoreCreditReward(rewards, settings, ruleContext),
      grantedScopes,
    );
  } catch (error) {
    if (!isMissingLoyaltySettingFieldError(error)) {
      throw error;
    }

    return filterRewardsByGrantedScopes(
      filterRewardsByRuleContext(getRewardOptionsForPreference(), ruleContext),
      grantedScopes,
    );
  }
}

async function isRewardsRedemptionEnabledForShop(shopId) {
  if (!hasLoyaltySettingField("checkoutRedemptionEnabled")) {
    return DEFAULT_LOYALTY_SETTINGS.checkoutRedemptionEnabled;
  }

  try {
    const shop = await prisma.shop.findUnique({
      where: {
        id: shopId,
      },
      select: {
        loyaltySetting: {
          select: {
            checkoutRedemptionEnabled: true,
          },
        },
      },
    });

    return isRewardsRedemptionEnabled(shop?.loyaltySetting);
  } catch (error) {
    if (!isMissingLoyaltySettingFieldError(error)) {
      throw error;
    }

    return DEFAULT_LOYALTY_SETTINGS.checkoutRedemptionEnabled;
  }
}

async function getPendingCheckoutRedemption(
  customerId,
  rewardTypes = ["discount"],
) {
  return prisma.reward.findFirst({
    where: {
      customerId,
      rewardType: {
        in: rewardTypes,
      },
      status: "pending",
      OR: [
        {
          expiresAt: null,
        },
        {
          expiresAt: {
            gt: new Date(),
          },
        },
      ],
    },
    orderBy: {
      createdAt: "desc",
    },
    select: {
      id: true,
      customerId: true,
      rewardCode: true,
      pointsUsed: true,
      discountAmount: true,
      rewardType: true,
      expiresAt: true,
    },
  });
}

async function releasePendingCheckoutRedemption(reward) {
  const rewardLabel =
    reward.rewardType === "gift_card" ? "Gift card" : "Discount";
  const updatedReward = await prisma.reward.updateMany({
    where: {
      id: reward.id,
      status: "pending",
    },
    data: {
      status: "expired",
      failedReason: `${rewardLabel} removed from checkout before order payment`,
    },
  });

  if (updatedReward.count === 0) {
    return;
  }

  await tryCreateRewardActivityLog({
    customerId: reward.customerId,
    rewardId: reward.id,
    rewardCode: reward.rewardCode,
    activityType:
      reward.rewardType === "gift_card"
        ? REWARD_ACTIVITY_TYPES.GIFT_CARD_FAILED
        : REWARD_ACTIVITY_TYPES.DISCOUNT_EXPIRED,
    message: `${rewardLabel} removed from checkout before order payment.`,
    metadata: {
      rewardCode: reward.rewardCode,
    },
  });
}

async function runAdminGraphql(admin, mutation, variables) {
  return runShopifyGraphql(admin, mutation, {
    variables,
    operation: "Issue Shopify loyalty reward",
  });
}

async function getShopCurrencyCode(admin) {
  const data = await runAdminGraphql(
    admin,
    `#graphql
      query ShopCurrency {
        shop {
          currencyCode
        }
      }
    `,
  );

  return data.shop.currencyCode;
}

// OPTIONS HANDLER
export const loader = async () => {
  return Response.json(
    {},
    {
      headers: corsHeaders,
    },
  );
};

export const action = async ({ request }) => {
  // HANDLE PREFLIGHT REQUEST
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  let redemptionFailureContext = null;

  try {
    const body = await parseJsonRequest(request, "redeem points");

    const {
      operation = "redeem",
      customerId,
      shop,
      pointsToRedeem,
      rewardType = "discount",
      appliedDiscountCodes,
      cartSubtotal,
      cartLines,
      productIds,
      collectionIds,
      allowPendingRewardCheckout = false,
      rewardCode,
    } = body;

    const redeemPoints = Number(pointsToRedeem);
    const normalizedAppliedDiscountCodes =
      normalizeAppliedDiscountCodes(appliedDiscountCodes);

    if (!customerId) {
      return Response.json(
        {
          success: false,
          message: "Customer is required",
        },
        {
          status: 400,
          headers: corsHeaders,
        },
      );
    }

    // FIND CUSTOMER
    const appCustomerId = Number(customerId);
    const shopDomain = normalizeShopDomain(shop);
    let customer = Number.isInteger(appCustomerId)
      ? await prisma.customer.findUnique({
          where: {
            id: appCustomerId,
          },
          include: {
            shop: true,
          },
        })
      : null;

    if (!customer && shopDomain) {
      customer = await prisma.customer.findFirst({
        where: {
          shopifyCustomerId: getShopifyCustomerId(customerId),
          shop: {
            shopDomain,
          },
        },
        include: {
          shop: true,
        },
      });
    }

    if (!customer) {
      customer = await prisma.customer.findFirst({
        where: {
          shopifyCustomerId: getShopifyCustomerId(customerId),
        },
        include: {
          shop: true,
        },
      });
    }

    if (!customer) {
      return Response.json(
        {
          success: false,
          message: "Customer not found",
        },
        {
          status: 404,
          headers: corsHeaders,
        },
      );
    }

    const expiryResult = await tryExpireCustomerPoints(customer.id);

    if (expiryResult) {
      customer.loyaltyPoints = expiryResult.balance;
    }

    if (operation === "releasePendingReward") {
      const pendingRedemption = await getPendingCheckoutRedemption(
        customer.id,
        ["discount", "gift_card"],
      );
      const normalizedRewardCode = String(rewardCode || "")
        .trim()
        .toUpperCase();
      const shouldReleasePendingReward = Boolean(
        pendingRedemption &&
        normalizedRewardCode &&
        pendingRedemption.rewardCode.toUpperCase() === normalizedRewardCode,
      );

      if (shouldReleasePendingReward) {
        await releasePendingCheckoutRedemption(pendingRedemption);
      }

      return Response.json(
        {
          success: true,
          released: shouldReleasePendingReward,
        },
        {
          headers: corsHeaders,
        },
      );
    }

    if (!Number.isInteger(redeemPoints) || redeemPoints <= 0) {
      return Response.json(
        {
          success: false,
          message: "Invalid redemption request",
        },
        {
          status: 400,
          headers: corsHeaders,
        },
      );
    }

    if (!(await isRewardsRedemptionEnabledForShop(customer.shop.id))) {
      return Response.json(
        {
          success: false,
          message: "Rewards redemption is disabled",
        },
        {
          status: 403,
          headers: corsHeaders,
        },
      );
    }

    // VALIDATE POINTS
    if (customer.loyaltyPoints < redeemPoints) {
      if (rewardType === "discount") {
        await tryCreateRewardActivityLog({
          customerId: customer.id,
          activityType: REWARD_ACTIVITY_TYPES.DISCOUNT_FAILED,
          message:
            "Discount redemption failed because points were insufficient.",
          metadata: {
            pointsToRedeem: redeemPoints,
            availablePoints: customer.loyaltyPoints,
          },
        });
      }

      if (rewardType === "gift_card") {
        await tryCreateRewardActivityLog({
          customerId: customer.id,
          activityType: REWARD_ACTIVITY_TYPES.GIFT_CARD_FAILED,
          message:
            "Gift card redemption failed because points were insufficient.",
          metadata: {
            pointsToRedeem: redeemPoints,
            availablePoints: customer.loyaltyPoints,
          },
        });
      }

      return Response.json(
        {
          success: false,
          message: "Insufficient points",
        },
        {
          status: 400,
          headers: corsHeaders,
        },
      );
    }

    if (rewardType === "discount") {
      await expirePendingDiscountRedemptions();

      const pendingRedemption = await getPendingCheckoutRedemption(customer.id);

      if (pendingRedemption) {
        const pendingRewardCode = pendingRedemption.rewardCode.toUpperCase();
        const pendingCodeStillApplied =
          normalizedAppliedDiscountCodes === null ||
          normalizedAppliedDiscountCodes.includes(pendingRewardCode);

        if (!pendingCodeStillApplied) {
          await releasePendingCheckoutRedemption(pendingRedemption);
        } else if (allowPendingRewardCheckout) {
          return Response.json(
            {
              success: true,
              message: PENDING_REDEMPTION_MESSAGE,
              reward: normalizeCheckoutReward({
                ...pendingRedemption,
                rewardType: pendingRedemption.rewardType || "discount",
              }),
              pendingReward: normalizeCheckoutReward(pendingRedemption),
            },
            {
              headers: corsHeaders,
            },
          );
        } else {
          await tryCreateRewardActivityLog({
            customerId: customer.id,
            rewardId: pendingRedemption.id,
            rewardCode: pendingRedemption.rewardCode,
            activityType: REWARD_ACTIVITY_TYPES.DISCOUNT_FAILED,
            message:
              "Discount redemption blocked because another loyalty reward is already pending for this order.",
            metadata: {
              pendingRewardCode: pendingRedemption.rewardCode,
              pointsToRedeem: redeemPoints,
              rewardType,
            },
          });

          return Response.json(
            {
              success: false,
              message: PENDING_REDEMPTION_MESSAGE,
              pendingReward: pendingRedemption,
            },
            {
              status: 409,
              headers: corsHeaders,
            },
          );
        }
      }
    }

    const rewardOptions = await getRewardOptions(
      customer.shop.id,
      {
        cartSubtotal,
        lines: cartLines,
        productIds,
        collectionIds,
      },
      customer.shop.shopDomain,
    );
    const selectedReward = getSelectedReward(
      rewardOptions,
      rewardType,
      redeemPoints,
    );

    if (!selectedReward) {
      if (rewardType === "discount") {
        await tryCreateRewardActivityLog({
          customerId: customer.id,
          activityType: REWARD_ACTIVITY_TYPES.DISCOUNT_FAILED,
          message:
            "Discount redemption failed because the selected reward is not available.",
          metadata: {
            pointsToRedeem: redeemPoints,
            rewardType,
          },
        });
      }

      if (rewardType === "gift_card") {
        await tryCreateRewardActivityLog({
          customerId: customer.id,
          activityType: REWARD_ACTIVITY_TYPES.GIFT_CARD_FAILED,
          message:
            "Gift card redemption failed because the selected reward is not available.",
          metadata: {
            pointsToRedeem: redeemPoints,
            rewardType,
          },
        });
      }

      return Response.json(
        {
          success: false,
          message: "Selected reward is not available",
        },
        {
          status: 400,
          headers: corsHeaders,
        },
      );
    }

    redemptionFailureContext = {
      customerId: customer.id,
      rewardCode: null,
      selectedReward,
      pointsToRedeem: redeemPoints,
    };

    const { admin } = await unauthenticated.admin(customer.shop.shopDomain);

    const rewardTypeForStorage = selectedReward.type || "discount";
    const expiresAt =
      rewardTypeForStorage === "discount"
        ? new Date(Date.now() + DISCOUNT_EXPIRY_HOURS * 60 * 60 * 1000)
        : null;
    const issuedReward = await issueShopifyReward({
      admin,
      customer,
      selectedReward,
      expiresAt,
    });
    const shouldDeferPointDeduction =
      rewardTypeForStorage === "discount" ||
      rewardTypeForStorage === "gift_card";
    redemptionFailureContext.rewardCode = issuedReward.rewardCode;

    // DATABASE TRANSACTION
    const reward = await prisma.$transaction(async (tx) => {
      if (!shouldDeferPointDeduction) {
        await tx.customer.update({
          where: {
            id: customer.id,
          },

          data: {
            loyaltyPoints: {
              decrement: redeemPoints,
            },
            lastActivityAt: new Date(),
          },
        });

        await tx.pointTransaction.create({
          data: {
            customerId: customer.id,

            points: redeemPoints,

            transactionType: "debit",

            reason: "Reward Redemption",
          },
        });
      }

      if (shouldDeferPointDeduction) {
        await tx.customer.update({
          where: {
            id: customer.id,
          },
          data: {
            lastActivityAt: new Date(),
          },
        });
      }

      // SAVE REWARD
      const createdReward = await tx.reward.create({
        data: {
          customerId: customer.id,

          rewardCode: issuedReward.rewardCode,

          discountAmount: issuedReward.amount,
          rewardType: rewardTypeForStorage,
          shopifyRewardId: issuedReward.shopifyRewardId,

          pointsUsed: redeemPoints,

          status: shouldDeferPointDeduction ? "pending" : "active",
          expiresAt,
        },
      });

      if (shouldDeferPointDeduction) {
        await createRewardActivityLog(tx, {
          customerId: customer.id,
          rewardId: createdReward.id,
          rewardCode: createdReward.rewardCode,
          activityType:
            rewardTypeForStorage === "gift_card"
              ? REWARD_ACTIVITY_TYPES.GIFT_CARD_CREATED
              : REWARD_ACTIVITY_TYPES.DISCOUNT_CREATED,
          message:
            rewardTypeForStorage === "gift_card"
              ? "Gift card created and waiting for order payment."
              : "Discount created and waiting for order payment.",
          metadata: {
            discountAmount: issuedReward.amount,
            pointsUsed: redeemPoints,
            shopifyRewardId: issuedReward.shopifyRewardId,
            expiresAt,
          },
        });
      }

      if (rewardTypeForStorage === "store_credit") {
        await createRewardActivityLog(tx, {
          customerId: customer.id,
          rewardId: createdReward.id,
          rewardCode: createdReward.rewardCode,
          activityType: REWARD_ACTIVITY_TYPES.STORE_CREDIT_CREATED,
          message: "Store credit added successfully.",
          metadata: {
            amount: issuedReward.amount,
            currencyCode: issuedReward.currencyCode,
            balanceAfterTransaction: issuedReward.balanceAfterTransaction,
            storeCreditAccountId: issuedReward.storeCreditAccountId,
            storeCreditTransactionId: issuedReward.rewardCode,
            transactionCreatedAt: issuedReward.transactionCreatedAt,
            pointsUsed: redeemPoints,
            rewardType: rewardTypeForStorage,
          },
        });
      }

      return createdReward;
    });

    if (customer.email) {
      await tryQueueAndDispatchLoyaltyEmail({
        shopId: customer.shop.id,
        customerId: customer.id,
        eventType: LOYALTY_EMAIL_EVENTS.REWARD_CREATED,
        recipientEmail: customer.email,
        recipientName: customer.name,
        subject:
          rewardTypeForStorage === "store_credit"
            ? "Store credit added to your account"
            : "Your loyalty reward is ready",
        payload: {
          rewardType: rewardTypeForStorage,
          rewardCode: issuedReward.rewardCode,
          amount: issuedReward.amount,
          currencyCode: issuedReward.currencyCode,
          pointsUsed: redeemPoints,
          status: reward.status,
          expiresAt,
          shopDomain: customer.shop.shopDomain,
        },
        idempotencyKey: `reward-created:${customer.shop.id}:${reward.id}`,
      });
    }

    return Response.json(
      {
        success: true,
        reward: normalizeCheckoutReward({
          ...reward,
          rewardType,
          rewardCode: issuedReward.rewardCode,
          amount: issuedReward.amount,
          currencyCode: issuedReward.currencyCode,
          balanceAfterTransaction: issuedReward.balanceAfterTransaction,
          storeCreditAccountId: issuedReward.storeCreditAccountId,
          transactionCreatedAt: issuedReward.transactionCreatedAt,
        }),
      },
      {
        headers: corsHeaders,
      },
    );
  } catch (error) {
    if (error instanceof Response) {
      return Response.json(
        {
          success: false,
          message:
            "Shopify session unavailable. Open embedded app once and retry.",
        },
        {
          status: error.status === 410 ? 401 : error.status || 500,

          headers: corsHeaders,
        },
      );
    }

    logError("redeem-points", error, {
      customerId: redemptionFailureContext?.customerId,
      rewardType: redemptionFailureContext?.selectedReward?.type,
    });

    const failedRewardType =
      redemptionFailureContext?.selectedReward?.type || "discount";

    if (redemptionFailureContext) {
      if (failedRewardType === "discount") {
        await tryCreateRewardActivityLog({
          customerId: redemptionFailureContext.customerId,
          rewardCode: redemptionFailureContext.rewardCode,
          activityType: REWARD_ACTIVITY_TYPES.DISCOUNT_FAILED,
          message: error?.message || "Could not create discount code.",
          metadata: {
            pointsToRedeem: redemptionFailureContext.pointsToRedeem,
            selectedReward: redemptionFailureContext.selectedReward,
          },
        });
      }

      if (failedRewardType === "gift_card") {
        await tryCreateRewardActivityLog({
          customerId: redemptionFailureContext.customerId,
          rewardCode: redemptionFailureContext.rewardCode,
          activityType: REWARD_ACTIVITY_TYPES.GIFT_CARD_FAILED,
          message: error?.message || "Could not create gift card.",
          metadata: {
            pointsToRedeem: redemptionFailureContext.pointsToRedeem,
            selectedReward: redemptionFailureContext.selectedReward,
          },
        });
      }

      if (failedRewardType === "store_credit") {
        await tryCreateRewardActivityLog({
          customerId: redemptionFailureContext.customerId,
          rewardCode: redemptionFailureContext.rewardCode,
          activityType: REWARD_ACTIVITY_TYPES.STORE_CREDIT_FAILED,
          message: error?.message || "Could not add store credit.",
          metadata: {
            pointsToRedeem: redemptionFailureContext.pointsToRedeem,
            selectedReward: redemptionFailureContext.selectedReward,
          },
        });
      }
    }

    if (isStoreCreditPermissionError(error)) {
      return Response.json(
        {
          success: false,
          message: getPermissionErrorMessage(failedRewardType),
        },
        {
          status: 403,
          headers: corsHeaders,
        },
      );
    }

    return Response.json(
      {
        success: false,
        message:
          error instanceof AppError && error.status < 500
            ? error.message
            : "Could not redeem points. Please try again.",
        code: error instanceof AppError ? error.code : "INTERNAL_ERROR",
      },
      {
        status: 500,
        headers: corsHeaders,
      },
    );
  }
};

async function issueShopifyReward({
  admin,
  customer,
  selectedReward,
  expiresAt,
}) {
  const rewardType = selectedReward.type || "discount";

  if (rewardType === "gift_card") {
    return createGiftCardReward({ admin, selectedReward });
  }

  if (rewardType === "store_credit") {
    return createStoreCreditReward({ admin, customer, selectedReward });
  }

  return createDiscountReward({ admin, selectedReward, expiresAt });
}

async function createDiscountReward({ admin, selectedReward, expiresAt }) {
  const rewardCode =
    "LOYALTY-" + Math.random().toString(36).substring(2, 8).toUpperCase();
  const discountTags = [
    "loyalty",
    "reward-redemption",
    `points-${selectedReward.points}`,
    `discount-${selectedReward.discount}`,
  ];

  const data = await runAdminGraphql(
    admin,
    `#graphql
      mutation discountCodeBasicCreate(
        $basicCodeDiscount: DiscountCodeBasicInput!
      ) {
        discountCodeBasicCreate(
          basicCodeDiscount: $basicCodeDiscount
        ) {
          codeDiscountNode {
            id
          }
          userErrors {
            field
            code
            message
          }
        }
      }
    `,
    {
      basicCodeDiscount: {
        title: rewardCode,
        code: rewardCode,
        startsAt: new Date().toISOString(),
        endsAt: expiresAt?.toISOString(),
        tags: discountTags,
        context: {
          all: "ALL",
        },
        customerGets: {
          value: {
            discountAmount: {
              amount: selectedReward.discount.toString(),
              appliesOnEachItem: false,
            },
          },
          items: {
            all: true,
          },
        },
        combinesWith: {
          orderDiscounts: false,
          productDiscounts: false,
          shippingDiscounts: false,
        },
        appliesOncePerCustomer: true,
        usageLimit: 1,
      },
    },
  );

  const result = data.discountCodeBasicCreate;
  const userErrors = result?.userErrors ?? [];

  if (userErrors.length) {
    throw new Error(userErrors[0]?.message || "Could not create discount code");
  }

  if (!result?.codeDiscountNode?.id) {
    throw new Error("Shopify did not return a discount code");
  }

  return {
    rewardCode,
    amount: selectedReward.discount,
    shopifyRewardId: result.codeDiscountNode.id,
    discountTags,
  };
}

async function createGiftCardReward({ admin, selectedReward }) {
  const data = await runAdminGraphql(
    admin,
    `#graphql
      mutation GiftCardCreate($input: GiftCardCreateInput!) {
        giftCardCreate(input: $input) {
          giftCard {
            id
          }
          giftCardCode
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      input: {
        initialValue: selectedReward.amount.toString(),
        note: "Loyalty reward redemption",
      },
    },
  );

  const result = data.giftCardCreate;
  const userErrors = result?.userErrors ?? [];

  if (userErrors.length) {
    throw new Error(userErrors[0]?.message || "Could not create gift card");
  }

  if (!result?.giftCardCode) {
    throw new Error("Shopify did not return a gift card code");
  }

  return {
    rewardCode: result.giftCardCode,
    amount: selectedReward.amount,
  };
}

async function createStoreCreditReward({ admin, customer, selectedReward }) {
  const currencyCode = await getShopCurrencyCode(admin);

  const data = await runAdminGraphql(
    admin,
    `#graphql
      mutation StoreCreditAccountCredit(
        $id: ID!
        $creditInput: StoreCreditAccountCreditInput!
      ) {
        storeCreditAccountCredit(
          id: $id
          creditInput: $creditInput
        ) {
          storeCreditAccountTransaction {
            id
            amount {
              amount
              currencyCode
            }
            balanceAfterTransaction {
              amount
              currencyCode
            }
            createdAt
            account {
              id
              balance {
                amount
                currencyCode
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      id: `gid://shopify/Customer/${customer.shopifyCustomerId}`,
      creditInput: {
        creditAmount: {
          amount: selectedReward.amount.toString(),
          currencyCode,
        },
      },
    },
  );

  const result = data.storeCreditAccountCredit;
  const userErrors = result?.userErrors ?? [];

  if (userErrors.length) {
    throw new Error(userErrors[0]?.message || "Could not create store credit");
  }

  if (!result?.storeCreditAccountTransaction?.id) {
    throw new Error("Shopify did not return a store credit transaction");
  }

  const transaction = result.storeCreditAccountTransaction;

  return {
    rewardCode: transaction.id,
    amount: Number(transaction.amount?.amount || selectedReward.amount),
    currencyCode: transaction.amount?.currencyCode || currencyCode,
    balanceAfterTransaction: Number(
      transaction.balanceAfterTransaction?.amount ??
        transaction.account?.balance?.amount ??
        0,
    ),
    storeCreditAccountId: transaction.account?.id || null,
    transactionCreatedAt: transaction.createdAt || null,
  };
}
