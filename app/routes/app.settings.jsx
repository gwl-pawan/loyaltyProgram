/* global process */
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { useEffect, useState } from "react";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { filterLoyaltySettingData } from "../services/loyalty-settings.server";
import {
  DEFAULT_GIFT_CARD_REWARD_OPTIONS,
  DEFAULT_LOYALTY_SETTINGS,
  SPECIAL_REWARD_OPTIONS,
  getRewardTypePreferenceFromSettings,
  getRewardOptionsForPreference,
  normalizeRewardConditions,
  normalizeCheckoutRewardLimit,
  normalizeRewardOptions,
  normalizeRewardTypePreference,
  serializeRewardSettings,
} from "../services/loyalty-settings.shared";
import { INTEGRATION_OPTIONS } from "../services/integrations.shared";
import { getEffectiveIntegration } from "../services/shop-plan.server";
import { logError } from "../services/errors.server";
import { ensurePlanAwareLoyaltySetup } from "../services/loyalty-installation.server";
import { getPublicRequestOrigin } from "../services/webhook-subscriptions.server";

const SETTING_FIELDS = [
  {
    name: "signupBonusPoints",
    label: "Signup bonus",
    suffix: "points",
    help: "Credit when a customer joins loyalty.",
    description:
      "Points awarded to customers when they first join your loyalty program.",
  },
  {
    name: "orderSpendAmount",
    label: "Order spend amount",
    help: "Spend threshold for order points.",
    description:
      "The minimum order amount required for customers to earn order points. Points are awarded for each threshold reached.",
  },
  {
    name: "orderSpendPoints",
    label: "Order points",
    suffix: "points",
    help: "Credit for every spend threshold reached.",
    description:
      "Points earned by customers for each order spend threshold they reach.",
  },
  {
    name: "refundSpendAmount",
    label: "Refund amount",
    help: "Refund threshold for reversing points.",
    description:
      "The minimum refund amount that triggers point reversal. Points are deducted for each threshold reached.",
  },
  {
    name: "refundSpendPoints",
    label: "Refund points",
    suffix: "points",
    help: "Debit for every refund threshold reached.",
    description:
      "Points deducted from customers for each refund threshold they reach.",
  },
  {
    name: "referralAdvocatePoints",
    label: "Referrer reward",
    suffix: "points",
    help: "Credit after the referred customer's first paid order.",
    description: "Points awarded to the customer who shared the referral link.",
  },
  {
    name: "referralFriendPoints",
    label: "Friend reward",
    suffix: "points",
    help: "Credit after the referred customer's first paid order.",
    description: "Points awarded to the new customer who used the referral link.",
  },
];

const RULE_GROUPS = [
  {
    title: "Signup",
    description: "Points customers receive when they join loyalty.",
    fields: ["signupBonusPoints"],
  },
  {
    title: "Orders",
    description: "Points customers earn based on completed order spend.",
    fields: ["orderSpendAmount", "orderSpendPoints"],
  },
  {
    title: "Refunds",
    description: "Points removed when refunded spend should reverse rewards.",
    fields: ["refundSpendAmount", "refundSpendPoints"],
  },
  {
    title: "Referrals",
    description: "Reward both customers after a referred friend's first paid order.",
    fields: ["referralAdvocatePoints", "referralFriendPoints"],
  },
];

const SEGMENTATION_FIELDS = [
  {
    name: "vipSpendThreshold",
    label: "VIP spend threshold",
    min: "0",
    step: "0.01",
    inputMode: "decimal",
    details: "Customers at or above this lifetime spend are marked as VIP.",
  },
  {
    name: "inactiveCustomerDays",
    label: "Inactive after",
    min: "1",
    max: "3650",
    step: "1",
    inputMode: "numeric",
    suffix: "days",
    details: "Customers with no order or loyalty activity for this many days.",
  },
  {
    name: "topSpenderPercent",
    label: "Top spender percentage",
    min: "1",
    max: "100",
    step: "1",
    inputMode: "numeric",
    suffix: "%",
    details: "Marks the highest-spending customers by lifetime net spend.",
  },
];

const REWARD_TYPE_CHOICES = [
  {
    value: "gift_card",
    label: "Gift card rewards",
    description: "Customers redeem points for gift cards.",
  },
  {
    value: "discount",
    label: "Discount rewards",
    description: "Customers redeem points for discount codes.",
  },
  {
    value: "both",
    label: "Both",
    description: "Customers can choose gift cards or discounts.",
  },
];

const IFRAME_TEXT_FIELDS = [
  {
    name: "iframeEyebrow",
    label: "Eyebrow text",
    details: "Small label above the iframe heading.",
  },
  {
    name: "iframeHeading",
    label: "Heading",
    details: "Main title shown at the top of the iframe.",
  },
  {
    name: "iframeLoggedOutMessage",
    label: "Logged-out message",
    details: "Message shown when no customer is signed in.",
  },
  {
    name: "iframeLoginLabel",
    label: "Login button text",
    details: "Text for the sign-in button/link.",
  },
  {
    name: "iframePointsTemplate",
    label: "Points message",
    details: "Use {points} where the current balance should appear.",
  },
  {
    name: "iframeRewardsHeading",
    label: "Rewards heading",
    details: "Heading above reward options.",
  },
  {
    name: "iframeNoRewardsMessage",
    label: "No rewards message",
    details: "Message shown when no reward can be displayed.",
  },
  {
    name: "iframeRedeemButtonText",
    label: "Redeem button text",
    details: "CTA text for available rewards.",
  },
];

const IFRAME_COLOR_FIELDS = [
  {
    name: "iframeAccentColor",
    label: "Button color",
  },
  {
    name: "iframeBackgroundColor",
    label: "Background",
  },
  {
    name: "iframeForegroundColor",
    label: "Text color",
  },
  {
    name: "iframeBorderColor",
    label: "Border color",
  },
];

const IFRAME_FONT_FAMILY_OPTIONS = [
  {
    value: "system",
    label: "System",
  },
  {
    value: "inter",
    label: "Inter",
  },
  {
    value: "roboto",
    label: "Roboto",
  },
  {
    value: "open_sans",
    label: "Open Sans",
  },
  {
    value: "lato",
    label: "Lato",
  },
  {
    value: "montserrat",
    label: "Montserrat",
  },
  {
    value: "poppins",
    label: "Poppins",
  },
  {
    value: "nunito",
    label: "Nunito",
  },
  {
    value: "raleway",
    label: "Raleway",
  },
  {
    value: "playfair_display",
    label: "Playfair Display",
  },
  {
    value: "merriweather",
    label: "Merriweather",
  },
  {
    value: "oswald",
    label: "Oswald",
  },
  {
    value: "source_sans_3",
    label: "Source Sans 3",
  },
  {
    value: "arial",
    label: "Arial",
  },
  {
    value: "georgia",
    label: "Georgia",
  },
  {
    value: "mono",
    label: "Mono",
  },
];

const REWARD_FIELD_CONFIG = {
  discount: {
    amountKey: "discount",
    amountName: "discountRewardDiscounts",
    amountLabel: "Discount amount",
    amountErrorPrefix: "discountRewardDiscounts",
    amountSummaryLabel: "Total discount",
    defaultRows: [
      {
        points: "",
        discount: "",
        minSpend: "",
        products: [],
        collections: [],
      },
    ],
    emptyRow: {
      points: "",
      discount: "",
      minSpend: "",
      products: [],
      collections: [],
    },
    heading: "Discount reward options",
    pointsName: "discountRewardPoints",
    pointsErrorPrefix: "discountRewardPoints",
    rewardType: "discount",
    valueLabel: "discount",
  },
  gift_card: {
    amountKey: "amount",
    amountName: "giftCardRewardAmounts",
    amountLabel: "Gift card amount",
    amountErrorPrefix: "giftCardRewardAmounts",
    amountSummaryLabel: "Total gift card value",
    defaultRows: DEFAULT_GIFT_CARD_REWARD_OPTIONS.map((reward) => ({
      points: String(reward.points),
      amount: String(reward.amount),
      minSpend: "",
      products: [],
      collections: [],
    })),
    emptyRow: {
      points: "",
      amount: "",
      minSpend: "",
      products: [],
      collections: [],
    },
    heading: "Gift card reward options",
    pointsName: "giftCardRewardPoints",
    pointsErrorPrefix: "giftCardRewardPoints",
    rewardType: "gift_card",
    valueLabel: "gift card",
  },
  store_credit: {
    allowRules: false,
    amountKey: "amount",
    amountName: "storeCreditRewardAmounts",
    amountLabel: "Store credit amount",
    amountErrorPrefix: "storeCreditRewardAmounts",
    amountSummaryLabel: "Total store credit value",
    defaultRows: SPECIAL_REWARD_OPTIONS.map((reward) => ({
      points: String(reward.points),
      amount: String(reward.amount),
      minSpend: "",
      products: [],
      collections: [],
    })),
    emptyRow: {
      points: "",
      amount: "",
      minSpend: "",
      products: [],
      collections: [],
    },
    heading: "Store credit reward options",
    pointsName: "storeCreditRewardPoints",
    pointsErrorPrefix: "storeCreditRewardPoints",
    rewardType: "store_credit",
    singleRow: true,
    valueLabel: "store credit",
  },
};

function getEditableRewardRows(value, rewardType) {
  const rewards = normalizeRewardOptions(value) || [];
  const config = REWARD_FIELD_CONFIG[rewardType];
  const typedRewards = rewards.filter(
    (reward) => (reward.type || "discount") === rewardType,
  );

  if (typedRewards.length === 0) {
    return config.defaultRows;
  }

  const editableRewards = config.singleRow
    ? typedRewards.slice(0, 1)
    : typedRewards;

  return editableRewards.map((reward) => ({
    points: String(reward.points),
    [config.amountKey]: String(reward[config.amountKey]),
    minSpend: reward.conditions?.minSpend
      ? String(reward.conditions.minSpend)
      : "",
    products: getConditionResourceSelections(reward.conditions, "product"),
    collections: getConditionResourceSelections(
      reward.conditions,
      "collection",
    ),
  }));
}

function getConditionResourceSelections(conditions, type) {
  const selectionKey = type === "product" ? "products" : "collections";
  const idKey = type === "product" ? "productIds" : "collectionIds";

  if (Array.isArray(conditions?.[selectionKey])) {
    return conditions[selectionKey]
      .map((item) => ({
        id: String(item?.id || "").trim(),
        title: String(item?.title || item?.id || "").trim(),
      }))
      .filter((item) => item.id);
  }

  if (!Array.isArray(conditions?.[idKey])) {
    return [];
  }

  return conditions[idKey]
    .map((id) => String(id || "").trim())
    .filter(Boolean)
    .map((id) => ({
      id,
      title: id.split("/").pop(),
    }));
}

function parseResourceSelections(value) {
  try {
    const parsed = JSON.parse(value || "[]");

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((item) => ({
        id: String(item?.id || "").trim(),
        title: String(item?.title || item?.id || "").trim(),
      }))
      .filter((item) => item.id);
  } catch {
    return [];
  }
}

function getSubmittedRewardRows(formData, rewardType) {
  const config = REWARD_FIELD_CONFIG[rewardType];
  const points = formData.getAll(config.pointsName);
  const amounts = formData.getAll(config.amountName);
  const minSpend = formData.getAll(`${rewardType}RewardMinSpend`);
  const products = formData.getAll(`${rewardType}RewardProducts`);
  const collections = formData.getAll(`${rewardType}RewardCollections`);
  const rowCount = Math.max(
    points.length,
    amounts.length,
    minSpend.length,
    products.length,
    collections.length,
  );

  const rows = Array.from({ length: rowCount }, (_, index) => ({
    points: String(points[index] || "").trim(),
    [config.amountKey]: String(amounts[index] || "").trim(),
    minSpend: String(minSpend[index] || "").trim(),
    products: parseResourceSelections(products[index]),
    collections: parseResourceSelections(collections[index]),
  }));

  return config.singleRow ? rows.slice(0, 1) : rows;
}

function hasRewardRuleInput(row) {
  return Boolean(
    row.minSpend || row.products?.length > 0 || row.collections?.length > 0,
  );
}

function parseRewardRows(rows, rewardType, { requireRewards = true } = {}) {
  const config = REWARD_FIELD_CONFIG[rewardType];
  const rewards = [];
  const errors = {};

  rows.forEach((row, index) => {
    const hasPoints = row.points !== "";
    const hasAmount = row[config.amountKey] !== "";
    const hasRules = hasRewardRuleInput(row);

    if (!hasPoints && !hasAmount && !hasRules) {
      return;
    }

    const points = Number(row.points);
    const amount = Number(row[config.amountKey]);
    const minSpend = Number(row.minSpend);

    if (!Number.isInteger(points) || points < 1) {
      errors[`${config.pointsErrorPrefix}.${index}`] =
        "Enter whole points greater than 0.";
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      errors[`${config.amountErrorPrefix}.${index}`] =
        rewardType === "discount"
          ? "Enter a discount greater than 0."
          : `Enter a ${config.valueLabel} amount greater than 0.`;
    }

    if (row.minSpend && (!Number.isFinite(minSpend) || minSpend <= 0)) {
      errors[`${rewardType}RewardMinSpend.${index}`] =
        "Enter a spend amount greater than 0.";
    }

    if (
      Number.isInteger(points) &&
      points > 0 &&
      Number.isFinite(amount) &&
      amount > 0 &&
      (!row.minSpend || (Number.isFinite(minSpend) && minSpend > 0))
    ) {
      const conditions = normalizeRewardConditions({
        minSpend: row.minSpend,
        products: row.products,
        collections: row.collections,
      });

      rewards.push({
        type: config.rewardType,
        points,
        [config.amountKey]: amount,
        ...(Object.keys(conditions).length > 0 ? { conditions } : {}),
      });
    }
  });

  if (requireRewards && rewards.length === 0) {
    errors.redemptionRewards = `Add at least one ${config.valueLabel} reward.`;
  }

  if (Object.keys(errors).length > 0) {
    return {
      errors,
      rewards: null,
    };
  }

  return {
    errors,
    rewards: rewards.sort((a, b) => a.points - b.points),
  };
}

function getConfiguredRewardsByType(value, rewardType) {
  return (normalizeRewardOptions(value) || []).filter(
    (reward) => (reward.type || "discount") === rewardType,
  );
}

function parsePositiveInteger(formData, fieldName) {
  const value = Number(formData.get(fieldName));

  if (!Number.isInteger(value) || value < 1) {
    return null;
  }

  return value;
}

function parseCheckoutRewardLimit(formData) {
  const value = Number(formData.get("checkoutRewardLimit"));

  if (!Number.isInteger(value) || value < 1 || value > 20) {
    return null;
  }

  return value;
}

function parseNonNegativeAmount(formData, fieldName) {
  const value = Number(formData.get(fieldName));

  if (!Number.isFinite(value) || value < 0) {
    return null;
  }

  return value;
}

function parseBoundedInteger(formData, fieldName, min, max) {
  const value = Number(formData.get(fieldName));

  if (!Number.isInteger(value) || value < min || value > max) {
    return null;
  }

  return value;
}

function normalizeTextSetting(formData, fieldName) {
  const fallback = DEFAULT_LOYALTY_SETTINGS[fieldName] || "";
  const value = String(formData.get(fieldName) || "").trim();

  return value || fallback;
}

function normalizeColorSetting(formData, fieldName) {
  const fallback = DEFAULT_LOYALTY_SETTINGS[fieldName] || "#000000";
  const value = String(formData.get(fieldName) || "").trim();

  if (/^#[0-9a-f]{6}$/i.test(value)) {
    return value;
  }

  return fallback;
}

function normalizeFontFamilySetting(formData) {
  const value = String(formData.get("iframeFontFamily") || "").trim();

  return IFRAME_FONT_FAMILY_OPTIONS.some((option) => option.value === value)
    ? value
    : DEFAULT_LOYALTY_SETTINGS.iframeFontFamily;
}

function parseIframeFontSize(formData) {
  const value = Number(formData.get("iframeFontSize"));

  if (!Number.isInteger(value) || value < 12 || value > 20) {
    return null;
  }

  return value;
}

function normalizeCustomCssSetting(formData) {
  return String(formData.get("iframeCustomCss") || "")
    .replace(/<\/style/gi, "<\\/style")
    .slice(0, 20000);
}

function getSettingValue(values, fieldName) {
  return String(
    values?.[fieldName] ?? DEFAULT_LOYALTY_SETTINGS[fieldName] ?? "",
  );
}

function getBooleanSettingValue(values, fieldName) {
  const value = values?.[fieldName] ?? DEFAULT_LOYALTY_SETTINGS[fieldName];

  return value === true || value === "true";
}

function getIframeAppearanceValues(values) {
  return {
    ...Object.fromEntries(
      IFRAME_COLOR_FIELDS.map((field) => [
        field.name,
        getSettingValue(values, field.name),
      ]),
    ),
    iframeFontFamily: getSettingValue(values, "iframeFontFamily"),
    iframeFontSize: getSettingValue(values, "iframeFontSize"),
    iframeCustomCss: getSettingValue(values, "iframeCustomCss"),
  };
}

async function getSavedIframeAppearance(shopId) {
  const rows = await prisma.$queryRaw`
    SELECT
      iframeAccentColor,
      iframeBackgroundColor,
      iframeForegroundColor,
      iframeBorderColor,
      iframeFontFamily,
      iframeFontSize,
      iframeCustomCss
    FROM LoyaltySetting
    WHERE shopId = ${shopId}
    LIMIT 1
  `;

  return rows?.[0] || {};
}

async function mergeSavedIframeAppearance(settings, shopId) {
  return {
    ...settings,
    ...(await getSavedIframeAppearance(shopId)),
  };
}

async function updateSavedIframeAppearance(shopId, values) {
  await prisma.$executeRaw`
    UPDATE LoyaltySetting
    SET
      iframeAccentColor = ${values.iframeAccentColor},
      iframeBackgroundColor = ${values.iframeBackgroundColor},
      iframeForegroundColor = ${values.iframeForegroundColor},
      iframeBorderColor = ${values.iframeBorderColor},
      iframeFontFamily = ${values.iframeFontFamily},
      iframeFontSize = ${values.iframeFontSize},
      iframeCustomCss = ${values.iframeCustomCss}
    WHERE shopId = ${shopId}
  `;
}

function getRewardTypePreferenceValue(values) {
  return normalizeRewardTypePreference(
    values?.rewardTypePreference ??
      getRewardTypePreferenceFromSettings(values?.redemptionRewards) ??
      "both",
  );
}

function formatNumber(value) {
  return new Intl.NumberFormat("en").format(Number(value) || 0);
}

function formatCurrency(value, currencyCode) {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: currencyCode,
    }).format(Number(value) || 0);
  } catch {
    return `${currencyCode} ${formatNumber(value)}`;
  }
}

function getRewardSummary(rows, rewardType) {
  const config = REWARD_FIELD_CONFIG[rewardType];
  const validRows = rows
    .map((row) => ({
      points: Number(row.points),
      amount: Number(row[config.amountKey]),
    }))
    .filter(
      (row) =>
        Number.isInteger(row.points) &&
        row.points > 0 &&
        Number.isFinite(row.amount) &&
        row.amount > 0,
    )
    .sort((a, b) => a.points - b.points);

  const bestValueReward = validRows.reduce((best, row) => {
    if (!best) {
      return row;
    }

    const currentValue = row.amount / row.points;
    const bestValue = best.amount / best.points;

    return currentValue > bestValue ? row : best;
  }, null);

  return {
    validRows,
    bestValueReward,
    totalRewardValue: validRows.reduce((sum, row) => sum + row.amount, 0),
  };
}

function getEndpointUrl(apiBaseUrl, path, query = "") {
  return `${apiBaseUrl}${path}${query}`;
}

function normalizeOrigin(value) {
  if (!value) {
    return "";
  }

  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

async function getDevManifestAppOrigin() {
  try {
    const manifest = JSON.parse(
      await readFile(
        path.join(process.cwd(), ".shopify/dev-bundle/manifest.json"),
        "utf8",
      ),
    );
    const appUrl = manifest?.modules?.find(
      (module) => module?.type === "app_home",
    )?.config?.app_url;
    const origin = normalizeOrigin(appUrl);

    return origin.endsWith(".trycloudflare.com") ? origin : "";
  } catch {
    return "";
  }
}

async function getSettingsApiBaseUrl(request) {
  return (await getDevManifestAppOrigin()) || getPublicRequestOrigin(request);
}

function buildHeadlessApiSections(apiBaseUrl, shop) {
  const shopQuery = `shop=${shop}`;

  return [
    {
      title: "Program settings",
      method: "GET",
      description:
        "Fetch active loyalty earning rules, redemption status, reward preference, and configured reward options.",
      url: getEndpointUrl(apiBaseUrl, "/api/loyalty-program", `?${shopQuery}`),
      exampleUrl: getEndpointUrl(
        apiBaseUrl,
        "/api/loyalty-program",
        `?${shopQuery}`,
      ),
      parameters: [
        {
          name: "shop",
          type: "string",
          defaultValue: "-",
          description: "Your Shopify store domain. Required.",
        },
      ],
    },
    {
      title: "Customer balance",
      method: "GET or POST",
      description:
        "Fetch loyalty points, available rewards, pending checkout discounts, and customer-facing text settings.",
      url: getEndpointUrl(
        apiBaseUrl,
        "/api/loyalty-balance",
        `?customerId={customer_id}&${shopQuery}&surface=theme`,
      ),
      exampleUrl: getEndpointUrl(
        apiBaseUrl,
        "/api/loyalty-balance",
        `?customerId=1234567890&${shopQuery}&surface=theme`,
      ),
      parameters: [
        {
          name: "customerId",
          type: "string",
          defaultValue: "-",
          description: "Shopify customer ID or Customer GID. Required.",
        },
        {
          name: "shop",
          type: "string",
          defaultValue: "-",
          description: "Your Shopify store domain. Required.",
        },
        {
          name: "surface",
          type: "string",
          defaultValue: "theme",
          description: "Calling surface. Values: theme / checkout / account.",
        },
      ],
    },
    {
      title: "Reward history",
      method: "GET",
      description:
        "Fetch recent reward activity for a customer, including readable labels, reward codes, order IDs, and point values.",
      url: getEndpointUrl(
        apiBaseUrl,
        "/api/customer-reward-history",
        `?customerId={customer_id}&${shopQuery}`,
      ),
      exampleUrl: getEndpointUrl(
        apiBaseUrl,
        "/api/customer-reward-history",
        `?customerId=1234567890&${shopQuery}`,
      ),
      parameters: [
        {
          name: "customerId",
          type: "string",
          defaultValue: "-",
          description: "Shopify customer ID or Customer GID. Required.",
        },
        {
          name: "shop",
          type: "string",
          defaultValue: "-",
          description: "Your Shopify store domain. Required.",
        },
      ],
    },
    {
      title: "Redeem points",
      method: "POST",
      description:
        "Create a discount, gift card, or store-credit reward for a customer. Fully CORS enabled.",
      url: getEndpointUrl(apiBaseUrl, "/api/redeem-points"),
      exampleUrl: getEndpointUrl(apiBaseUrl, "/api/redeem-points"),
      parameters: [
        {
          name: "customerId",
          type: "string",
          defaultValue: "-",
          description:
            "App customer ID, Shopify customer ID, or Customer GID. Required.",
        },
        {
          name: "shop",
          type: "string",
          defaultValue: "-",
          description:
            "Your Shopify store domain. Required for Shopify customer IDs.",
        },
        {
          name: "pointsToRedeem",
          type: "number",
          defaultValue: "-",
          description: "Points to redeem. Required.",
        },
        {
          name: "rewardType",
          type: "string",
          defaultValue: "discount",
          description:
            "Reward type. Values: discount / gift_card / store_credit.",
        },
      ],
      bodyExample: `{
  "customerId": "1234567890",
  "shop": "${shop}",
  "pointsToRedeem": 100,
  "rewardType": "discount"
}`,
    },
    {
      title: "Hydrogen protected balance",
      method: "GET or POST",
      description:
        "Token-protected balance endpoint for Hydrogen or other private headless storefronts. Send Authorization: Bearer <token>.",
      url: getEndpointUrl(
        apiBaseUrl,
        "/api/hydrogen/loyalty-balance",
        `?customerId={customer_id}&${shopQuery}&surface=hydrogen`,
      ),
      exampleUrl: getEndpointUrl(
        apiBaseUrl,
        "/api/hydrogen/loyalty-balance",
        `?customerId=1234567890&${shopQuery}&surface=hydrogen`,
      ),
      parameters: [
        {
          name: "Authorization",
          type: "header",
          defaultValue: "-",
          description: "Bearer token from HYDROGEN_LOYALTY_API_TOKEN.",
        },
        {
          name: "customerId",
          type: "string",
          defaultValue: "-",
          description: "Shopify customer ID or Customer GID. Required.",
        },
        {
          name: "shop",
          type: "string",
          defaultValue: "-",
          description: "Your Shopify store domain. Required.",
        },
      ],
    },
    {
      title: "Hydrogen protected reward history",
      method: "GET",
      description:
        "Token-protected reward activity endpoint for Hydrogen account pages and private customer portals.",
      url: getEndpointUrl(
        apiBaseUrl,
        "/api/hydrogen/customer-reward-history",
        `?customerId={customer_id}&${shopQuery}`,
      ),
      exampleUrl: getEndpointUrl(
        apiBaseUrl,
        "/api/hydrogen/customer-reward-history",
        `?customerId=1234567890&${shopQuery}`,
      ),
      parameters: [
        {
          name: "Authorization",
          type: "header",
          defaultValue: "-",
          description: "Bearer token from HYDROGEN_LOYALTY_API_TOKEN.",
        },
        {
          name: "customerId",
          type: "string",
          defaultValue: "-",
          description: "Shopify customer ID or Customer GID. Required.",
        },
        {
          name: "shop",
          type: "string",
          defaultValue: "-",
          description: "Your Shopify store domain. Required.",
        },
      ],
    },
    {
      title: "Hydrogen protected redeem",
      method: "POST",
      description:
        "Token-protected redemption endpoint for private Hydrogen checkout or account flows.",
      url: getEndpointUrl(apiBaseUrl, "/api/hydrogen/redeem-points"),
      exampleUrl: getEndpointUrl(apiBaseUrl, "/api/hydrogen/redeem-points"),
      parameters: [
        {
          name: "Authorization",
          type: "header",
          defaultValue: "-",
          description: "Bearer token from HYDROGEN_LOYALTY_API_TOKEN.",
        },
        {
          name: "customerId",
          type: "string",
          defaultValue: "-",
          description:
            "App customer ID, Shopify customer ID, or Customer GID. Required.",
        },
        {
          name: "shop",
          type: "string",
          defaultValue: "-",
          description:
            "Your Shopify store domain. Required for Shopify customer IDs.",
        },
        {
          name: "pointsToRedeem",
          type: "number",
          defaultValue: "-",
          description: "Points to redeem. Required.",
        },
        {
          name: "rewardType",
          type: "string",
          defaultValue: "discount",
          description:
            "Reward type. Values: discount / gift_card / store_credit.",
        },
      ],
      bodyExample: `{
  "customerId": "1234567890",
  "shop": "${shop}",
  "pointsToRedeem": 100,
  "rewardType": "discount"
}`,
    },
  ];
}

function buildIframeWidgetSections(apiBaseUrl, shop) {
  const proxyUrl = `${apiBaseUrl}/api/loyalty-iframe?shop=${encodeURIComponent(
    shop,
  )}&customerId={customer_id}`;
  const floatingProxyUrl = `${apiBaseUrl}/api/loyalty-iframe?shop=${encodeURIComponent(
    shop,
  )}&customerId={customer_id}&surface=floating`;
  const customerAccountUrl = `${apiBaseUrl}/api/loyalty-iframe?shop=${encodeURIComponent(
    shop,
  )}&customerId={customer_id}&surface=account`;

  return [
    {
      title: "Theme loyalty iframe",
      description:
        "Ready-made loyalty UI for Shopify themes and storefront pages. Replace {customer_id} with the Shopify customer ID.",
      embedUrl: proxyUrl,
      iframeHtml: `<iframe
  src="${proxyUrl}"
  style="width: 100%; height: 520px; border: 0; border-radius: 8px; display: block;"
  title="Loyalty rewards"
></iframe>`,
      details: "Use this when you need the standard loyalty iframe.",
    },
    {
      title: "Floating rewards iframe",
      description:
        "Iframe version of the floating Rewards button and panel. Replace {customer_id} with the Shopify customer ID.",
      embedUrl: floatingProxyUrl,
      iframeHtml: `<div id="loyalty-floating-iframe-wrapper" style="position: fixed; right: 0; bottom: 0; z-index: 2147483000; width: min(220px, 100vw); height: 92px; pointer-events: none;">
  <iframe
    id="loyalty-floating-iframe"
    src="${floatingProxyUrl}"
    style="width: 100%; height: 100%; border: 0; background: transparent; pointer-events: auto;"
    title="Floating loyalty rewards"
  ></iframe>
</div>
<script>
  window.addEventListener("message", function(event) {
    if (event.data && event.data.type === "loyalty-floating-iframe-state") {
      var wrapper = document.getElementById("loyalty-floating-iframe-wrapper");
      var iframe = document.getElementById("loyalty-floating-iframe");
      if (!wrapper || !iframe || iframe.contentWindow !== event.source) return;
      wrapper.style.width = event.data.open ? "min(420px, 100vw)" : "min(220px, 100vw)";
      wrapper.style.height = event.data.open ? "min(720px, 100vh)" : "92px";
    }
  });
</script>`,
      details:
        "Use this when you need the floating Rewards launcher as an iframe on the storefront.",
    },
    {
      title: "Customer account iframe wallet",
      description:
        "Iframe-rendered customer account wallet for store-credit loyalty pages. Replace {customer_id} with the authenticated customer ID.",
      embedUrl: customerAccountUrl,
      iframeHtml: `<iframe
  src="${customerAccountUrl}"
  style="width: 100%; height: 520px; border: 0; border-radius: 8px; display: block;"
  title="Customer account loyalty wallet"
></iframe>`,
      details:
        "Customer account UI extensions cannot embed raw iframe HTML directly, so use this URL from supported storefronts or the customer-account iframe link mode.",
    },
  ];
}

/* eslint-disable react/prop-types */

// InfoIcon component for field descriptions
function InfoIcon({ tooltip }) {
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);

  return (
    <span
      className="info-icon-wrapper"
      onMouseEnter={() => setIsTooltipVisible(true)}
      onMouseLeave={() => setIsTooltipVisible(false)}
      onFocus={() => setIsTooltipVisible(true)}
      onBlur={() => setIsTooltipVisible(false)}
      role="tooltip"
      aria-label={tooltip}
    >
      <svg
        className="info-icon"
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="currentColor"
        aria-hidden="true"
      >
        <circle
          cx="12"
          cy="12"
          r="10"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
        <text
          x="12"
          y="17"
          textAnchor="middle"
          fontSize="12"
          fontWeight="bold"
          fill="currentColor"
        >
          i
        </text>
      </svg>
      {isTooltipVisible && <div className="tooltip-popup">{tooltip}</div>}
    </span>
  );
}

function HeadlessApiEndpoint({ endpoint, initiallyOpen = false }) {
  const [copiedValue, setCopiedValue] = useState(null);

  const copyValue = async (value) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedValue(value);
      window.setTimeout(() => setCopiedValue(null), 1600);
    } catch {
      setCopiedValue(null);
    }
  };

  return (
    <section className="api-endpoint">
      <div className="api-endpoint-heading">
        <div>
          <h3>{endpoint.title}</h3>
          <p>{endpoint.description}</p>
        </div>
        <span className="method-pill">{endpoint.method}</span>
      </div>

      <div className="api-url-row">
        <code>{endpoint.url}</code>
        <s-button type="button" onClick={() => copyValue(endpoint.url)}>
          {copiedValue === endpoint.url ? "Copied" : "Copy API URL"}
        </s-button>
      </div>

      <details className="api-details" open={initiallyOpen}>
        <summary>Query and body parameters</summary>
        <div className="api-parameter-table" role="table">
          <div className="api-table-row api-table-head" role="row">
            <span role="columnheader">Parameter</span>
            <span role="columnheader">Type</span>
            <span role="columnheader">Default</span>
            <span role="columnheader">Description</span>
          </div>
          {endpoint.parameters.map((parameter) => (
            <div className="api-table-row" role="row" key={parameter.name}>
              <span role="cell">
                <code>{parameter.name}</code>
              </span>
              <span role="cell">{parameter.type}</span>
              <span role="cell">{parameter.defaultValue}</span>
              <span role="cell">{parameter.description}</span>
            </div>
          ))}
        </div>

        {endpoint.bodyExample ? (
          <div className="api-example-block">
            <div className="api-example-heading">
              <span>Example POST body</span>
              <s-button
                type="button"
                onClick={() => copyValue(endpoint.bodyExample)}
              >
                {copiedValue === endpoint.bodyExample ? "Copied" : "Copy"}
              </s-button>
            </div>
            <pre>{endpoint.bodyExample}</pre>
          </div>
        ) : null}

        <div className="api-example-block">
          <div className="api-example-heading">
            <span>Example request</span>
            <s-button
              type="button"
              onClick={() => copyValue(endpoint.exampleUrl)}
            >
              {copiedValue === endpoint.exampleUrl ? "Copied" : "Copy"}
            </s-button>
          </div>
          <code>{endpoint.exampleUrl}</code>
        </div>
      </details>
    </section>
  );
}

function IframeWidgetCard({ widget, initiallyOpen = false }) {
  const [copiedValue, setCopiedValue] = useState(null);

  const copyValue = async (value) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedValue(value);
      window.setTimeout(() => setCopiedValue(null), 1600);
    } catch {
      setCopiedValue(null);
    }
  };

  return (
    <section className="iframe-widget-card">
      <div className="iframe-widget-heading">
        <div>
          <h3>{widget.title}</h3>
          <p>{widget.description}</p>
        </div>
      </div>

      <details className="api-details" open={initiallyOpen}>
        <summary>Iframe HTML</summary>
        <div className="api-example-block">
          <div className="api-example-heading">
            <span>{widget.details}</span>
            <s-button
              type="button"
              onClick={() => copyValue(widget.iframeHtml)}
            >
              {copiedValue === widget.iframeHtml
                ? "Copied"
                : "Copy iframe code"}
            </s-button>
          </div>
          <pre>{widget.iframeHtml}</pre>
        </div>
      </details>
    </section>
  );
}

function getPickedResourceTitle(resource) {
  return String(
    resource?.title || resource?.handle || resource?.id || "",
  ).trim();
}

function normalizePickedResources(resources) {
  if (!Array.isArray(resources)) {
    return [];
  }

  const seenIds = new Set();

  return resources
    .map((resource) => ({
      id: String(resource?.id || "").trim(),
      title: getPickedResourceTitle(resource),
    }))
    .filter((resource) => {
      if (!resource.id || seenIds.has(resource.id)) {
        return false;
      }

      seenIds.add(resource.id);
      return true;
    });
}

function RewardResourcePicker({
  label,
  name,
  resourceType,
  selectedResources,
  onChange,
}) {
  const resources = Array.isArray(selectedResources) ? selectedResources : [];

  const openPicker = async () => {
    const resourcePicker = window.shopify?.resourcePicker;

    if (!resourcePicker) {
      return;
    }

    const pickedResources = await resourcePicker({
      type: resourceType,
      multiple: true,
      selectionIds: resources.map((resource) => ({ id: resource.id })),
    });

    if (pickedResources) {
      onChange(normalizePickedResources(pickedResources));
    }
  };

  const removeResource = (id) => {
    onChange(resources.filter((resource) => resource.id !== id));
  };

  return (
    <div className="reward-resource-picker">
      <input type="hidden" name={name} value={JSON.stringify(resources)} />
      <div className="reward-resource-picker__heading">
        <span>{label}</span>
        <s-button type="button" onClick={openPicker}>
          Select
        </s-button>
      </div>
      {resources.length > 0 ? (
        <div className="reward-resource-chips">
          {resources.map((resource) => (
            <span className="reward-resource-chip" key={resource.id}>
              <span>{resource.title || resource.id.split("/").pop()}</span>
              <button
                type="button"
                aria-label={`Remove ${resource.title || resource.id}`}
                onClick={() => removeResource(resource.id)}
              >
                x
              </button>
            </span>
          ))}
        </div>
      ) : (
        <small>No {resourceType}s selected</small>
      )}
    </div>
  );
}

function RewardTierOptions({
  currencyCode,
  enabled = true,
  errors,
  initialRows,
  onEnabledChange,
  rewardType,
  showEnableToggle = false,
}) {
  const config = REWARD_FIELD_CONFIG[rewardType];
  const [rewardRows, setRewardRows] = useState(initialRows);
  const activeRewardCount = rewardRows.filter(
    (row) => row.points !== "" || row[config.amountKey] !== "",
  ).length;
  const rewardSummary = getRewardSummary(rewardRows, rewardType);

  const addRewardRow = () => {
    setRewardRows((rows) => [...rows, { ...config.emptyRow }]);
  };

  const updateRewardRow = (index, field, value) => {
    setRewardRows((rows) =>
      rows.map((row, rowIndex) =>
        rowIndex === index
          ? {
              ...row,
              [field]: value,
            }
          : row,
      ),
    );
  };

  const deleteRewardRow = (index) => {
    setRewardRows((rows) => {
      const nextRows = rows.filter((_, rowIndex) => rowIndex !== index);

      return nextRows.length > 0 ? nextRows : [{ ...config.emptyRow }];
    });
  };

  return (
    <div className="reward-options">
      <div className="reward-options-heading">
        <div>
          <h3>{config.heading}</h3>
          <p>
            {config.singleRow
              ? "Set the points-to-credit conversion rate customers can redeem."
              : "Add each reward tier customers can redeem with loyalty points."}
          </p>
        </div>
        {!showEnableToggle && !config.singleRow ? (
          <div className="reward-options-action">
            <s-button type="button" variant="primary" onClick={addRewardRow}>
              Add tier
            </s-button>
          </div>
        ) : null}
      </div>

      {showEnableToggle ? (
        <div className="redemption-toggle">
          <input
            id="storeCreditRedemptionEnabled"
            type="checkbox"
            name="storeCreditRedemptionEnabled"
            value="true"
            checked={enabled}
            onChange={(event) => onEnabledChange?.(event.target.checked)}
          />
          <div>
            <label htmlFor="storeCreditRedemptionEnabled">
              Enable store credit
            </label>
            <p>
              Customers can convert loyalty points into Shopify store credit.
            </p>
          </div>
          <span>{enabled ? "On" : "Off"}</span>
        </div>
      ) : null}

      {!enabled ? (
        <div className="reward-options-paused">
          Store credit rewards are disabled. Turn this on to edit the
          points-to-credit conversion rate.
        </div>
      ) : null}

      {enabled ? (
        <>
          <div className="summary-strip">
            <div>
              <span>Configured tiers</span>
              <strong>{formatNumber(activeRewardCount)}</strong>
            </div>
            <div>
              <span>Best value</span>
              <strong>
                {rewardSummary.bestValueReward
                  ? `${formatNumber(rewardSummary.bestValueReward.points)} points`
                  : "Pending"}
              </strong>
              <small>
                {rewardSummary.bestValueReward
                  ? `${rewardSummary.bestValueReward.amount} ${config.valueLabel}`
                  : "Complete a tier"}
              </small>
            </div>
            <div>
              <span>{config.amountSummaryLabel}</span>
              <strong>
                {formatCurrency(rewardSummary.totalRewardValue, currencyCode)}
              </strong>
            </div>
          </div>

          <div className="reward-tier-grid">
            {rewardRows.map((reward, index) => (
              <div className="reward-tier-card" key={index}>
                <s-stack gap="small">
                  <s-stack
                    direction="inline"
                    gap="base"
                    justifyContent="space-between"
                  >
                    <s-text type="strong">Reward {index + 1}</s-text>
                    {!config.singleRow ? (
                      <s-button
                        type="button"
                        tone="critical"
                        onClick={() => deleteRewardRow(index)}
                      >
                        Remove
                      </s-button>
                    ) : null}
                  </s-stack>
                  <s-number-field
                    label="Points required"
                    name={config.pointsName}
                    min="1"
                    step="1"
                    inputMode="numeric"
                    value={reward.points}
                    suffix="points"
                    onInput={(event) =>
                      updateRewardRow(index, "points", event.target.value)
                    }
                    error={
                      errors[`${config.pointsErrorPrefix}.${index}`] ||
                      undefined
                    }
                  ></s-number-field>
                  <s-number-field
                    label={config.amountLabel}
                    name={config.amountName}
                    min="0.01"
                    step="0.01"
                    inputMode="decimal"
                    value={reward[config.amountKey]}
                    onInput={(event) =>
                      updateRewardRow(
                        index,
                        config.amountKey,
                        event.target.value,
                      )
                    }
                    error={
                      errors[`${config.amountErrorPrefix}.${index}`] ||
                      undefined
                    }
                  ></s-number-field>
                  {config.allowRules !== false ? (
                    <div className="reward-rule-fields">
                      <s-number-field
                        label="Minimum cart spend"
                        name={`${rewardType}RewardMinSpend`}
                        min="0.01"
                        step="0.01"
                        inputMode="decimal"
                        value={reward.minSpend || ""}
                        details="Optional spend condition for this reward."
                        onInput={(event) =>
                          updateRewardRow(index, "minSpend", event.target.value)
                        }
                        error={
                          errors[`${rewardType}RewardMinSpend.${index}`] ||
                          undefined
                        }
                      ></s-number-field>
                      <RewardResourcePicker
                        label="Products"
                        name={`${rewardType}RewardProducts`}
                        resourceType="product"
                        selectedResources={reward.products}
                        onChange={(resources) =>
                          updateRewardRow(index, "products", resources)
                        }
                      />
                      <RewardResourcePicker
                        label="Collections"
                        name={`${rewardType}RewardCollections`}
                        resourceType="collection"
                        selectedResources={reward.collections}
                        onChange={(resources) =>
                          updateRewardRow(index, "collections", resources)
                        }
                      />
                    </div>
                  ) : null}
                </s-stack>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/* eslint-enable react/prop-types */

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const apiBaseUrl = await getSettingsApiBaseUrl(request);

  const {
    shop: planShop,
    settings: savedSettings,
    checkoutAvailable,
    effectiveIntegration,
    planSyncError,
  } = await ensurePlanAwareLoyaltySetup(session.shop, admin);
  const settings = await mergeSavedIframeAppearance(savedSettings, planShop.id);
  let currencyCode = "USD";

  try {
    const currencyResponse = await admin.graphql(`#graphql
      query LoyaltySettingsShopCurrency {
        shop {
          currencyCode
        }
      }
    `);
    const currencyData = await currencyResponse.json();
    currencyCode = currencyData.data?.shop?.currencyCode || currencyCode;
  } catch (error) {
    logError("settings:shop-currency", error, { shop: session.shop });
  }

  if (planSyncError) {
    logError("settings:shop-plan-sync", planSyncError, {
      shop: session.shop,
    });
  }

  return Response.json({
    settings,
    currencyCode,
    shopPlan: {
      name: planShop.shopifyPlanName || "Unknown",
      isShopifyPlus: Boolean(planShop.isShopifyPlus),
      isPartnerDevelopment: Boolean(planShop.isPartnerDevelopment),
      checkoutAvailable,
      effectiveIntegration,
    },
    headlessApi: {
      apiBaseUrl,
      shop: session.shop,
      hydrogenTokenConfigured: Boolean(
        process.env.HYDROGEN_LOYALTY_API_TOKEN ||
        process.env.LOYALTY_HYDROGEN_API_TOKEN,
      ),
    },
  });
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  const formData = await request.formData();

  const values = {};
  const errors = {};
  const {
    shop: planShop,
    settings: existingSettings,
    checkoutAvailable,
    planSyncError,
  } = await ensurePlanAwareLoyaltySetup(session.shop, admin);

  if (planSyncError) {
    logError("settings:shop-plan-sync", planSyncError, {
      shop: session.shop,
    });
  }

  for (const field of SETTING_FIELDS) {
    const value = parsePositiveInteger(formData, field.name);

    if (value === null) {
      errors[field.name] = "Enter a whole number greater than 0.";
    } else {
      values[field.name] = value;
    }
  }

  const discountRewardRows = getSubmittedRewardRows(formData, "discount");
  const giftCardRewardRows = getSubmittedRewardRows(formData, "gift_card");
  const storeCreditRewardRows = getSubmittedRewardRows(
    formData,
    "store_credit",
  );
  values.rewardTypePreference = normalizeRewardTypePreference(
    formData.get("rewardTypePreference"),
  );
  const requiresDiscountRewards = values.rewardTypePreference !== "gift_card";
  const requiresGiftCardRewards = values.rewardTypePreference !== "discount";
  const parsedDiscountRewards = parseRewardRows(
    discountRewardRows,
    "discount",
    {
      requireRewards: requiresDiscountRewards,
    },
  );
  const parsedGiftCardRewards = parseRewardRows(
    giftCardRewardRows,
    "gift_card",
    {
      requireRewards: requiresGiftCardRewards,
    },
  );
  const parsedStoreCreditRewards = parseRewardRows(
    storeCreditRewardRows,
    "store_credit",
    {
      requireRewards: formData
        .getAll("storeCreditRedemptionEnabled")
        .includes("true"),
    },
  );
  values.preferredIntegration = checkoutAvailable
    ? INTEGRATION_OPTIONS.CHECKOUT
    : INTEGRATION_OPTIONS.THEME;
  values.checkoutRedemptionEnabled = formData
    .getAll("checkoutRedemptionEnabled")
    .includes("true");
  values.storeCreditRedemptionEnabled = formData
    .getAll("storeCreditRedemptionEnabled")
    .includes("true");
  values.pointsExpiryEnabled = formData
    .getAll("pointsExpiryEnabled")
    .includes("true");
  values.pointsExpiryApplyToExisting = formData
    .getAll("pointsExpiryApplyToExisting")
    .includes("true");
  if (existingSettings?.pointsExpiryStartedAt) {
    values.pointsExpiryApplyToExisting =
      existingSettings.pointsExpiryApplyToExisting;
  }
  values.pointsExpiryUnit = ["days", "months"].includes(
    formData.get("pointsExpiryUnit"),
  )
    ? formData.get("pointsExpiryUnit")
    : DEFAULT_LOYALTY_SETTINGS.pointsExpiryUnit;
  const pointsExpiryValue = Number(formData.get("pointsExpiryValue"));
  const pointsExpiryMaximum = values.pointsExpiryUnit === "days" ? 3650 : 120;

  if (
    !Number.isInteger(pointsExpiryValue) ||
    pointsExpiryValue < 1 ||
    pointsExpiryValue > pointsExpiryMaximum
  ) {
    errors.pointsExpiryValue = `Enter a whole number from 1 to ${pointsExpiryMaximum}.`;
  } else {
    values.pointsExpiryValue = pointsExpiryValue;
  }

  if (values.pointsExpiryEnabled) {
    values.pointsExpiryStartedAt =
      existingSettings?.pointsExpiryStartedAt || new Date();
  }

  const vipSpendThreshold = parseNonNegativeAmount(
    formData,
    "vipSpendThreshold",
  );
  const inactiveCustomerDays = parseBoundedInteger(
    formData,
    "inactiveCustomerDays",
    1,
    3650,
  );
  const topSpenderPercent = parseBoundedInteger(
    formData,
    "topSpenderPercent",
    1,
    100,
  );

  if (vipSpendThreshold === null) {
    errors.vipSpendThreshold = "Enter a spend amount of 0 or more.";
  } else {
    values.vipSpendThreshold = vipSpendThreshold;
  }

  if (inactiveCustomerDays === null) {
    errors.inactiveCustomerDays = "Enter a whole number from 1 to 3650.";
  } else {
    values.inactiveCustomerDays = inactiveCustomerDays;
  }

  if (topSpenderPercent === null) {
    errors.topSpenderPercent = "Enter a whole number from 1 to 100.";
  } else {
    values.topSpenderPercent = topSpenderPercent;
  }

  const checkoutRewardLimit = parseCheckoutRewardLimit(formData);

  if (checkoutRewardLimit === null) {
    errors.checkoutRewardLimit = "Enter a whole number from 1 to 20.";
  } else {
    values.checkoutRewardLimit = checkoutRewardLimit;
  }

  IFRAME_TEXT_FIELDS.forEach((field) => {
    values[field.name] = normalizeTextSetting(formData, field.name);
  });

  IFRAME_COLOR_FIELDS.forEach((field) => {
    values[field.name] = normalizeColorSetting(formData, field.name);
  });
  values.iframeFontFamily = normalizeFontFamilySetting(formData);
  values.iframeCustomCss = normalizeCustomCssSetting(formData);
  const iframeFontSize = parseIframeFontSize(formData);

  if (iframeFontSize === null) {
    errors.iframeFontSize = "Enter a whole number from 12 to 20.";
  } else {
    values.iframeFontSize = iframeFontSize;
  }

  if (
    !parsedDiscountRewards.rewards ||
    !parsedGiftCardRewards.rewards ||
    !parsedStoreCreditRewards.rewards
  ) {
    Object.assign(
      errors,
      parsedDiscountRewards.errors,
      parsedGiftCardRewards.errors,
      parsedStoreCreditRewards.errors,
    );
  } else {
    const currentRedemptionRewards =
      formData.get("currentRedemptionRewards") ||
      DEFAULT_LOYALTY_SETTINGS.redemptionRewards;
    const existingDiscountRewards = getConfiguredRewardsByType(
      currentRedemptionRewards,
      "discount",
    );
    const existingGiftCardRewards = getConfiguredRewardsByType(
      currentRedemptionRewards,
      "gift_card",
    );
    const existingStoreCreditRewards = getConfiguredRewardsByType(
      currentRedemptionRewards,
      "store_credit",
    );
    const discountRewards = requiresDiscountRewards
      ? parsedDiscountRewards.rewards
      : existingDiscountRewards;
    const giftCardRewards = requiresGiftCardRewards
      ? parsedGiftCardRewards.rewards
      : existingGiftCardRewards;
    const storeCreditRewards = values.storeCreditRedemptionEnabled
      ? parsedStoreCreditRewards.rewards
      : existingStoreCreditRewards;

    values.redemptionRewards = serializeRewardSettings(
      [...discountRewards, ...giftCardRewards, ...storeCreditRewards],
      values.rewardTypePreference,
    );
  }

  if (Object.keys(errors).length > 0) {
    return Response.json(
      {
        errors,
        values: {
          ...Object.fromEntries(formData),
          checkoutRedemptionEnabled: values.checkoutRedemptionEnabled,
          storeCreditRedemptionEnabled: values.storeCreditRedemptionEnabled,
          pointsExpiryEnabled: values.pointsExpiryEnabled,
          pointsExpiryApplyToExisting: values.pointsExpiryApplyToExisting,
          pointsExpiryUnit: values.pointsExpiryUnit,
          pointsExpiryValue: formData.get("pointsExpiryValue"),
          preferredIntegration: values.preferredIntegration,
          rewardTypePreference: values.rewardTypePreference,
          discountRewardRows,
          giftCardRewardRows,
          storeCreditRewardRows,
        },
        shopPlan: {
          name: planShop.shopifyPlanName || "Unknown",
          isShopifyPlus: Boolean(planShop.isShopifyPlus),
          isPartnerDevelopment: Boolean(planShop.isPartnerDevelopment),
          checkoutAvailable,
          effectiveIntegration: getEffectiveIntegration(planShop, values),
        },
      },
      { status: 400 },
    );
  }

  let settings;

  try {
    settings = await prisma.loyaltySetting.update({
      where: {
        shopId: planShop.id,
      },
      data: filterLoyaltySettingData(values),
    });
    await updateSavedIframeAppearance(planShop.id, values);
    settings = await mergeSavedIframeAppearance(
      {
        ...settings,
        ...values,
      },
      planShop.id,
    );
  } catch (error) {
    logError("settings:save", error, { shop: session.shop });

    return Response.json(
      {
        errors: {
          form: "Could not save settings. Please try again.",
        },
        values: {
          ...values,
          discountRewardRows,
          giftCardRewardRows,
        },
        shopPlan: {
          name: planShop.shopifyPlanName || "Unknown",
          isShopifyPlus: Boolean(planShop.isShopifyPlus),
          isPartnerDevelopment: Boolean(planShop.isPartnerDevelopment),
          checkoutAvailable,
          effectiveIntegration: getEffectiveIntegration(planShop, values),
        },
      },
      { status: 500 },
    );
  }

  return Response.json({
    settings,
    saved: true,
    shopPlan: {
      name: planShop.shopifyPlanName || "Unknown",
      isShopifyPlus: Boolean(planShop.isShopifyPlus),
      isPartnerDevelopment: Boolean(planShop.isPartnerDevelopment),
      checkoutAvailable,
      effectiveIntegration: getEffectiveIntegration(planShop, settings),
    },
  });
};

export default function LoyaltySettingsPage() {
  const { currencyCode, settings, shopPlan, headlessApi } = useLoaderData();

  const actionData = useActionData();

  const navigation = useNavigation();

  const isSaving = navigation.state === "submitting";

  const currentSettings = actionData?.settings || settings;

  const values = actionData?.values || currentSettings;
  const currentShopPlan = actionData?.shopPlan || shopPlan;

  const errors = actionData?.errors || {};
  const effectiveIntegration =
    currentShopPlan?.effectiveIntegration || INTEGRATION_OPTIONS.THEME;
  const discountRewardRows =
    values.discountRewardRows ||
    getEditableRewardRows(currentSettings.redemptionRewards, "discount");
  const giftCardRewardRows =
    values.giftCardRewardRows ||
    getEditableRewardRows(currentSettings.redemptionRewards, "gift_card");
  const storeCreditRewardRows =
    values.storeCreditRewardRows ||
    getEditableRewardRows(currentSettings.redemptionRewards, "store_credit");
  const fieldsByName = Object.fromEntries(
    SETTING_FIELDS.map((field) => [field.name, field]),
  );
  const redemptionEnabled = getBooleanSettingValue(
    values,
    "checkoutRedemptionEnabled",
  );
  const storeCreditRedemptionEnabled = getBooleanSettingValue(
    values,
    "storeCreditRedemptionEnabled",
  );
  const pointsExpiryEnabled = getBooleanSettingValue(
    values,
    "pointsExpiryEnabled",
  );
  const pointsExpiryApplyToExisting = getBooleanSettingValue(
    values,
    "pointsExpiryApplyToExisting",
  );
  const pointsExpiryPolicyLocked = Boolean(
    currentSettings.pointsExpiryStartedAt,
  );
  const savedPointsExpiryUnit = getSettingValue(values, "pointsExpiryUnit");
  const [isStoreCreditRedemptionEnabled, setIsStoreCreditRedemptionEnabled] =
    useState(storeCreditRedemptionEnabled);
  const [isPointsExpiryEnabled, setIsPointsExpiryEnabled] =
    useState(pointsExpiryEnabled);
  const [pointsExpiryUnit, setPointsExpiryUnit] = useState(
    savedPointsExpiryUnit,
  );
  const [selectedRewardTypePreference, setSelectedRewardTypePreference] =
    useState(() => getRewardTypePreferenceValue(values));
  const [iframeAppearance, setIframeAppearance] = useState(() =>
    getIframeAppearanceValues(values),
  );
  useEffect(() => {
    setIframeAppearance(getIframeAppearanceValues(values));
  }, [
    values.iframeAccentColor,
    values.iframeBackgroundColor,
    values.iframeForegroundColor,
    values.iframeBorderColor,
    values.iframeFontFamily,
    values.iframeFontSize,
    values.iframeCustomCss,
  ]);
  useEffect(() => {
    setIsStoreCreditRedemptionEnabled(storeCreditRedemptionEnabled);
  }, [storeCreditRedemptionEnabled]);
  useEffect(() => {
    setIsPointsExpiryEnabled(pointsExpiryEnabled);
  }, [pointsExpiryEnabled]);
  useEffect(() => {
    setPointsExpiryUnit(savedPointsExpiryUnit);
  }, [savedPointsExpiryUnit]);
  const rewardTypePreference = selectedRewardTypePreference;
  const showDiscountRewards = rewardTypePreference !== "gift_card";
  const showGiftCardRewards = rewardTypePreference !== "discount";
  const visibleRewardOptions = getRewardOptionsForPreference(
    currentSettings.redemptionRewards,
    rewardTypePreference,
  ).filter(
    (reward) =>
      isStoreCreditRedemptionEnabled || reward.type !== "store_credit",
  );
  const checkoutRewardLimit = normalizeCheckoutRewardLimit(
    values.checkoutRewardLimit,
  );
  const headlessApiSections = buildHeadlessApiSections(
    headlessApi.apiBaseUrl,
    headlessApi.shop,
  );
  const iframeWidgetSections = buildIframeWidgetSections(
    headlessApi.apiBaseUrl,
    headlessApi.shop,
  );
  const integrationLabel =
    effectiveIntegration === INTEGRATION_OPTIONS.CHECKOUT
      ? "Checkout"
      : "Theme";

  return (
    <s-page heading="Loyalty settings" inlineSize="full">
      <style>{settingsStyles}</style>

      {actionData?.saved ? (
        <s-banner tone="success">Settings saved successfully.</s-banner>
      ) : null}
      {errors.form ? <s-banner tone="critical">{errors.form}</s-banner> : null}

      <div className="settings-full-width">
        <section className="settings-hero" aria-label="Settings summary">
          <div>
            <h2>Shape how points are earned, reversed, and redeemed</h2>
            <p>
              Tune the loyalty rules customers experience across signup, orders,
              refunds, and reward redemptions.
            </p>
          </div>

          <div className="hero-summary">
            <div>
              <span>Shop plan</span>
              <strong>{currentShopPlan?.name || "Unknown"}</strong>
            </div>
            <div>
              <span>Active channel</span>
              <strong>{integrationLabel}</strong>
            </div>
            <div>
              <span>Reward tiers</span>
              <strong>{formatNumber(visibleRewardOptions.length)}</strong>
            </div>
          </div>
        </section>

        <div className="settings-layout">
          <div className="settings-rules-column">
            <section
              className="settings-panel"
              aria-labelledby="point-rules-title"
            >
              <div className="settings-panel-header">
                <div>
                  <h2 id="point-rules-title">Point rules</h2>
                  <p>Control how customers earn and lose loyalty points.</p>
                </div>
              </div>

              <Form method="post">
                <input
                  type="hidden"
                  name="currentRedemptionRewards"
                  value={currentSettings.redemptionRewards}
                />
                {IFRAME_COLOR_FIELDS.map((field) => (
                  <input
                    key={field.name}
                    type="hidden"
                    name={field.name}
                    value={iframeAppearance[field.name]}
                  />
                ))}
                <input
                  type="hidden"
                  name="iframeFontFamily"
                  value={iframeAppearance.iframeFontFamily}
                />
                <input
                  type="hidden"
                  name="iframeFontSize"
                  value={iframeAppearance.iframeFontSize}
                />
                <s-stack gap="base">
                  {RULE_GROUPS.map((group) => (
                    <section className="rule-section" key={group.title}>
                      <div className="rule-section-header">
                        <div>
                          <h3>{group.title}</h3>
                          <p>{group.description}</p>
                        </div>
                      </div>

                      <div className="rule-field-grid">
                        {group.fields.map((fieldName) => {
                          const field = fieldsByName[fieldName];

                          return (
                            <div className="rule-field" key={field.name}>
                              <div className="field-label-with-info">
                                <span>{field.label}</span>
                                <InfoIcon tooltip={field.description} />
                              </div>
                              <s-number-field
                                label={field.label}
                                name={field.name}
                                min="1"
                                step="1"
                                inputMode="numeric"
                                value={getSettingValue(values, field.name)}
                                suffix={field.suffix}
                                details={field.help}
                                error={errors[field.name] || undefined}
                                required
                              ></s-number-field>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  ))}

                  <section className="rule-section">
                    <s-stack gap="base">
                      <div className="rule-section-header">
                        <div>
                          <h3>Points expiry</h3>
                          <p>
                            Expire each earning batch after a fixed lifetime.
                            Redemptions consume the oldest points first.
                          </p>
                        </div>
                      </div>

                      <div className="redemption-toggle">
                        <input
                          id="pointsExpiryEnabled"
                          type="checkbox"
                          name="pointsExpiryEnabled"
                          value="true"
                          checked={isPointsExpiryEnabled}
                          onChange={(event) =>
                            setIsPointsExpiryEnabled(event.target.checked)
                          }
                        />
                        <div>
                          <label htmlFor="pointsExpiryEnabled">
                            Enable points expiry
                          </label>
                          <p>
                            Points expire automatically after the configured
                            lifetime and are recorded in customer history.
                          </p>
                        </div>
                        <span>{isPointsExpiryEnabled ? "On" : "Off"}</span>
                      </div>

                      <div className="expiry-rule-grid">
                        <s-number-field
                          label="Points lifetime"
                          name="pointsExpiryValue"
                          min="1"
                          max={
                            pointsExpiryUnit === "days"
                              ? "3650"
                              : "120"
                          }
                          step="1"
                          inputMode="numeric"
                          value={getSettingValue(values, "pointsExpiryValue")}
                          details="The lifetime assigned to each new earning batch."
                          error={errors.pointsExpiryValue || undefined}
                          required
                        ></s-number-field>

                        <label className="expiry-unit-field">
                          <span>Lifetime unit</span>
                          <select
                            name="pointsExpiryUnit"
                            value={pointsExpiryUnit}
                            onChange={(event) =>
                              setPointsExpiryUnit(event.target.value)
                            }
                          >
                            <option value="months">Months</option>
                            <option value="days">Days</option>
                          </select>
                          <small>
                            Calendar months preserve the earning day where
                            possible.
                          </small>
                        </label>
                      </div>

                      <label className="expiry-existing-option">
                        {pointsExpiryPolicyLocked ? (
                          <input
                            type="hidden"
                            name="pointsExpiryApplyToExisting"
                            value={
                              pointsExpiryApplyToExisting ? "true" : "false"
                            }
                          />
                        ) : null}
                        <input
                          type="checkbox"
                          name={
                            pointsExpiryPolicyLocked
                              ? undefined
                              : "pointsExpiryApplyToExisting"
                          }
                          value="true"
                          defaultChecked={pointsExpiryApplyToExisting}
                          disabled={
                            !isPointsExpiryEnabled || pointsExpiryPolicyLocked
                          }
                        />
                        <span>
                          <strong>Apply the rule to existing points</strong>
                          <small>
                            {pointsExpiryPolicyLocked
                              ? "This migration policy was fixed when expiry was first enabled."
                              : "Existing earning dates will be used and old points might expire on the next automated run. Leave this off to start their lifetime when expiry is enabled."}
                          </small>
                        </span>
                      </label>

                    </s-stack>
                  </section>

                  <section className="rule-section">
                    <s-stack gap="base">
                      <div className="rule-section-header">
                        <div>
                          <h3>Customer segmentation rules</h3>
                          <p>
                            Configure how VIP customers, inactive customers, and
                            top spenders are identified on the customer list.
                          </p>
                        </div>
                      </div>

                      <div className="segmentation-rule-grid">
                        {SEGMENTATION_FIELDS.map((field) => (
                          <s-number-field
                            key={field.name}
                            label={field.label}
                            name={field.name}
                            min={field.min}
                            max={field.max}
                            step={field.step}
                            inputMode={field.inputMode}
                            value={getSettingValue(values, field.name)}
                            suffix={
                              field.name === "vipSpendThreshold"
                                ? currencyCode
                                : field.suffix
                            }
                            details={field.details}
                            error={errors[field.name] || undefined}
                            required
                          ></s-number-field>
                        ))}
                      </div>
                    </s-stack>
                  </section>

                  <section className="rule-section">
                    <s-stack gap="base">
                      <div className="rule-section-header">
                        <div>
                          <h3>Redemption rewards</h3>
                          <p>
                            Configure reward redemption availability, discount
                            tiers, gift card tiers, and store credit.
                          </p>
                        </div>
                      </div>

                      <div className="redemption-toggle">
                        <input
                          id="checkoutRedemptionEnabled"
                          type="checkbox"
                          name="checkoutRedemptionEnabled"
                          value="true"
                          defaultChecked={redemptionEnabled}
                        />
                        <div>
                          <label htmlFor="checkoutRedemptionEnabled">
                            Allow rewards redemption
                          </label>
                          <p>
                            Customers can redeem rewards wherever the app is
                            available for their store plan.
                          </p>
                        </div>
                        <span>{redemptionEnabled ? "On" : "Off"}</span>
                      </div>

                      <div className="checkout-limit-field">
                        <s-number-field
                          label="Reward options shown"
                          name="checkoutRewardLimit"
                          min="1"
                          max="20"
                          step="1"
                          inputMode="numeric"
                          value={String(checkoutRewardLimit)}
                          suffix="options"
                          details="Limit how many configured reward options appear in checkout and the theme widget."
                          error={errors.checkoutRewardLimit || undefined}
                          required
                        ></s-number-field>
                      </div>

                      <div className="reward-type-options">
                        {REWARD_TYPE_CHOICES.map((choice) => (
                          <label
                            className="reward-type-option"
                            key={choice.value}
                            htmlFor={`rewardTypePreference-${choice.value}`}
                          >
                            <input
                              id={`rewardTypePreference-${choice.value}`}
                              type="radio"
                              name="rewardTypePreference"
                              value={choice.value}
                              aria-label={choice.label}
                              checked={rewardTypePreference === choice.value}
                              onChange={(event) =>
                                setSelectedRewardTypePreference(
                                  normalizeRewardTypePreference(
                                    event.target.value,
                                  ),
                                )
                              }
                            />
                            <span>
                              <strong>{choice.label}</strong>
                              <small>{choice.description}</small>
                            </span>
                          </label>
                        ))}
                      </div>

                      {showDiscountRewards ? (
                        <RewardTierOptions
                          key={`discount-${JSON.stringify(discountRewardRows)}`}
                          currencyCode={currencyCode}
                          errors={errors}
                          initialRows={discountRewardRows}
                          rewardType="discount"
                        />
                      ) : null}

                      {showGiftCardRewards ? (
                        <RewardTierOptions
                          key={`gift_card-${JSON.stringify(giftCardRewardRows)}`}
                          currencyCode={currencyCode}
                          errors={errors}
                          initialRows={giftCardRewardRows}
                          rewardType="gift_card"
                        />
                      ) : null}

                      <RewardTierOptions
                        key={`store_credit-${JSON.stringify(storeCreditRewardRows)}`}
                        currencyCode={currencyCode}
                        enabled={isStoreCreditRedemptionEnabled}
                        errors={errors}
                        initialRows={storeCreditRewardRows}
                        onEnabledChange={setIsStoreCreditRedemptionEnabled}
                        rewardType="store_credit"
                        showEnableToggle
                      />

                      {errors.redemptionRewards ? (
                        <s-text tone="critical">
                          {errors.redemptionRewards}
                        </s-text>
                      ) : (
                        <s-text type="small">
                          Complete points and value before saving. Optional
                          rules can limit a tier by spend, product, or
                          collection.
                        </s-text>
                      )}
                    </s-stack>
                  </section>

                  <section className="rule-section">
                    <s-stack gap="base">
                      <div className="rule-section-header">
                        <div>
                          <h3>Iframe appearance</h3>
                          <p>
                            Customize the copy and colors used by iframe embeds
                            for theme, Hydrogen, and customer account pages.
                          </p>
                        </div>
                      </div>

                      <div className="iframe-text-grid">
                        {IFRAME_TEXT_FIELDS.map((field) => (
                          <s-text-field
                            key={field.name}
                            label={field.label}
                            name={field.name}
                            value={getSettingValue(values, field.name)}
                            details={field.details}
                          ></s-text-field>
                        ))}
                      </div>

                      <div className="iframe-color-grid">
                        {IFRAME_COLOR_FIELDS.map((field) => {
                          const value = iframeAppearance[field.name];

                          return (
                            <label
                              className="iframe-color-field"
                              key={field.name}
                            >
                              <span>{field.label}</span>
                              <div>
                                <input
                                  type="color"
                                  value={value}
                                  aria-label={field.label}
                                  onChange={(event) =>
                                    setIframeAppearance((current) => ({
                                      ...current,
                                      [field.name]: event.target.value,
                                    }))
                                  }
                                />
                                <code>{value}</code>
                              </div>
                            </label>
                          );
                        })}
                      </div>

                      <div className="iframe-font-grid">
                        <s-select
                          label="Font family"
                          details="Choose from web-safe options and commonly used Google fonts."
                          value={iframeAppearance.iframeFontFamily}
                          onChange={(event) =>
                            setIframeAppearance((current) => ({
                              ...current,
                              iframeFontFamily: event.currentTarget.value,
                            }))
                          }
                          required
                        >
                          {IFRAME_FONT_FAMILY_OPTIONS.map((option) => (
                            <s-option key={option.value} value={option.value}>
                              {option.label}
                            </s-option>
                          ))}
                        </s-select>

                        <s-number-field
                          label="Font size"
                          min="12"
                          max="20"
                          step="1"
                          inputMode="numeric"
                          value={String(iframeAppearance.iframeFontSize)}
                          suffix="px"
                          details="Base text size for iframe widgets."
                          error={errors.iframeFontSize || undefined}
                          onInput={(event) =>
                            setIframeAppearance((current) => ({
                              ...current,
                              iframeFontSize: event.target.value,
                            }))
                          }
                          required
                        ></s-number-field>
                      </div>

                      <label className="iframe-custom-css-field">
                        <span>Custom CSS</span>
                        <textarea
                          name="iframeCustomCss"
                          value={iframeAppearance.iframeCustomCss}
                          rows={8}
                          spellCheck="false"
                          placeholder={
                            ".gwl-floating-iframe__launcher {\n  background: #111827 !important;\n}\n\n.loyalty-points-widget--floating .loyalty-points-widget__launcher {\n  background: #111827 !important;\n}"
                          }
                          onChange={(event) =>
                            setIframeAppearance((current) => ({
                              ...current,
                              iframeCustomCss: event.target.value,
                            }))
                          }
                        />
                        <small>
                          Overrides iframe widgets and the theme app extension.
                          Keep selectors specific to loyalty classes. Use
                          6-digit colors like #000000.
                        </small>
                      </label>
                    </s-stack>
                  </section>

                  <div className="settings-actions">
                    <s-button
                      type="submit"
                      variant="primary"
                      loading={isSaving || undefined}
                    >
                      Save settings
                    </s-button>
                  </div>
                </s-stack>
              </Form>
            </section>
          </div>

          <div className="settings-embed-column">
            <section
              className="settings-panel iframe-widgets-panel"
              aria-labelledby="iframe-widgets-title"
            >
              <div className="settings-panel-header">
                <div>
                  <h2 id="iframe-widgets-title">Iframe widgets</h2>
                  <p>
                    Ready-made loyalty UI that merchants can embed in theme
                    blocks, custom Liquid sections, or headless storefront
                    pages.
                  </p>
                </div>
              </div>

              <div className="api-endpoint-list">
                {iframeWidgetSections.map((widget, index) => (
                  <IframeWidgetCard
                    key={widget.title}
                    widget={widget}
                    initiallyOpen={index === 0}
                  />
                ))}
              </div>
            </section>

            <section
              className="settings-panel headless-api-panel"
              aria-labelledby="headless-api-title"
            >
              <div className="settings-panel-header">
                <div>
                  <h2 id="headless-api-title">Headless API</h2>
                  <p>
                    Raw JSON endpoints for custom storefronts, Hydrogen builds,
                    and theme integrations.
                  </p>
                </div>
              </div>

              {!headlessApi.hydrogenTokenConfigured ? (
                <s-banner tone="warning">
                  Hydrogen protected endpoints require
                  HYDROGEN_LOYALTY_API_TOKEN in the app environment.
                </s-banner>
              ) : null}

              <div className="api-endpoint-list">
                {headlessApiSections.map((endpoint, index) => (
                  <HeadlessApiEndpoint
                    key={endpoint.title}
                    endpoint={endpoint}
                    initiallyOpen={index === 0}
                  />
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </s-page>
  );
}

const settingsStyles = `
  .settings-full-width {
    inline-size: min(calc(100vw - 304px), 1560px);
    margin-inline: calc((100% - min(calc(100vw - 304px), 1560px)) / 2);
  }

  .settings-hero,
  .settings-hero *,
  .settings-full-width,
  .settings-full-width *,
  .settings-layout,
  .settings-layout * {
    box-sizing: border-box;
  }

  .settings-hero,
  .settings-panel {
    background: #ffffff;
    border: 1px solid #dcdfe4;
    border-radius: 8px;
    box-shadow: 0 1px 0 rgba(0, 0, 0, 0.04);
    width: 100%;
  }

  .settings-hero {
    align-items: start;
    display: grid;
    gap: 20px;
    grid-template-columns: minmax(0, 1fr) minmax(280px, 0.72fr);
    margin-block-end: 16px;
    overflow: hidden;
    padding: 24px;
    position: relative;
  }

  .settings-hero::before {
    background: #008060;
    content: "";
    inset: 0 auto 0 0;
    position: absolute;
    width: 4px;
  }

  .settings-hero h2 {
    color: #202223;
    font-size: 22px;
    font-weight: 650;
    line-height: 30px;
    margin: 0;
    max-width: 640px;
  }

  .settings-hero p {
    color: #616a75;
    font-size: 13px;
    line-height: 20px;
    margin: 8px 0 0;
    max-width: 640px;
  }

  .status-pill {
    align-items: center;
    background: #d1f7e6;
    border-radius: 999px;
    color: #0c5132;
    display: inline-flex;
    font-size: 12px;
    font-weight: 650;
    line-height: 16px;
    margin-block-end: 12px;
    padding: 3px 8px;
    width: fit-content;
  }

  .hero-summary {
    display: grid;
    gap: 10px;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .hero-summary > div,
  .reward-tier-card,
  .api-endpoint,
  .iframe-widget-card,
  .iframe-help-box,
  .redemption-toggle,
  .rule-section {
    background: #f7f8fa;
    border: 1px solid #e3e5e8;
    border-radius: 8px;
  }

  .hero-summary > div {
    min-width: 0;
    padding: 12px;
  }

  .hero-summary span,
  .summary-strip span {
    color: #616a75;
    display: block;
    font-size: 12px;
    font-weight: 650;
    line-height: 16px;
  }

  .hero-summary strong {
    color: #202223;
    display: block;
    font-size: 18px;
    line-height: 24px;
    margin-block-start: 4px;
    overflow-wrap: anywhere;
  }

  .settings-layout {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(360px, 0.85fr);
    align-items: start;
    gap: 16px;
    padding-block-end: 24px;
    width: 100%;
  }

  .settings-rules-column,
  .settings-embed-column {
    display: grid;
    gap: 16px;
    min-width: 0;
  }

  .settings-panel {
    padding: 16px;
  }

  .settings-panel-header {
    align-items: start;
    display: flex;
    gap: 16px;
    justify-content: space-between;
    margin-block-end: 16px;
  }

  .settings-panel-header h2 {
    color: #202223;
    font-size: 16px;
    font-weight: 650;
    line-height: 24px;
    margin: 0;
  }

  .settings-panel-header p {
    color: #303030;
    font-size: 13px;
    line-height: 20px;
    margin: 4px 0 0;
  }

  .rule-section {
    padding: 16px;
  }

  .rule-section-header,
  .reward-options-heading {
    align-items: start;
    display: flex;
    gap: 12px;
  }

  .rule-section-header {
    justify-content: flex-start;
    margin-block-end: 14px;
  }

  .reward-options-heading {
    justify-content: space-between;
  }

  .rule-section h3,
  .reward-options h3,
  .api-endpoint h3,
  .iframe-widget-card h3 {
    color: #202223;
    font-size: 14px;
    font-weight: 650;
    line-height: 20px;
    margin: 0;
  }

  .rule-section p,
  .reward-options p,
  .redemption-toggle p,
  .api-endpoint p,
  .iframe-widget-card p,
  .iframe-help-box p {
    color: #616a75;
    font-size: 13px;
    line-height: 20px;
    margin: 4px 0 0;
  }

  .theme-embed-action-row {
    align-items: center;
    display: grid;
    gap: 10px;
    grid-template-columns: auto minmax(0, 1fr);
    margin-block-start: 12px;
  }

  .theme-embed-action-row code {
    background: #ffffff;
    border: 1px solid #e3e5e8;
    border-radius: 6px;
    color: #202223;
    display: block;
    font-size: 12px;
    line-height: 18px;
    min-width: 0;
    overflow: auto;
    padding: 8px;
    white-space: nowrap;
  }

  .rule-field-grid {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }

  .rule-field {
    min-width: 0;
  }

  .redemption-toggle {
    align-items: start;
    display: grid;
    gap: 12px;
    grid-template-columns: auto minmax(0, 1fr) auto;
    padding: 14px;
  }

  .checkout-limit-field {
    max-width: 360px;
    min-width: 0;
  }

  .expiry-rule-grid {
    display: grid;
    gap: 12px;
    grid-template-columns: minmax(0, 1fr) minmax(180px, 0.55fr);
  }

  .segmentation-rule-grid {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .expiry-unit-field {
    display: grid;
    gap: 6px;
  }

  .expiry-unit-field > span,
  .expiry-existing-option strong {
    color: #202223;
    font-size: 13px;
    font-weight: 650;
    line-height: 20px;
  }

  .expiry-unit-field select {
    appearance: auto;
    background: #ffffff;
    border: 1px solid #8c9196;
    border-radius: 8px;
    color: #202223;
    font: inherit;
    min-height: 38px;
    padding: 8px 10px;
    width: 100%;
  }

  .expiry-unit-field small,
  .expiry-existing-option small {
    color: #616a75;
    font-size: 12px;
    line-height: 16px;
  }

  .expiry-existing-option {
    align-items: start;
    background: #fff8e5;
    border: 1px solid #e6c968;
    border-radius: 8px;
    display: grid;
    gap: 10px;
    grid-template-columns: auto minmax(0, 1fr);
    padding: 12px;
  }

  .expiry-existing-option input {
    accent-color: #008060;
    height: 18px;
    margin-block-start: 2px;
    width: 18px;
  }

  .expiry-existing-option strong,
  .expiry-existing-option small {
    display: block;
  }

  .redemption-toggle input {
    accent-color: #008060;
    height: 18px;
    margin-block-start: 2px;
    width: 18px;
  }

  .redemption-toggle label {
    color: #202223;
    display: block;
    font-weight: 650;
    line-height: 20px;
  }

  .redemption-toggle > span {
    background: #ffffff;
    border: 1px solid #dcdfe4;
    border-radius: 999px;
    color: #303030;
    font-size: 12px;
    font-weight: 650;
    line-height: 16px;
    padding: 3px 8px;
    white-space: nowrap;
  }

  .reward-options {
    display: grid;
    gap: 12px;
  }

  .reward-type-options {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .reward-type-option {
    align-items: start;
    background: #f7f8fa;
    border: 1px solid #e3e5e8;
    border-radius: 8px;
    cursor: pointer;
    display: grid;
    gap: 10px;
    grid-template-columns: auto minmax(0, 1fr);
    min-width: 0;
    padding: 14px;
  }

  .reward-type-option:has(input:checked) {
    background: #f6faf8;
    border-color: #008060;
  }

  .reward-type-option input {
    accent-color: #008060;
    height: 18px;
    margin-block-start: 1px;
    width: 18px;
  }

  .reward-type-option strong,
  .reward-type-option small {
    display: block;
  }

  .reward-type-option strong {
    color: #202223;
    font-size: 13px;
    line-height: 20px;
    overflow-wrap: anywhere;
  }

  .reward-type-option small {
    color: #616a75;
    font-size: 12px;
    line-height: 16px;
    margin-block-start: 2px;
  }

  .reward-options-action {
    flex: 0 0 auto;
  }

  .reward-options-paused {
    background: #f6f6f7;
    border: 1px solid #e3e5e8;
    border-radius: 8px;
    color: #616a75;
    font-size: 13px;
    line-height: 20px;
    padding: 12px;
  }

  .summary-strip,
  .reward-tier-grid {
    display: grid;
    gap: 12px;
  }

  .summary-strip {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .summary-strip > div {
    background: #f6faf8;
    border: 1px solid #d2eadf;
    border-radius: 8px;
    min-width: 0;
    padding: 12px;
  }

  .summary-strip strong {
    color: #0c5132;
    display: block;
    font-size: 16px;
    line-height: 22px;
    margin-block-start: 4px;
    overflow-wrap: anywhere;
  }

  .summary-strip small {
    color: #616a75;
    display: block;
    font-size: 12px;
    line-height: 16px;
    margin-block-start: 2px;
  }

  .reward-tier-grid {
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  }

  .reward-tier-card {
    padding: 14px;
  }

  .reward-rule-fields {
    border-block-start: 1px solid #e3e5e8;
    display: grid;
    gap: 12px;
    padding-block-start: 12px;
  }

  .reward-resource-picker {
    background: #ffffff;
    border: 1px solid #e3e5e8;
    border-radius: 8px;
    display: grid;
    gap: 8px;
    min-width: 0;
    padding: 10px;
  }

  .reward-resource-picker__heading {
    align-items: center;
    display: flex;
    gap: 10px;
    justify-content: space-between;
  }

  .reward-resource-picker__heading span {
    color: #202223;
    font-size: 13px;
    font-weight: 650;
    line-height: 20px;
  }

  .reward-resource-picker small {
    color: #616a75;
    font-size: 12px;
    line-height: 16px;
  }

  .reward-resource-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
  }

  .reward-resource-chip {
    align-items: center;
    background: #f6faf8;
    border: 1px solid #d2eadf;
    border-radius: 999px;
    color: #0c5132;
    display: inline-flex;
    font-size: 12px;
    font-weight: 650;
    gap: 6px;
    line-height: 16px;
    max-width: 100%;
    min-width: 0;
    padding: 4px 6px 4px 10px;
  }

  .reward-resource-chip span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .reward-resource-chip button {
    align-items: center;
    appearance: none;
    background: #ffffff;
    border: 1px solid #b7d9ca;
    border-radius: 999px;
    color: #0c5132;
    cursor: pointer;
    display: inline-flex;
    font-size: 12px;
    font-weight: 700;
    height: 20px;
    justify-content: center;
    line-height: 1;
    padding: 0;
    width: 20px;
  }

  .settings-actions {
    align-items: center;
    display: flex;
    justify-content: flex-end;
    padding-block-start: 4px;
  }

  .headless-api-panel {
    display: grid;
    gap: 14px;
  }

  .iframe-widgets-panel {
    display: grid;
    gap: 14px;
  }

  .iframe-text-grid {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .iframe-color-grid {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .iframe-font-grid {
    display: grid;
    gap: 12px;
    grid-template-columns: minmax(0, 1fr) minmax(150px, 0.45fr);
  }

  .iframe-color-field {
    background: #ffffff;
    border: 1px solid #e3e5e8;
    border-radius: 8px;
    display: grid;
    gap: 10px;
    padding: 12px;
  }

  .iframe-color-field span {
    color: #202223;
    font-size: 13px;
    font-weight: 650;
    line-height: 20px;
  }

  .iframe-color-field div {
    align-items: center;
    display: flex;
    gap: 10px;
  }

  .iframe-color-field input {
    background: transparent;
    border: 0;
    height: 34px;
    padding: 0;
    width: 48px;
  }

  .iframe-color-field code {
    color: #616a75;
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .iframe-select-field {
    background: #ffffff;
    border: 1px solid #e3e5e8;
    border-radius: 8px;
    display: grid;
    gap: 8px;
    padding: 12px;
  }

  .iframe-select-field span {
    color: #202223;
    font-size: 13px;
    font-weight: 650;
    line-height: 20px;
  }

  .iframe-select-field select,
  .iframe-select-field input {
    background: #ffffff;
    border: 1px solid #babfc3;
    border-radius: 8px;
    color: #202223;
    font-size: 14px;
    min-height: 34px;
    padding: 6px 10px;
    width: 100%;
  }

  .iframe-select-field small {
    color: #616a75;
    font-size: 12px;
    line-height: 16px;
  }

  .iframe-custom-css-field {
    background: #ffffff;
    border: 1px solid #e3e5e8;
    border-radius: 8px;
    display: grid;
    gap: 8px;
    padding: 12px;
  }

  .iframe-custom-css-field span {
    color: #202223;
    font-size: 13px;
    font-weight: 650;
    line-height: 20px;
  }

  .iframe-custom-css-field textarea {
    background: #ffffff;
    border: 1px solid #babfc3;
    border-radius: 8px;
    color: #202223;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 13px;
    line-height: 18px;
    min-height: 150px;
    padding: 10px 12px;
    resize: vertical;
    width: 100%;
  }

  .iframe-custom-css-field small {
    color: #616a75;
    font-size: 12px;
    line-height: 16px;
  }

  .iframe-help-box {
    padding: 14px;
  }

  .iframe-help-box strong {
    color: #202223;
    display: block;
    font-size: 13px;
    line-height: 20px;
  }

  .api-endpoint-list {
    display: grid;
    gap: 12px;
  }

  .api-endpoint {
    display: grid;
    gap: 12px;
    padding: 14px;
  }

  .iframe-widget-card {
    display: grid;
    gap: 12px;
    padding: 14px;
  }

  .api-endpoint-heading {
    align-items: start;
    display: flex;
    gap: 12px;
    justify-content: space-between;
  }

  .iframe-widget-heading {
    align-items: start;
    display: flex;
    gap: 12px;
    justify-content: space-between;
  }

  .method-pill {
    background: #eaf4ff;
    border: 1px solid #b5d8ff;
    border-radius: 999px;
    color: #084b83;
    flex: 0 0 auto;
    font-size: 12px;
    font-weight: 650;
    line-height: 16px;
    padding: 3px 8px;
    white-space: nowrap;
  }

  .api-url-row,
  .api-example-heading {
    align-items: center;
    display: flex;
    gap: 8px;
    justify-content: space-between;
  }

  .api-url-row {
    background: #ffffff;
    border: 1px solid #dcdfe4;
    border-radius: 8px;
    padding: 8px;
  }

  .api-url-row code,
  .api-example-block code,
  .api-example-block pre {
    color: #303030;
    font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
    font-size: 12px;
    line-height: 18px;
    margin: 0;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .api-details {
    display: grid;
    gap: 10px;
  }

  .api-details summary {
    color: #005bd3;
    cursor: pointer;
    font-size: 13px;
    font-weight: 650;
    line-height: 20px;
  }

  .api-parameter-table {
    border: 1px solid #e3e5e8;
    border-radius: 8px;
    display: grid;
    margin-block-start: 10px;
    overflow: hidden;
  }

  .api-table-row {
    display: grid;
    gap: 10px;
    grid-template-columns: minmax(100px, 0.9fr) minmax(80px, 0.6fr) minmax(70px, 0.5fr) minmax(180px, 1.7fr);
    padding: 10px 12px;
  }

  .api-table-row + .api-table-row {
    border-block-start: 1px solid #e3e5e8;
  }

  .api-table-row span {
    color: #303030;
    font-size: 12px;
    line-height: 18px;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .api-table-head {
    background: #ffffff;
  }

  .api-table-head span {
    color: #202223;
    font-weight: 650;
  }

  .api-table-row code {
    background: #f1f2f4;
    border-radius: 4px;
    color: #202223;
    font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
    padding: 1px 4px;
  }

  .api-example-block {
    background: #ffffff;
    border: 1px solid #e3e5e8;
    border-radius: 8px;
    display: grid;
    gap: 8px;
    margin-block-start: 10px;
    padding: 10px;
  }

  .api-example-heading span {
    color: #616a75;
    font-size: 12px;
    font-weight: 650;
    line-height: 16px;
  }

  @media (max-width: 1120px) {
    .settings-full-width {
      inline-size: 100%;
      margin-inline: 0;
    }

    .settings-hero,
    .settings-layout {
      grid-template-columns: 1fr;
    }

    .segmentation-rule-grid {
      grid-template-columns: 1fr;
    }

    .hero-summary,
    .iframe-text-grid,
    .iframe-font-grid,
    .reward-type-options,
    .summary-strip {
      grid-template-columns: 1fr;
    }

    .iframe-color-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .settings-rules-column,
    .settings-embed-column {
      grid-column: auto;
      grid-row: auto;
    }
  }

  @media (max-width: 640px) {
    .settings-hero,
    .settings-panel,
    .rule-section {
      padding: 14px;
    }

    .reward-options-heading,
    .settings-panel-header,
    .api-endpoint-heading,
    .iframe-widget-heading,
    .api-url-row,
    .api-example-heading {
      display: grid;
    }

    .reward-options-action {
      width: fit-content;
    }

    .redemption-toggle {
      grid-template-columns: auto minmax(0, 1fr);
    }

    .redemption-toggle > span {
      grid-column: 2;
      width: fit-content;
    }

    .api-table-row {
      grid-template-columns: 1fr;
    }

    .iframe-color-grid {
      grid-template-columns: 1fr;
    }
  }

  /* Info Icon and Tooltip Styles */
  .info-icon-wrapper {
    display: inline-flex;
    align-items: center;
    position: relative;
    cursor: help;
    margin-left: 6px;
  }

  .info-icon {
    color: #616a75;
    flex-shrink: 0;
    transition: color 0.2s ease;
  }

  .info-icon-wrapper:hover .info-icon,
  .info-icon-wrapper:focus .info-icon {
    color: #008060;
  }

  .tooltip-popup {
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    background: #202223;
    color: #ffffff;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 12px;
    line-height: 16px;
    white-space: normal;
    max-width: 250px;
    z-index: 1000;
    margin-bottom: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    word-wrap: break-word;
    pointer-events: none;
  }

  .tooltip-popup::after {
    content: '';
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    border: 4px solid transparent;
    border-top-color: #202223;
  }

  .field-label-with-info {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 8px;
    font-weight: 650;
    color: #202223;
    font-size: 13px;
    line-height: 20px;
  }

`;
