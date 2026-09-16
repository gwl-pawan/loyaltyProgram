import prisma from "../db.server";
import { getLoyaltySettings } from "./loyalty-settings.server";
import { createReferralCode, normalizeReferralCode } from "./referrals.shared";

export { createReferralCode, normalizeReferralCode } from "./referrals.shared";

function customerId(value) {
  return String(value || "").split("/").pop();
}

function orderId(payload) {
  return String(payload?.admin_graphql_api_id || payload?.id || "");
}

export async function getOrCreateReferralProfile(shopDomain, shopifyCustomerId) {
  const { shop, settings } = await getLoyaltySettings(shopDomain);
  const customer = await prisma.customer.findFirst({
    where: { shopId: shop.id, shopifyCustomerId: customerId(shopifyCustomerId) },
    select: { id: true, referralCode: true },
  });

  if (!customer) return null;
  let code = customer.referralCode;

  for (let attempt = 0; !code && attempt < 5; attempt += 1) {
    const candidate = createReferralCode();
    try {
      const updated = await prisma.customer.update({
        where: { id: customer.id },
        data: { referralCode: candidate },
        select: { referralCode: true },
      });
      code = updated.referralCode;
    } catch (error) {
      if (error?.code !== "P2002") throw error;
    }
  }

  if (!code) throw new Error("Could not allocate a unique referral code");

  const [clicks, successfulReferrals] = await Promise.all([
    prisma.referral.count({ where: { advocateCustomerId: customer.id } }),
    prisma.referral.count({ where: { advocateCustomerId: customer.id, status: "rewarded" } }),
  ]);

  return {
    enabled: settings.referralProgramEnabled !== false,
    code,
    link: `https://${shop.shopDomain}/?ref=${encodeURIComponent(code)}`,
    advocatePoints: settings.referralAdvocatePoints,
    friendPoints: settings.referralFriendPoints,
    clicks,
    successfulReferrals,
  };
}

export async function trackReferralVisit({ shopDomain, code, visitorToken, landingUrl }) {
  const normalizedCode = normalizeReferralCode(code);
  const token = String(visitorToken || "").trim().slice(0, 191);
  if (!normalizedCode || !token) return null;

  const { shop, settings } = await getLoyaltySettings(shopDomain);
  if (settings.referralProgramEnabled === false) return null;

  const advocate = await prisma.customer.findFirst({
    where: { shopId: shop.id, referralCode: normalizedCode },
    select: { id: true },
  });
  if (!advocate) return null;

  return prisma.referral.upsert({
    where: { visitorToken: token },
    update: {},
    create: {
      shopId: shop.id,
      advocateCustomerId: advocate.id,
      referralCode: normalizedCode,
      visitorToken: token,
      landingUrl: String(landingUrl || "").slice(0, 2000) || null,
    },
  });
}

export async function claimReferral({ shopDomain, visitorToken, shopifyCustomerId }) {
  const token = String(visitorToken || "").trim();
  const { shop, settings } = await getLoyaltySettings(shopDomain);
  if (settings.referralProgramEnabled === false) return null;

  const referred = await prisma.customer.findFirst({
    where: { shopId: shop.id, shopifyCustomerId: customerId(shopifyCustomerId) },
    select: { id: true, orderCount: true },
  });
  if (!referred || referred.orderCount > 0) return null;

  return prisma.$transaction(async (tx) => {
    const referral = await tx.referral.findFirst({
      where: { shopId: shop.id, visitorToken: token },
    });
    if (!referral || referral.advocateCustomerId === referred.id) return null;
    if (referral.referredCustomerId && referral.referredCustomerId !== referred.id) return null;
    const existingClaim = await tx.referral.findUnique({
      where: { referredCustomerId: referred.id },
    });
    if (existingClaim && existingClaim.id !== referral.id) return null;

    return tx.referral.update({
      where: { id: referral.id },
      data: { referredCustomerId: referred.id, status: "claimed", claimedAt: new Date() },
    });
  });
}

export async function issueQualifiedReferralRewards(shopDomain, payload) {
  const shopifyCustomerId = customerId(payload?.customer?.id);
  const paidOrderId = orderId(payload);
  if (!shopifyCustomerId || !paidOrderId) return null;

  const { shop, settings } = await getLoyaltySettings(shopDomain);
  if (settings.referralProgramEnabled === false) return null;

  return prisma.$transaction(async (tx) => {
    const referred = await tx.customer.findFirst({
      where: { shopId: shop.id, shopifyCustomerId },
      select: { id: true },
    });
    if (!referred) return null;

    const referral = await tx.referral.findFirst({
      where: { shopId: shop.id, referredCustomerId: referred.id, status: "claimed" },
    });
    if (!referral) return null;

    const advocatePoints = Math.max(0, settings.referralAdvocatePoints);
    const friendPoints = Math.max(0, settings.referralFriendPoints);
    const credits = [
      [referral.advocateCustomerId, advocatePoints, "Referral reward", `referral:${referral.id}:advocate`],
      [referred.id, friendPoints, "Referred friend reward", `referral:${referral.id}:friend`],
    ];

    for (const [id, points, reason, idempotencyKey] of credits) {
      if (points < 1) continue;
      await tx.customer.update({ where: { id }, data: { loyaltyPoints: { increment: points }, lastActivityAt: new Date() } });
      await tx.pointTransaction.create({
        data: { customerId: id, points, transactionType: "credit", reason, idempotencyKey },
      });
    }

    return tx.referral.update({
      where: { id: referral.id },
      data: { status: "rewarded", qualifiedOrderId: paidOrderId, qualifiedAt: new Date(), rewardedAt: new Date() },
    });
  });
}
