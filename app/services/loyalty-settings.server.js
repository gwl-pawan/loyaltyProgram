import prisma from "../db.server";
import { getEmailNotificationSettings } from "./email-notifications.server";
import { DEFAULT_LOYALTY_SETTINGS } from "./loyalty-settings.shared";

export {
  DEFAULT_LOYALTY_SETTINGS,
  DEFAULT_REWARD_OPTIONS,
  SPECIAL_REWARD_OPTIONS,
  addRewardRuleEligibility,
  filterRewardsByRuleContext,
  filterRewardOptionsByPreference,
  getRewardTypePreferenceFromSettings,
  getRewardOptionsForPreference,
  getRewardOptionsWithSpecials,
  getStoreCreditRewardOption,
  limitCheckoutRewardOptions,
  normalizeRewardOptions,
  normalizeRewardConditions,
  normalizeRewardRuleContext,
  normalizeCheckoutRewardLimit,
  normalizeRewardTypePreference,
  parseRewardSettings,
  serializeRewardSettings,
} from "./loyalty-settings.shared";

export function hasLoyaltySettingField(fieldName) {
  const fields = prisma._runtimeDataModel?.models?.LoyaltySetting?.fields || [];

  return fields.some((field) => field.name === fieldName);
}

export function filterLoyaltySettingData(data) {
  return Object.fromEntries(
    Object.entries(data).filter(([fieldName]) =>
      hasLoyaltySettingField(fieldName),
    ),
  );
}

export async function findOrCreateShop(shopDomain) {
  let shop = await prisma.shop.findUnique({
    where: {
      shopDomain,
    },
  });

  if (!shop) {
    shop = await prisma.shop.create({
      data: {
        shopDomain,
      },
    });
  }

  return shop;
}

export async function getLoyaltySettings(shopDomain) {
  const shop = await findOrCreateShop(shopDomain);

  const settings = await prisma.loyaltySetting.upsert({
    where: {
      shopId: shop.id,
    },
    update: {},
    create: {
      shopId: shop.id,
      ...filterLoyaltySettingData(DEFAULT_LOYALTY_SETTINGS),
    },
  });
  await getEmailNotificationSettings(shop.id);

  return {
    shop,
    settings,
  };
}

export function calculateSpendPoints(amount, spendAmount, spendPoints) {
  const numericAmount = Number(amount);

  if (!Number.isFinite(numericAmount) || spendAmount <= 0 || spendPoints <= 0) {
    return 0;
  }

  return Math.floor(numericAmount / spendAmount) * spendPoints;
}
