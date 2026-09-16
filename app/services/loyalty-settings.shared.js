export const DEFAULT_REWARD_OPTIONS = [
  {
    type: "discount",
    points: 100,
    discount: 2,
  },
  {
    type: "discount",
    points: 250,
    discount: 5,
  },
  {
    type: "discount",
    points: 500,
    discount: 10,
  },
];

export const DEFAULT_GIFT_CARD_REWARD_OPTIONS = [
  {
    type: "gift_card",
    points: 1500,
    amount: 15,
    description: "Redeem 1,500 points to get for free",
  },
];

export const SPECIAL_REWARD_OPTIONS = [
  {
    type: "store_credit",
    points: 100,
    amount: 1,
    title: "Store Credit Reward",
    description: "Redeem points for store credit",
  },
];

export const DEFAULT_LOYALTY_SETTINGS = {
  signupBonusPoints: 100,
  orderSpendAmount: 100,
  orderSpendPoints: 10,
  refundSpendAmount: 100,
  refundSpendPoints: 10,
  checkoutRedemptionEnabled: true,
  storeCreditRedemptionEnabled: true,
  checkoutRewardLimit: 10,
  preferredIntegration: "theme",
  redemptionRewards: JSON.stringify(DEFAULT_REWARD_OPTIONS),
  pointsExpiryEnabled: false,
  pointsExpiryValue: 12,
  pointsExpiryUnit: "months",
  pointsExpiryApplyToExisting: false,
  vipSpendThreshold: 50000,
  inactiveCustomerDays: 90,
  topSpenderPercent: 10,
  referralProgramEnabled: true,
  referralAdvocatePoints: 200,
  referralFriendPoints: 100,
  // Checkout UI Text Settings
  checkoutLoginMessage: "Sign in to use loyalty points.",
  checkoutDescription: "You have {coupon_amount} available {reward_label}",
  checkoutRewardPrompt: "Choose a {reward_singular}",
  checkoutRedeemButtonText: "Redeem",
  checkoutRedeemingText: "Redeeming...",
  checkoutPointsLabel: "Available points",
  checkoutSelectRewardMsg: "Please select a reward.",
  checkoutNotEnoughPtsMsg: "Not enough points for this reward.",
  checkoutDisabledMsg: "Rewards redemption is disabled in checkout.",
  checkoutRedemptionTitle: "Redeem your Points",
  checkoutGiftCardMsg: "Gift card created: {rewardCode}",
  checkoutDiscountMsg:
    "Discount code created: {rewardCode}. Points will be deducted after payment.",
  checkoutErrorMsg: "Could not redeem points",
  checkoutLoadingMsg: "Available points loading...",
  checkoutAvailableRewardsMsg: "{reward_count} available {reward_label}",
  // Customer Account UI Text Settings
  accountLoginMessage: "Sign in to view loyalty points.",
  accountBalanceTitle: "Loyalty balance",
  accountAvailableLabel: "Available points",
  accountCurrentBalance: "Current balance",
  accountLoadingText: "Loading...",
  accountRedeemingText: "Converting...",
  accountRedeemButtonText: "Convert to store credit",
  accountDisabledMsg: "Store credit conversion is currently disabled.",
  accountNotEnoughPtsMsg:
    "Earn {remaining_points} more points to convert this amount.",
  accountGiftCardMsg: "Store credit added: {amount}",
  accountErrorMsg: "Could not convert points to store credit",
  accountConfigErrorMsg: "Loyalty API URL is not configured.",
  // Iframe Widget UI Settings
  iframeEyebrow: "Rewards",
  iframeHeading: "Your loyalty points",
  iframeLoggedOutMessage: "Sign in to view and use your loyalty points.",
  iframeLoginLabel: "Sign in",
  iframePointsTemplate: "You have {points} points.",
  iframeRewardsHeading: "Available rewards",
  iframeNoRewardsMessage: "Keep earning points to unlock rewards.",
  iframeRedeemButtonText: "Redeem",
  iframeAccentColor: "#008060",
  iframeBackgroundColor: "#ffffff",
  iframeForegroundColor: "#202223",
  iframeBorderColor: "#e3e5e8",
  iframeFontFamily: "system",
  iframeFontSize: 14,
  iframeCustomCss: "",
};

export const REWARD_TYPE_PREFERENCES = ["gift_card", "discount", "both"];

function normalizeIdList(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(",");

  return [
    ...new Set(items.map((item) => String(item || "").trim()).filter(Boolean)),
  ];
}

function normalizeResourceSelections(value, idsValue) {
  const selectedItems = Array.isArray(value) ? value : [];
  const selections = [];
  const seenIds = new Set();

  selectedItems.forEach((item) => {
    const id = String(item?.id || "").trim();

    if (!id || seenIds.has(id)) {
      return;
    }

    seenIds.add(id);
    selections.push({
      id,
      title: String(item?.title || item?.handle || id.split("/").pop()).trim(),
    });
  });

  normalizeIdList(idsValue).forEach((id) => {
    if (seenIds.has(id)) {
      return;
    }

    seenIds.add(id);
    selections.push({
      id,
      title: id.split("/").pop(),
    });
  });

  return selections;
}

export function normalizeRewardConditions(value) {
  const minSpend = Number(value?.minSpend);
  const products = normalizeResourceSelections(
    value?.products,
    value?.productIds,
  );
  const collections = normalizeResourceSelections(
    value?.collections,
    value?.collectionIds,
  );
  const productIds = products.map((product) => product.id);
  const collectionIds = collections.map((collection) => collection.id);
  const conditions = {};

  if (Number.isFinite(minSpend) && minSpend > 0) {
    conditions.minSpend = minSpend;
  }

  if (productIds.length > 0) {
    conditions.productIds = productIds;
    conditions.products = products;
  }

  if (collectionIds.length > 0) {
    conditions.collectionIds = collectionIds;
    conditions.collections = collections;
  }

  return conditions;
}

export function hasRewardConditions(reward) {
  const conditions = normalizeRewardConditions(reward?.conditions);

  return Object.keys(conditions).length > 0;
}

export function normalizeRewardTypePreference(value) {
  return REWARD_TYPE_PREFERENCES.includes(value) ? value : "both";
}

export function parseRewardSettings(value) {
  let parsed = value;

  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {
        rewardTypePreference: "both",
        rewards: null,
      };
    }
  }

  if (Array.isArray(parsed)) {
    return {
      rewardTypePreference: "both",
      rewards: parsed,
    };
  }

  if (parsed && typeof parsed === "object" && Array.isArray(parsed.rewards)) {
    return {
      rewardTypePreference: normalizeRewardTypePreference(
        parsed.rewardTypePreference,
      ),
      rewards: parsed.rewards,
    };
  }

  return {
    rewardTypePreference: "both",
    rewards: null,
  };
}

export function serializeRewardSettings(rewards, rewardTypePreference) {
  return JSON.stringify({
    rewardTypePreference: normalizeRewardTypePreference(rewardTypePreference),
    rewards,
  });
}

export function getRewardTypePreferenceFromSettings(value) {
  return parseRewardSettings(value).rewardTypePreference;
}

export function normalizeRewardOptions(value) {
  const parsedSettings = parseRewardSettings(value);

  if (!Array.isArray(parsedSettings.rewards)) {
    return null;
  }

  const rewards = parsedSettings.rewards
    .map((reward) => {
      const points = Number(reward?.points);
      const type = reward?.type || "discount";
      const discount = Number(reward?.discount);
      const amount = Number(reward?.amount);
      const conditions = normalizeRewardConditions(reward?.conditions);
      const ruleData =
        Object.keys(conditions).length > 0
          ? {
              conditions,
            }
          : {};

      if (!Number.isInteger(points) || points < 1) {
        return null;
      }

      if (type === "gift_card") {
        if (!Number.isFinite(amount) || amount <= 0) {
          return null;
        }

        return {
          type: "gift_card",
          points,
          amount,
          ...ruleData,
        };
      }

      if (type === "store_credit") {
        if (!Number.isFinite(amount) || amount <= 0) {
          return null;
        }

        return {
          type: "store_credit",
          points,
          amount,
          title: reward?.title || "Store Credit Reward",
          description: reward?.description || "Redeem points for store credit",
          ...ruleData,
        };
      }

      if (!Number.isFinite(discount) || discount <= 0) {
        return null;
      }

      return {
        type: "discount",
        points,
        discount,
        ...ruleData,
      };
    })
    .filter(Boolean);

  if (rewards.length === 0) {
    return null;
  }

  return rewards.sort((a, b) => a.points - b.points);
}

export function getRewardOptionsWithSpecials(value) {
  const configuredRewards = normalizeRewardOptions(value) || [];
  const discountRewards = configuredRewards.filter(
    (reward) => (reward.type || "discount") === "discount",
  );
  const giftCardRewards = configuredRewards.filter(
    (reward) => reward.type === "gift_card",
  );
  const storeCreditRewards = configuredRewards.filter(
    (reward) => reward.type === "store_credit",
  );
  const rewards = [
    ...(discountRewards.length > 0 ? discountRewards : DEFAULT_REWARD_OPTIONS),
    ...(giftCardRewards.length > 0
      ? giftCardRewards
      : DEFAULT_GIFT_CARD_REWARD_OPTIONS),
    ...(storeCreditRewards.length > 0
      ? storeCreditRewards
      : SPECIAL_REWARD_OPTIONS),
  ];

  return rewards.sort((a, b) => a.points - b.points);
}

export function getStoreCreditRewardOption(value) {
  return getRewardOptionsWithSpecials(value).find(
    (reward) => reward.type === "store_credit",
  );
}

export function filterRewardOptionsByPreference(rewards, preference) {
  const normalizedPreference = normalizeRewardTypePreference(preference);

  if (normalizedPreference === "both") {
    return rewards.filter((reward) =>
      ["discount", "gift_card", "store_credit"].includes(
        reward.type || "discount",
      ),
    );
  }

  return rewards.filter(
    (reward) => (reward.type || "discount") === normalizedPreference,
  );
}

export function getRewardOptionsForPreference(value, preference) {
  const effectivePreference =
    preference ?? getRewardTypePreferenceFromSettings(value);

  return filterRewardOptionsByPreference(
    getRewardOptionsWithSpecials(value),
    effectivePreference,
  );
}

export function normalizeCheckoutRewardLimit(value) {
  const limit = Number(value);

  if (!Number.isInteger(limit) || limit < 1) {
    return DEFAULT_LOYALTY_SETTINGS.checkoutRewardLimit;
  }

  return Math.min(limit, 20);
}

export function limitCheckoutRewardOptions(rewards, limit) {
  if (!Array.isArray(rewards)) {
    return rewards;
  }

  return rewards.slice(0, normalizeCheckoutRewardLimit(limit));
}

function normalizeRuleId(value) {
  return String(value || "").trim();
}

function getComparableIds(value) {
  const id = normalizeRuleId(value);

  if (!id) {
    return [];
  }

  return [id, id.split("/").pop()].filter(Boolean);
}

function getRuleContextIds(value) {
  return new Set(
    normalizeIdList(value).flatMap((item) => getComparableIds(item)),
  );
}

export function normalizeRewardRuleContext(value = {}) {
  const cartSubtotal = Number(value.cartSubtotal ?? value.subtotal ?? 0);
  const lines = Array.isArray(value.lines) ? value.lines : [];
  const productIds = new Set();
  const collectionIds = new Set();

  getRuleContextIds(value.productIds).forEach((id) => productIds.add(id));
  getRuleContextIds(value.collectionIds).forEach((id) => collectionIds.add(id));

  lines.forEach((line) => {
    getComparableIds(
      line?.productId ||
        line?.product?.id ||
        line?.merchandise?.product?.id ||
        line?.merchandise?.productId,
    ).forEach((id) => productIds.add(id));

    getRuleContextIds(
      line?.collectionIds ||
        line?.product?.collectionIds ||
        line?.merchandise?.product?.collectionIds,
    ).forEach((id) => collectionIds.add(id));
  });

  return {
    cartSubtotal: Number.isFinite(cartSubtotal) ? cartSubtotal : 0,
    productIds,
    collectionIds,
  };
}

export function isRewardEligibleForRuleContext(reward, ruleContext) {
  const conditions = normalizeRewardConditions(reward?.conditions);

  if (Object.keys(conditions).length === 0) {
    return true;
  }

  const context = normalizeRewardRuleContext(ruleContext);

  if (
    conditions.minSpend &&
    Number(context.cartSubtotal || 0) < conditions.minSpend
  ) {
    return false;
  }

  if (
    conditions.productIds?.length > 0 &&
    !conditions.productIds.some((id) =>
      getComparableIds(id).some((comparableId) =>
        context.productIds.has(comparableId),
      ),
    )
  ) {
    return false;
  }

  if (
    conditions.collectionIds?.length > 0 &&
    !conditions.collectionIds.some((id) =>
      getComparableIds(id).some((comparableId) =>
        context.collectionIds.has(comparableId),
      ),
    )
  ) {
    return false;
  }

  return true;
}

export function filterRewardsByRuleContext(rewards, ruleContext) {
  if (!Array.isArray(rewards)) {
    return rewards;
  }

  return rewards.filter((reward) =>
    isRewardEligibleForRuleContext(reward, ruleContext),
  );
}

export function getRewardRuleEligibility(reward, ruleContext) {
  const conditions = normalizeRewardConditions(reward?.conditions);

  if (Object.keys(conditions).length === 0) {
    return { eligible: true };
  }

  const context = normalizeRewardRuleContext(ruleContext);
  const reasons = [];

  if (
    conditions.minSpend &&
    Number(context.cartSubtotal || 0) < conditions.minSpend
  ) {
    const cartSubtotal = Number(context.cartSubtotal || 0);

    reasons.push({
      type: "min_spend",
      minSpend: conditions.minSpend,
      cartSubtotal,
      remainingSpend: Number((conditions.minSpend - cartSubtotal).toFixed(2)),
    });
  }

  if (
    conditions.productIds?.length > 0 &&
    !conditions.productIds.some((id) =>
      getComparableIds(id).some((comparableId) =>
        context.productIds.has(comparableId),
      ),
    )
  ) {
    reasons.push({ type: "product" });
  }

  if (
    conditions.collectionIds?.length > 0 &&
    !conditions.collectionIds.some((id) =>
      getComparableIds(id).some((comparableId) =>
        context.collectionIds.has(comparableId),
      ),
    )
  ) {
    reasons.push({ type: "collection" });
  }

  return {
    eligible: reasons.length === 0,
    ...(reasons.length > 0 ? { reasons } : {}),
  };
}

export function addRewardRuleEligibility(rewards, ruleContext) {
  if (!Array.isArray(rewards)) {
    return rewards;
  }

  return rewards.map((reward) => ({
    ...reward,
    ruleEligibility: getRewardRuleEligibility(reward, ruleContext),
  }));
}
