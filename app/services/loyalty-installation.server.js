import prisma from "../db.server";
import { getEmailNotificationSettings } from "./email-notifications.server";
import {
  DEFAULT_LOYALTY_SETTINGS,
  filterLoyaltySettingData,
  getLoyaltySettings,
} from "./loyalty-settings.server";
import {
  canUseCheckoutIntegration,
  getEffectiveIntegration,
  syncShopPlan,
} from "./shop-plan.server";

export async function ensurePlanAwareLoyaltySetup(shopDomain, admin) {
  let shop;
  let planSyncError = null;

  try {
    shop = await syncShopPlan(shopDomain, admin);
  } catch (error) {
    planSyncError = error;
    const fallback = await getLoyaltySettings(shopDomain);

    return {
      ...fallback,
      planSyncError,
      checkoutAvailable: canUseCheckoutIntegration(fallback.shop),
      effectiveIntegration: getEffectiveIntegration(fallback.shop),
    };
  }

  const effectiveIntegration = getEffectiveIntegration(shop);
  const settingData = filterLoyaltySettingData({
    ...DEFAULT_LOYALTY_SETTINGS,
    preferredIntegration: effectiveIntegration,
  });
  const planAwareUpdate = filterLoyaltySettingData({
    preferredIntegration: effectiveIntegration,
  });

  const settings = await prisma.loyaltySetting.upsert({
    where: {
      shopId: shop.id,
    },
    update: planAwareUpdate,
    create: {
      shopId: shop.id,
      ...settingData,
    },
  });
  await getEmailNotificationSettings(shop.id);

  return {
    shop,
    settings,
    planSyncError,
    checkoutAvailable: canUseCheckoutIntegration(shop),
    effectiveIntegration,
  };
}
