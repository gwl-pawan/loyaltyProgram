import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import {
  DEFAULT_LOYALTY_SETTINGS,
  DEFAULT_REWARD_OPTIONS,
  addRewardRuleEligibility,
  filterRewardsByRuleContext,
  getRewardTypePreferenceFromSettings,
  getRewardOptionsForPreference,
  getStoreCreditRewardOption,
  limitCheckoutRewardOptions,
} from "../services/loyalty-settings.server";
import {
  getEffectiveIntegration,
  getShopPlanSelect,
  isCheckoutRedemptionAvailable,
  isRewardsRedemptionEnabled,
} from "../services/shop-plan.server";
import {
  ensureOrderWebhookSubscriptions,
  getPublicRequestOrigin,
} from "../services/webhook-subscriptions.server";
import {
  logError,
  parseJsonRequest,
  runShopifyGraphql,
} from "../services/errors.server";
import { normalizeCheckoutReward } from "../services/checkout-reward";
import { getCustomerStoreCreditSnapshot } from "../services/store-credit.server";
import { tryExpireCustomerPoints } from "../services/points-expiry.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

const checkedWebhookSubscriptions = new Set();

const TEXT_SETTINGS_FIELDS = [
  "checkoutLoginMessage",
  "checkoutDescription",
  "checkoutRewardPrompt",
  "checkoutRedeemButtonText",
  "checkoutRedeemingText",
  "checkoutPointsLabel",
  "checkoutSelectRewardMsg",
  "checkoutNotEnoughPtsMsg",
  "checkoutDisabledMsg",
  "checkoutRedemptionTitle",
  "checkoutGiftCardMsg",
  "checkoutDiscountMsg",
  "checkoutErrorMsg",
  "checkoutLoadingMsg",
  "checkoutAvailableRewardsMsg",
  "accountLoginMessage",
  "accountBalanceTitle",
  "accountAvailableLabel",
  "accountCurrentBalance",
  "accountLoadingText",
  "accountRedeemingText",
  "accountRedeemButtonText",
  "accountDisabledMsg",
  "accountNotEnoughPtsMsg",
  "accountGiftCardMsg",
  "accountErrorMsg",
  "accountConfigErrorMsg",
  "iframeCustomCss",
];

function getTextSettingsSelect() {
  return TEXT_SETTINGS_FIELDS.reduce((select, field) => {
    if (hasLoyaltySettingField(field)) {
      select[field] = true;
    }
    return select;
  }, {});
}

function buildTextSettingsResponse(loyaltySetting) {
  const response = {};
  TEXT_SETTINGS_FIELDS.forEach((field) => {
    const value = loyaltySetting?.[field];
    if (value !== undefined && value !== null) {
      response[field] = value;
    }
  });
  return response;
}

function json(data, init = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      ...CORS_HEADERS,
      ...init.headers,
    },
  });
}

function getShopifyCustomerId(customerId) {
  if (!customerId) {
    return null;
  }

  return String(customerId).split("/").pop();
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

function parseJsonParam(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getRewardRuleContextFromUrl(url) {
  const lines = parseJsonParam(url.searchParams.get("cartLines"), []);
  const productIds = parseJsonParam(url.searchParams.get("productIds"), []);
  const collectionIds = parseJsonParam(
    url.searchParams.get("collectionIds"),
    [],
  );
  const cartSubtotal = Number(url.searchParams.get("cartSubtotal") || 0);

  return {
    cartSubtotal,
    lines,
    productIds,
    collectionIds,
  };
}

async function getShopCurrencyCode(shopDomain) {
  if (!shopDomain) {
    return "USD";
  }

  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    const data = await runShopifyGraphql(
      admin,
      `#graphql
        query LoyaltyBalanceShopCurrency {
          shop {
            currencyCode
          }
        }
      `,
      { operation: "Load loyalty shop currency" },
    );

    return data.shop?.currencyCode || "USD";
  } catch (error) {
    logError("loyalty-balance:shop-currency", error, { shopDomain });
    return "USD";
  }
}

function isMissingLoyaltySettingFieldError(error) {
  const message = String(error?.message || "");

  return (
    error?.code === "P2022" ||
    message.includes("redemptionRewards") ||
    message.includes("checkoutRedemptionEnabled") ||
    message.includes("storeCreditRedemptionEnabled") ||
    message.includes("checkoutRewardLimit") ||
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

function findCustomer(shopifyCustomerId, shopDomain) {
  return prisma.customer.findFirst({
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
      loyaltyPoints: true,
    },
  });
}

function getPendingCheckoutRedemption(customerId) {
  return prisma.reward.findFirst({
    where: {
      customerId,
      rewardType: {
        in: ["discount", "gift_card"],
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
      rewardCode: true,
      pointsUsed: true,
      discountAmount: true,
      rewardType: true,
      expiresAt: true,
    },
  });
}

async function findCustomerWithRewards(shopifyCustomerId, shopDomain) {
  if (!hasLoyaltySettingField("redemptionRewards")) {
    return findCustomer(shopifyCustomerId, shopDomain);
  }

  const loyaltySettingSelect = {
    redemptionRewards: true,
    ...(hasLoyaltySettingField("checkoutRedemptionEnabled")
      ? {
          checkoutRedemptionEnabled: true,
        }
      : {}),
    ...(hasLoyaltySettingField("storeCreditRedemptionEnabled")
      ? {
          storeCreditRedemptionEnabled: true,
        }
      : {}),
    ...(hasLoyaltySettingField("checkoutRewardLimit")
      ? {
          checkoutRewardLimit: true,
        }
      : {}),
    ...(hasLoyaltySettingField("preferredIntegration")
      ? {
          preferredIntegration: true,
        }
      : {}),
    ...getTextSettingsSelect(),
  };

  try {
    return await prisma.customer.findFirst({
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
        loyaltyPoints: true,
        shop: {
          select: {
            ...getShopPlanSelect(),
            loyaltySetting: {
              select: loyaltySettingSelect,
            },
          },
        },
      },
    });
  } catch (error) {
    if (!isMissingLoyaltySettingFieldError(error)) {
      throw error;
    }

    return findCustomer(shopifyCustomerId, shopDomain);
  }
}

function getCheckoutRewardLimit(loyaltySetting) {
  return (
    loyaltySetting?.checkoutRewardLimit ??
    DEFAULT_LOYALTY_SETTINGS.checkoutRewardLimit
  );
}

function isStoreCreditRedemptionEnabled(loyaltySetting) {
  return loyaltySetting?.storeCreditRedemptionEnabled !== false;
}

function getEnabledStoreCreditReward(loyaltySetting) {
  if (!isStoreCreditRedemptionEnabled(loyaltySetting)) {
    return null;
  }

  return getStoreCreditRewardOption(loyaltySetting?.redemptionRewards);
}

function getSurfaceRewardOptions(
  rewardOptions,
  loyaltySetting,
  surface,
  ruleContext,
) {
  if (!["checkout", "theme"].includes(surface)) {
    return rewardOptions;
  }

  const checkoutAndThemeRewards = rewardOptions.filter((reward) =>
    ["discount", "gift_card"].includes(reward.type || "discount"),
  );

  if (surface === "checkout") {
    return limitCheckoutRewardOptions(
      addRewardRuleEligibility(checkoutAndThemeRewards, ruleContext),
      getCheckoutRewardLimit(loyaltySetting),
    );
  }

  const eligibleRewards = filterRewardsByRuleContext(
    checkoutAndThemeRewards,
    ruleContext,
  );

  return limitCheckoutRewardOptions(
    eligibleRewards,
    getCheckoutRewardLimit(loyaltySetting),
  );
}

async function getShopIntegrationStatus(shopDomain, surface, ruleContext) {
  if (!shopDomain || !hasLoyaltySettingField("checkoutRedemptionEnabled")) {
    const loyaltySetting = DEFAULT_LOYALTY_SETTINGS;
    const rewardOptions = getRewardOptionsForPreference(
      loyaltySetting.redemptionRewards,
    );

    return {
      checkoutRedemptionEnabled: loyaltySetting.checkoutRedemptionEnabled,
      checkoutIntegrationEnabled: loyaltySetting.checkoutRedemptionEnabled,
      effectiveIntegration: loyaltySetting.preferredIntegration,
      rewardOptions: getSurfaceRewardOptions(
        rewardOptions,
        loyaltySetting,
        surface,
        ruleContext,
      ),
      rewardTypePreference: getRewardTypePreferenceFromSettings(
        loyaltySetting.redemptionRewards,
      ),
      loyaltySetting,
    };
  }

  try {
    const shop = await prisma.shop.findUnique({
      where: {
        shopDomain,
      },
      select: {
        ...getShopPlanSelect(),
        loyaltySetting: {
          select: {
            redemptionRewards: true,
            checkoutRedemptionEnabled: true,
            ...(hasLoyaltySettingField("storeCreditRedemptionEnabled")
              ? {
                  storeCreditRedemptionEnabled: true,
                }
              : {}),
            ...(hasLoyaltySettingField("checkoutRewardLimit")
              ? {
                  checkoutRewardLimit: true,
                }
              : {}),
            ...(hasLoyaltySettingField("preferredIntegration")
              ? {
                  preferredIntegration: true,
                }
              : {}),
            ...getTextSettingsSelect(),
          },
        },
      },
    });

    const rewardOptions = getRewardOptionsForPreference(
      shop?.loyaltySetting?.redemptionRewards,
    );

    return {
      checkoutRedemptionEnabled: isRewardsRedemptionEnabled(
        shop?.loyaltySetting,
      ),
      checkoutIntegrationEnabled: isCheckoutRedemptionAvailable(
        shop,
        shop?.loyaltySetting,
      ),
      effectiveIntegration: getEffectiveIntegration(shop, shop?.loyaltySetting),
      rewardOptions: getSurfaceRewardOptions(
        rewardOptions,
        shop?.loyaltySetting,
        surface,
        ruleContext,
      ),
      rewardTypePreference: getRewardTypePreferenceFromSettings(
        shop?.loyaltySetting?.redemptionRewards,
      ),
      loyaltySetting: shop?.loyaltySetting,
    };
  } catch (error) {
    if (!isMissingLoyaltySettingFieldError(error)) {
      throw error;
    }

    const loyaltySetting = DEFAULT_LOYALTY_SETTINGS;
    const rewardOptions = getRewardOptionsForPreference(
      loyaltySetting.redemptionRewards,
    );

    return {
      checkoutRedemptionEnabled: loyaltySetting.checkoutRedemptionEnabled,
      checkoutIntegrationEnabled: loyaltySetting.checkoutRedemptionEnabled,
      effectiveIntegration: loyaltySetting.preferredIntegration,
      rewardOptions: getSurfaceRewardOptions(
        rewardOptions,
        loyaltySetting,
        surface,
        ruleContext,
      ),
      rewardTypePreference: getRewardTypePreferenceFromSettings(
        loyaltySetting.redemptionRewards,
      ),
      loyaltySetting,
    };
  }
}

async function getLoyaltyBalance(customerId, shop, surface, ruleContext) {
  const shopifyCustomerId = getShopifyCustomerId(customerId);
  const shopDomain = normalizeShopDomain(shop);
  const currencyCode = await getShopCurrencyCode(shopDomain);

  if (!shopifyCustomerId) {
    const integrationStatus = await getShopIntegrationStatus(
      shopDomain,
      surface,
      ruleContext,
    );
    const textSettings = buildTextSettingsResponse(
      integrationStatus.loyaltySetting,
    );

    return json({
      success: true,
      customerId: null,
      loyaltyPoints: 0,
      currencyCode,
      storeCreditReward: getEnabledStoreCreditReward(
        integrationStatus.loyaltySetting,
      ),
      ...integrationStatus,
      ...textSettings,
    });
  }

  const customer = await findCustomerWithRewards(shopifyCustomerId, shopDomain);

  if (!customer) {
    const integrationStatus = await getShopIntegrationStatus(
      shopDomain,
      surface,
      ruleContext,
    );
    const textSettings = buildTextSettingsResponse(
      integrationStatus.loyaltySetting,
    );

    return json({
      success: true,
      customerId: null,
      loyaltyPoints: 0,
      currencyCode,
      storeCreditReward: getEnabledStoreCreditReward(
        integrationStatus.loyaltySetting,
      ),
      ...integrationStatus,
      ...textSettings,
    });
  }
  const expiryResult = await tryExpireCustomerPoints(customer.id);

  if (expiryResult) {
    customer.loyaltyPoints = expiryResult.balance;
  }
  const rewardOptions =
    getRewardOptionsForPreference(
      customer.shop?.loyaltySetting?.redemptionRewards,
    ) || DEFAULT_REWARD_OPTIONS;
  const surfaceRewardOptions = getSurfaceRewardOptions(
    rewardOptions,
    customer.shop?.loyaltySetting,
    surface,
    ruleContext,
  );
  const checkoutRedemptionEnabled = isCheckoutRedemptionAvailable(
    customer.shop,
    customer.shop?.loyaltySetting,
  );
  const rewardsRedemptionEnabled = isRewardsRedemptionEnabled(
    customer.shop?.loyaltySetting,
  );
  const effectiveIntegration = getEffectiveIntegration(
    customer.shop,
    customer.shop?.loyaltySetting,
  );
  const textSettings = buildTextSettingsResponse(customer.shop?.loyaltySetting);
  const storeCreditReward = getEnabledStoreCreditReward(
    customer.shop?.loyaltySetting,
  );
  const storeCreditSnapshot = await getCustomerStoreCreditSnapshot({
    shopDomain: customer.shop?.shopDomain || shopDomain,
    customerId: shopifyCustomerId,
    preferredCurrencyCode: currencyCode,
    includeTransactions: surface === "account",
    operation: "Load loyalty balance and store credit history",
  });
  const pendingCheckoutRedemption = ["checkout", "theme"].includes(surface)
    ? normalizeCheckoutReward(await getPendingCheckoutRedemption(customer.id))
    : null;

  return json({
    success: true,
    customerId: customer.id,
    loyaltyPoints: customer.loyaltyPoints,
    currencyCode,
    rewardOptions: surfaceRewardOptions,
    pendingCheckoutRedemption,
    hasPendingCheckoutRedemption: Boolean(pendingCheckoutRedemption),
    storeCreditReward,
    storeCreditBalance: storeCreditSnapshot?.balance || null,
    storeCreditAccounts: storeCreditSnapshot?.accounts || [],
    storeCreditHistory: storeCreditSnapshot?.transactions || [],
    checkoutRedemptionEnabled: rewardsRedemptionEnabled,
    checkoutIntegrationEnabled: checkoutRedemptionEnabled,
    effectiveIntegration,
    rewardTypePreference: getRewardTypePreferenceFromSettings(
      customer.shop?.loyaltySetting?.redemptionRewards,
    ),
    ...textSettings,
  });
}

async function ensureWebhooksFromPublicRequest(shopDomain, origin) {
  if (!shopDomain || !origin) {
    return;
  }

  const cacheKey = `${shopDomain}:${origin}`;

  if (checkedWebhookSubscriptions.has(cacheKey)) {
    return;
  }

  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    await ensureOrderWebhookSubscriptions(admin, origin);
    checkedWebhookSubscriptions.add(cacheKey);
  } catch (error) {
    logError("loyalty-balance:webhook-subscriptions", error, {
      shopDomain,
      origin,
    });
  }
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
    const shop = url.searchParams.get("shop");
    const shopDomain = normalizeShopDomain(shop);
    const origin = getPublicRequestOrigin(request);

    await ensureWebhooksFromPublicRequest(shopDomain, origin);

    return getLoyaltyBalance(
      url.searchParams.get("customerId"),
      shop,
      url.searchParams.get("surface"),
      getRewardRuleContextFromUrl(url),
    );
  } catch (error) {
    logError("loyalty-balance:loader", error);

    return json(
      {
        success: false,
        message: "Could not load points",
        rewardOptions: DEFAULT_REWARD_OPTIONS,
      },
      { status: 500 },
    );
  }
};

export const action = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: CORS_HEADERS,
    });
  }

  try {
    const body = await parseJsonRequest(request, "loyalty balance");
    const shopDomain = normalizeShopDomain(body.shop);
    const origin = getPublicRequestOrigin(request);

    await ensureWebhooksFromPublicRequest(shopDomain, origin);

    return getLoyaltyBalance(body.customerId, body.shop, body.surface, {
      cartSubtotal: body.cartSubtotal,
      lines: body.cartLines,
      productIds: body.productIds,
      collectionIds: body.collectionIds,
    });
  } catch (error) {
    logError("loyalty-balance:action", error);

    return json(
      {
        success: false,
        message: "Could not load points",
        rewardOptions: DEFAULT_REWARD_OPTIONS,
      },
      { status: error?.status === 400 ? 400 : 500 },
    );
  }
};

export const headers = () => CORS_HEADERS;
