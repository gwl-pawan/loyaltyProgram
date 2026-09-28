function customerId(value) {
  return String(value || "")
    .split("/")
    .pop();
}

function orderId(payload) {
  return String(payload?.admin_graphql_api_id || payload?.id || "");
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function isExpired(referral, now = new Date()) {
  return referral?.expiresAt && new Date(referral.expiresAt) <= now;
}

function orderReferralToken(payload) {
  const attributes = Array.isArray(payload?.note_attributes)
    ? payload.note_attributes
    : [];
  const match = attributes.find((attribute) =>
    ["__loyalty_referral_token", "_loyalty_referral_token"].includes(
      attribute?.name,
    ),
  );

  return String(match?.value || "")
    .trim()
    .slice(0, 191);
}

export function createReferralService({
  prisma,
  getLoyaltySettings,
  createReferralCode,
  normalizeReferralCode,
  queueEmail,
  emailEvents,
}) {
  async function getOrCreateReferralProfile(shopDomain, shopifyCustomerId) {
    const { shop, settings } = await getLoyaltySettings(shopDomain);
    const customer = await prisma.customer.findFirst({
      where: {
        shopId: shop.id,
        shopifyCustomerId: customerId(shopifyCustomerId),
      },
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
      prisma.referral.count({
        where: { advocateCustomerId: customer.id, status: "rewarded" },
      }),
    ]);

    return {
      enabled: settings.referralProgramEnabled !== false,
      code,
      link: `https://${shop.shopDomain}/?ref=${encodeURIComponent(code)}`,
      advocatePoints: settings.referralAdvocatePoints,
      friendPoints: settings.referralFriendPoints,
      attributionDays: settings.referralAttributionDays,
      clicks,
      successfulReferrals,
    };
  }

  async function trackReferralVisit({
    shopDomain,
    code,
    visitorToken,
    landingUrl,
  }) {
    const normalizedCode = normalizeReferralCode(code);
    const token = String(visitorToken || "")
      .trim()
      .slice(0, 191);
    if (!normalizedCode || !token) return null;

    const { shop, settings } = await getLoyaltySettings(shopDomain);
    if (settings.referralProgramEnabled === false) return null;

    const advocate = await prisma.customer.findFirst({
      where: { shopId: shop.id, referralCode: normalizedCode },
      select: { id: true },
    });
    if (!advocate) return null;

    const attributionDays = Math.max(
      1,
      Number(settings.referralAttributionDays) || 30,
    );
    const expiresAt = addDays(new Date(), attributionDays);

    const referral = await prisma.referral.upsert({
      where: {
        shopId_visitorToken: {
          shopId: shop.id,
          visitorToken: token,
        },
      },
      update: {},
      create: {
        shopId: shop.id,
        advocateCustomerId: advocate.id,
        referralCode: normalizedCode,
        visitorToken: token,
        landingUrl: String(landingUrl || "").slice(0, 2000) || null,
        expiresAt,
      },
    });

    return { ...referral, expiresAt: referral.expiresAt || expiresAt };
  }

  async function claimReferral({
    shopDomain,
    visitorToken,
    shopifyCustomerId,
  }) {
    const token = String(visitorToken || "")
      .trim()
      .slice(0, 191);
    if (!token) return null;

    const { shop, settings } = await getLoyaltySettings(shopDomain);
    if (settings.referralProgramEnabled === false) return null;

    const referred = await prisma.customer.findFirst({
      where: {
        shopId: shop.id,
        shopifyCustomerId: customerId(shopifyCustomerId),
      },
      select: {
        id: true,
        orderCount: true,
        name: true,
        email: true,
        shopifyCustomerId: true,
      },
    });
    if (!referred || referred.orderCount > 0) return null;

    const result = await prisma.$transaction(async (tx) => {
      const referral = await tx.referral.findFirst({
        where: { shopId: shop.id, visitorToken: token },
        include: {
          advocateCustomer: {
            select: {
              id: true,
              name: true,
              email: true,
              shopifyCustomerId: true,
            },
          },
        },
      });
      if (!referral || referral.advocateCustomerId === referred.id) return null;
      if (
        referral.referredCustomerId === referred.id &&
        ["claimed", "rewarded"].includes(referral.status)
      ) {
        return { referral, newlyClaimed: false };
      }
      if (
        referral.referredCustomerId &&
        referral.referredCustomerId !== referred.id
      )
        return null;
      if (referral.status !== "clicked") return null;
      if (isExpired(referral)) {
        await tx.referral.update({
          where: { id: referral.id },
          data: { status: "expired" },
        });
        return null;
      }
      const existingClaim = await tx.referral.findUnique({
        where: { referredCustomerId: referred.id },
      });
      if (existingClaim && existingClaim.id !== referral.id) return null;

      const updatedReferral = await tx.referral.update({
        where: { id: referral.id },
        data: {
          referredCustomerId: referred.id,
          status: "claimed",
          claimedAt: new Date(),
        },
      });
      return {
        referral: updatedReferral,
        advocate: referral.advocateCustomer,
        newlyClaimed: true,
      };
    });

    if (!result) return null;

    if (result.newlyClaimed && result.advocate?.email) {
      await queueEmail({
        shopId: shop.id,
        customerId: result.advocate.id,
        eventType: emailEvents.REFERRAL_CLAIMED,
        recipientEmail: result.advocate.email,
        recipientName: result.advocate.name,
        subject: "Your referral was claimed",
        payload: {
          referralId: result.referral.id,
          shopDomain,
          customerId: result.advocate.shopifyCustomerId,
        },
        idempotencyKey: `referral-claimed:${shop.id}:${result.referral.id}`,
      });
    }

    return result.referral;
  }

  async function issueQualifiedReferralRewards(shopDomain, payload) {
    const shopifyCustomerId = customerId(payload?.customer?.id);
    const paidOrderId = orderId(payload);
    const visitorToken = orderReferralToken(payload);
    if (!shopifyCustomerId || !paidOrderId) return null;

    const { shop, settings } = await getLoyaltySettings(shopDomain);
    if (settings.referralProgramEnabled === false) return null;

    const result = await prisma.$transaction(async (tx) => {
      const referred = await tx.customer.findFirst({
        where: { shopId: shop.id, shopifyCustomerId },
        select: {
          id: true,
          name: true,
          email: true,
          shopifyCustomerId: true,
          orderCount: true,
        },
      });
      if (!referred) return null;

      let referral = await tx.referral.findFirst({
        where: {
          shopId: shop.id,
          referredCustomerId: referred.id,
          status: "claimed",
        },
        include: {
          advocateCustomer: {
            select: {
              id: true,
              name: true,
              email: true,
              shopifyCustomerId: true,
            },
          },
        },
      });

      if (!referral && visitorToken && referred.orderCount <= 1) {
        const candidate = await tx.referral.findFirst({
          where: {
            shopId: shop.id,
            visitorToken,
            status: "clicked",
          },
          include: {
            advocateCustomer: {
              select: {
                id: true,
                name: true,
                email: true,
                shopifyCustomerId: true,
              },
            },
          },
        });
        const existingClaim = await tx.referral.findUnique({
          where: { referredCustomerId: referred.id },
        });

        if (
          candidate &&
          !existingClaim &&
          candidate.advocateCustomerId !== referred.id &&
          !isExpired(candidate)
        ) {
          referral = await tx.referral.update({
            where: { id: candidate.id },
            data: {
              referredCustomerId: referred.id,
              status: "claimed",
              claimedAt: new Date(),
            },
            include: {
              advocateCustomer: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  shopifyCustomerId: true,
                },
              },
            },
          });
        } else if (candidate && isExpired(candidate)) {
          await tx.referral.update({
            where: { id: candidate.id },
            data: { status: "expired" },
          });
        }
      }
      if (!referral) return null;

      const advocatePoints = Math.max(0, settings.referralAdvocatePoints);
      const friendPoints = Math.max(0, settings.referralFriendPoints);
      const credits = [
        [
          referral.advocateCustomerId,
          advocatePoints,
          "Referral reward",
          `referral:${referral.id}:advocate`,
        ],
        [
          referred.id,
          friendPoints,
          "Referred friend reward",
          `referral:${referral.id}:friend`,
        ],
      ];

      for (const [id, points, reason, idempotencyKey] of credits) {
        if (points < 1) continue;
        await tx.customer.update({
          where: { id },
          data: {
            loyaltyPoints: { increment: points },
            lastActivityAt: new Date(),
          },
        });
        await tx.pointTransaction.create({
          data: {
            customerId: id,
            points,
            transactionType: "credit",
            reason,
            idempotencyKey,
          },
        });
      }

      const updatedReferral = await tx.referral.update({
        where: { id: referral.id },
        data: {
          status: "rewarded",
          qualifiedOrderId: paidOrderId,
          qualifiedAt: new Date(),
          rewardedAt: new Date(),
        },
      });

      return {
        referral: updatedReferral,
        advocate: referral.advocateCustomer,
        referred,
        advocatePoints,
        friendPoints,
      };
    });

    if (!result) return null;

    if (result.advocatePoints > 0 && result.advocate.email) {
      await queueEmail({
        shopId: shop.id,
        customerId: result.advocate.id,
        eventType: emailEvents.REFERRAL_REWARDED,
        recipientEmail: result.advocate.email,
        recipientName: result.advocate.name,
        subject: `You earned ${result.advocatePoints} referral points`,
        payload: {
          points: result.advocatePoints,
          referralId: result.referral.id,
          qualifiedOrderId: paidOrderId,
          shopDomain,
          customerId: result.advocate.shopifyCustomerId,
          role: "advocate",
        },
        idempotencyKey: `referral-rewarded:${shop.id}:${result.referral.id}:advocate`,
      });
    }

    if (result.friendPoints > 0 && result.referred.email) {
      await queueEmail({
        shopId: shop.id,
        customerId: result.referred.id,
        eventType: emailEvents.REFERRAL_REWARDED,
        recipientEmail: result.referred.email,
        recipientName: result.referred.name,
        subject: `You earned ${result.friendPoints} referral points`,
        payload: {
          points: result.friendPoints,
          referralId: result.referral.id,
          qualifiedOrderId: paidOrderId,
          shopDomain,
          customerId: result.referred.shopifyCustomerId,
          role: "friend",
        },
        idempotencyKey: `referral-rewarded:${shop.id}:${result.referral.id}:friend`,
      });
    }

    return result.referral;
  }

  return {
    claimReferral,
    getOrCreateReferralProfile,
    issueQualifiedReferralRewards,
    trackReferralVisit,
  };
}
