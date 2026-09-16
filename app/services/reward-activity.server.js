import prisma from "../db.server";

export const REWARD_ACTIVITY_TYPES = {
  DISCOUNT_CREATED: "discount_created",
  DISCOUNT_APPLIED: "discount_applied",
  DISCOUNT_EXPIRED: "discount_expired",
  DISCOUNT_FAILED: "discount_failed",
  GIFT_CARD_CREATED: "gift_card_created",
  GIFT_CARD_APPLIED: "gift_card_applied",
  GIFT_CARD_FAILED: "gift_card_failed",
  STORE_CREDIT_CREATED: "store_credit_created",
  STORE_CREDIT_FAILED: "store_credit_failed",
  POINTS_REFUNDED: "points_refunded",
  POINTS_EXPIRED: "points_expired",
};

export async function createRewardActivityLog(
  client,
  { customerId, rewardId, rewardCode, activityType, message, metadata },
) {
  return client.rewardActivityLog.create({
    data: {
      customerId,
      rewardId,
      rewardCode,
      activityType,
      message,
      metadata,
    },
  });
}

export async function tryCreateRewardActivityLog(log) {
  try {
    return await createRewardActivityLog(prisma, log);
  } catch (error) {
    console.error("[reward-activity] Could not create activity log", error);
    return null;
  }
}

export async function expirePendingDiscountRedemptions(client = prisma) {
  const now = new Date();
  const expiredRewards = await client.reward.findMany({
    where: {
      rewardType: "discount",
      status: "pending",
      expiresAt: {
        lte: now,
      },
    },
  });

  const expired = [];

  for (const reward of expiredRewards) {
    const result = await client.$transaction(async (tx) => {
      const updatedReward = await tx.reward.updateMany({
        where: {
          id: reward.id,
          status: "pending",
        },
        data: {
          status: "expired",
          failedReason: "Discount expired before order payment",
        },
      });

      if (updatedReward.count === 0) {
        return null;
      }

      await createRewardActivityLog(tx, {
        customerId: reward.customerId,
        rewardId: reward.id,
        rewardCode: reward.rewardCode,
        activityType: REWARD_ACTIVITY_TYPES.DISCOUNT_EXPIRED,
        message: "Discount expired before order payment.",
        metadata: {
          expiresAt: reward.expiresAt,
        },
      });

      return reward;
    });

    if (result) {
      expired.push(result);
    }
  }

  return expired;
}
