import prisma from "../db.server";
import { DEFAULT_EMAIL_NOTIFICATION_SETTINGS } from "./email-notifications.shared";

export const LOYALTY_EMAIL_EVENTS = {
  SIGNUP_BONUS: "signup_bonus",
  ORDER_POINTS: "order_points",
  REWARD_CREATED: "reward_created",
  REWARD_APPLIED: "reward_applied",
  REFUND_POINTS: "refund_points",
  POINTS_EXPIRING_SOON: "points_expiring_soon",
  POINTS_EXPIRED: "points_expired",
  REFERRAL_CLAIMED: "referral_claimed",
  REFERRAL_REWARDED: "referral_rewarded",
  BIRTHDAY_REWARD: "birthday_reward",
};

export { DEFAULT_EMAIL_NOTIFICATION_SETTINGS };

const EMAIL_EVENT_SETTING_FIELDS = {
  [LOYALTY_EMAIL_EVENTS.SIGNUP_BONUS]: "signupBonusEnabled",
  [LOYALTY_EMAIL_EVENTS.ORDER_POINTS]: "orderPointsEnabled",
  [LOYALTY_EMAIL_EVENTS.REWARD_CREATED]: "rewardCreatedEnabled",
  [LOYALTY_EMAIL_EVENTS.REWARD_APPLIED]: "rewardAppliedEnabled",
  [LOYALTY_EMAIL_EVENTS.REFUND_POINTS]: "refundEnabled",
  [LOYALTY_EMAIL_EVENTS.POINTS_EXPIRING_SOON]: "pointsExpiryEnabled",
  [LOYALTY_EMAIL_EVENTS.POINTS_EXPIRED]: "pointsExpiryEnabled",
  [LOYALTY_EMAIL_EVENTS.REFERRAL_CLAIMED]: "referralEnabled",
  [LOYALTY_EMAIL_EVENTS.REFERRAL_REWARDED]: "referralEnabled",
  [LOYALTY_EMAIL_EVENTS.BIRTHDAY_REWARD]: "birthdayRewardEnabled",
};

function normalizeEmail(value) {
  const email = String(value || "")
    .trim()
    .toLowerCase();

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function normalizeOptionalString(value) {
  const normalized = String(value || "").trim();

  return normalized || null;
}

function normalizePayload(value) {
  if (value == null) {
    return null;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {
      value: String(value),
    };
  }
}

function isUniqueConstraintError(error) {
  return error?.code === "P2002";
}

export async function getEmailNotificationSettings(shopId) {
  return prisma.emailNotificationSetting.upsert({
    where: {
      shopId,
    },
    update: {},
    create: {
      shopId,
      ...DEFAULT_EMAIL_NOTIFICATION_SETTINGS,
    },
  });
}

export async function queueLoyaltyEmail({
  shopId,
  customerId = null,
  eventType,
  recipientEmail,
  recipientName = null,
  subject,
  payload = null,
  idempotencyKey,
}) {
  const numericShopId = Number(shopId);
  const numericCustomerId = Number(customerId);
  const normalizedEventType = String(eventType || "").trim();
  const settingField = EMAIL_EVENT_SETTING_FIELDS[normalizedEventType];
  const normalizedEmail = normalizeEmail(recipientEmail);
  const normalizedSubject = String(subject || "").trim();
  const normalizedIdempotencyKey = String(idempotencyKey || "").trim();

  if (!Number.isInteger(numericShopId) || numericShopId < 1) {
    return {
      status: "skipped",
      reason: "invalid_shop",
    };
  }

  if (!settingField) {
    return {
      status: "skipped",
      reason: "unsupported_event",
    };
  }

  if (!normalizedEmail) {
    return {
      status: "skipped",
      reason: "invalid_recipient",
    };
  }

  if (!normalizedSubject) {
    return {
      status: "skipped",
      reason: "missing_subject",
    };
  }

  if (!normalizedIdempotencyKey) {
    return {
      status: "skipped",
      reason: "missing_idempotency_key",
    };
  }

  const settings = await getEmailNotificationSettings(numericShopId);

  if (settings.enabled === false || settings[settingField] === false) {
    return {
      status: "skipped",
      reason: "disabled",
      settingField,
    };
  }

  try {
    const notification = await prisma.emailNotification.create({
      data: {
        shopId: numericShopId,
        customerId:
          Number.isInteger(numericCustomerId) && numericCustomerId > 0
            ? numericCustomerId
            : null,
        eventType: normalizedEventType,
        recipientEmail: normalizedEmail,
        recipientName: normalizeOptionalString(recipientName),
        subject: normalizedSubject,
        payload: normalizePayload(payload),
        idempotencyKey: normalizedIdempotencyKey,
      },
    });

    return {
      status: "queued",
      notification,
    };
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    const notification = await prisma.emailNotification.findUnique({
      where: {
        idempotencyKey: normalizedIdempotencyKey,
      },
    });

    return {
      status: "existing",
      notification,
    };
  }
}

export async function tryQueueLoyaltyEmail(notification) {
  try {
    return await queueLoyaltyEmail(notification);
  } catch (error) {
    console.error(
      "[email-notifications] Could not queue loyalty email",
      error,
      {
        eventType: notification?.eventType,
        shopId: notification?.shopId,
        customerId: notification?.customerId,
        idempotencyKey: notification?.idempotencyKey,
      },
    );

    return {
      status: "skipped",
      reason: "queue_error",
      error,
    };
  }
}
