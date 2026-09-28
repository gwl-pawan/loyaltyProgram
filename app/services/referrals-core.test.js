import assert from "node:assert/strict";
import test from "node:test";

import { createReferralService } from "./referrals-core.server.js";
import { normalizeReferralCode } from "./referrals.shared.js";

function selected(record, select) {
  if (!record || !select) return record ? { ...record } : null;
  return Object.fromEntries(
    Object.keys(select)
      .filter((key) => select[key])
      .map((key) => [key, record[key]]),
  );
}

function matches(record, where) {
  return Object.entries(where).every(([key, value]) => {
    if (key === "shopId_visitorToken") {
      return (
        record.shopId === value.shopId &&
        record.visitorToken === value.visitorToken
      );
    }
    return record[key] === value;
  });
}

function createFixture({ enabled = true } = {}) {
  const state = {
    customers: [
      {
        id: 1,
        shopId: 7,
        shopifyCustomerId: "101",
        name: "Advocate",
        email: "advocate@example.com",
        loyaltyPoints: 0,
        orderCount: 3,
        referralCode: null,
      },
      {
        id: 2,
        shopId: 7,
        shopifyCustomerId: "202",
        name: "Friend",
        email: "friend@example.com",
        loyaltyPoints: 0,
        orderCount: 0,
        referralCode: null,
      },
      {
        id: 3,
        shopId: 7,
        shopifyCustomerId: "303",
        name: "Existing customer",
        email: "existing@example.com",
        loyaltyPoints: 0,
        orderCount: 1,
        referralCode: null,
      },
    ],
    referrals: [],
    transactions: [],
    emails: [],
  };

  const customer = {
    findFirst: async ({ where, select }) =>
      selected(
        state.customers.find((item) => matches(item, where)),
        select,
      ),
    update: async ({ where, data, select }) => {
      const record = state.customers.find((item) => matches(item, where));
      if (!record) throw new Error("Customer not found");
      if (data.referralCode !== undefined)
        record.referralCode = data.referralCode;
      if (data.loyaltyPoints?.increment) {
        record.loyaltyPoints += data.loyaltyPoints.increment;
      }
      if (data.lastActivityAt) record.lastActivityAt = data.lastActivityAt;
      return selected(record, select);
    },
  };

  const referral = {
    count: async ({ where }) =>
      state.referrals.filter((item) => matches(item, where)).length,
    upsert: async ({ where, create }) => {
      const existing = state.referrals.find((item) => matches(item, where));
      if (existing) return { ...existing };
      const record = {
        id: state.referrals.length + 1,
        status: "clicked",
        referredCustomerId: null,
        ...create,
      };
      state.referrals.push(record);
      return { ...record };
    },
    findFirst: async ({ where, include }) => {
      const record = state.referrals.find((item) => matches(item, where));
      if (!record) return null;
      const result = { ...record };
      if (include?.advocateCustomer) {
        result.advocateCustomer = selected(
          state.customers.find((item) => item.id === record.advocateCustomerId),
          include.advocateCustomer.select,
        );
      }
      return result;
    },
    findUnique: async ({ where }) => {
      const record = state.referrals.find((item) => matches(item, where));
      return record ? { ...record } : null;
    },
    update: async ({ where, data, include }) => {
      const record = state.referrals.find((item) => matches(item, where));
      if (!record) throw new Error("Referral not found");
      Object.assign(record, data);
      const result = { ...record };
      if (include?.advocateCustomer) {
        result.advocateCustomer = selected(
          state.customers.find((item) => item.id === record.advocateCustomerId),
          include.advocateCustomer.select,
        );
      }
      return result;
    },
  };

  const prisma = {
    customer,
    referral,
    pointTransaction: {
      create: async ({ data }) => {
        if (
          state.transactions.some(
            (item) => item.idempotencyKey === data.idempotencyKey,
          )
        ) {
          throw Object.assign(new Error("Duplicate transaction"), {
            code: "P2002",
          });
        }
        const record = { id: state.transactions.length + 1, ...data };
        state.transactions.push(record);
        return { ...record };
      },
    },
    $transaction: (operation) => operation(prisma),
  };

  const settings = {
    referralProgramEnabled: enabled,
    referralAdvocatePoints: 200,
    referralFriendPoints: 100,
    referralAttributionDays: 30,
  };
  const service = createReferralService({
    prisma,
    getLoyaltySettings: async () => ({
      shop: { id: 7, shopDomain: "test-shop.myshopify.com" },
      settings,
    }),
    createReferralCode: () => "ABCD234567",
    normalizeReferralCode,
    queueEmail: async (email) => {
      state.emails.push(email);
    },
    emailEvents: {
      REFERRAL_CLAIMED: "referral_claimed",
      REFERRAL_REWARDED: "referral_rewarded",
    },
  });

  return { service, settings, state };
}

test("runs the complete referral lifecycle and rewards both customers once", async () => {
  const { service, state } = createFixture();

  const profile = await service.getOrCreateReferralProfile(
    "test-shop.myshopify.com",
    "gid://shopify/Customer/101",
  );
  assert.equal(profile.code, "ABCD234567");
  assert.equal(profile.link, "https://test-shop.myshopify.com/?ref=ABCD234567");

  const visit = await service.trackReferralVisit({
    shopDomain: "test-shop.myshopify.com",
    code: "abcd-234567",
    visitorToken: "visit-1",
    landingUrl: "https://test-shop.myshopify.com/products/example",
  });
  assert.equal(visit.status, "clicked");

  const claim = await service.claimReferral({
    shopDomain: "test-shop.myshopify.com",
    visitorToken: "visit-1",
    shopifyCustomerId: "gid://shopify/Customer/202",
  });
  assert.equal(claim.status, "claimed");
  assert.equal(claim.referredCustomerId, 2);
  assert.equal(state.emails.length, 1);
  assert.equal(state.emails[0].eventType, "referral_claimed");

  const reward = await service.issueQualifiedReferralRewards(
    "test-shop.myshopify.com",
    {
      admin_graphql_api_id: "gid://shopify/Order/9001",
      customer: { id: "gid://shopify/Customer/202" },
    },
  );
  assert.equal(reward.status, "rewarded");
  assert.equal(reward.qualifiedOrderId, "gid://shopify/Order/9001");
  assert.equal(state.customers[0].loyaltyPoints, 200);
  assert.equal(state.customers[1].loyaltyPoints, 100);
  assert.equal(state.transactions.length, 2);
  assert.equal(state.emails.length, 3);

  const duplicate = await service.issueQualifiedReferralRewards(
    "test-shop.myshopify.com",
    {
      admin_graphql_api_id: "gid://shopify/Order/9001",
      customer: { id: "gid://shopify/Customer/202" },
    },
  );
  assert.equal(duplicate, null);
  assert.equal(state.customers[0].loyaltyPoints, 200);
  assert.equal(state.customers[1].loyaltyPoints, 100);
  assert.equal(state.transactions.length, 2);
  assert.equal(state.emails.length, 3);

  const updatedProfile = await service.getOrCreateReferralProfile(
    "test-shop.myshopify.com",
    "101",
  );
  assert.equal(updatedProfile.clicks, 1);
  assert.equal(updatedProfile.successfulReferrals, 1);
});

test("rejects self-referrals and existing customers", async () => {
  const { service, state } = createFixture();
  await service.getOrCreateReferralProfile("test-shop.myshopify.com", "101");

  await service.trackReferralVisit({
    shopDomain: "test-shop.myshopify.com",
    code: "ABCD234567",
    visitorToken: "self-visit",
  });
  const selfClaim = await service.claimReferral({
    shopDomain: "test-shop.myshopify.com",
    visitorToken: "self-visit",
    shopifyCustomerId: "101",
  });
  assert.equal(selfClaim, null);

  await service.trackReferralVisit({
    shopDomain: "test-shop.myshopify.com",
    code: "ABCD234567",
    visitorToken: "existing-visit",
  });
  const existingCustomerClaim = await service.claimReferral({
    shopDomain: "test-shop.myshopify.com",
    visitorToken: "existing-visit",
    shopifyCustomerId: "303",
  });
  assert.equal(existingCustomerClaim, null);
  assert.equal(
    state.referrals.every((item) => item.status === "clicked"),
    true,
  );
});

test("does not track, claim, or reward when referrals are disabled", async () => {
  const { service, state } = createFixture({ enabled: false });
  const visit = await service.trackReferralVisit({
    shopDomain: "test-shop.myshopify.com",
    code: "ABCD234567",
    visitorToken: "visit-1",
  });
  const claim = await service.claimReferral({
    shopDomain: "test-shop.myshopify.com",
    visitorToken: "visit-1",
    shopifyCustomerId: "202",
  });
  const reward = await service.issueQualifiedReferralRewards(
    "test-shop.myshopify.com",
    {
      id: "9001",
      customer: { id: "202" },
    },
  );

  assert.equal(visit, null);
  assert.equal(claim, null);
  assert.equal(reward, null);
  assert.equal(state.referrals.length, 0);
  assert.equal(state.transactions.length, 0);
});

test("requires a visitor token before attempting a claim", async () => {
  const { service } = createFixture();
  assert.equal(
    await service.claimReferral({
      shopDomain: "test-shop.myshopify.com",
      visitorToken: "  ",
      shopifyCustomerId: "202",
    }),
    null,
  );
});

test("claims a tracked cart referral during the first paid order", async () => {
  const { service, state } = createFixture();
  await service.getOrCreateReferralProfile("test-shop.myshopify.com", "101");
  await service.trackReferralVisit({
    shopDomain: "test-shop.myshopify.com",
    code: "ABCD234567",
    visitorToken: "cart-visit",
  });

  const reward = await service.issueQualifiedReferralRewards(
    "test-shop.myshopify.com",
    {
      id: "9002",
      customer: { id: "202" },
      note_attributes: [
        { name: "__loyalty_referral_token", value: "cart-visit" },
      ],
    },
  );

  assert.equal(reward.status, "rewarded");
  assert.equal(reward.referredCustomerId, 2);
  assert.equal(state.customers[0].loyaltyPoints, 200);
  assert.equal(state.customers[1].loyaltyPoints, 100);
  assert.equal(state.transactions.length, 2);
});

test("expires stale referral attribution before it can be claimed", async () => {
  const { service, state } = createFixture();
  await service.getOrCreateReferralProfile("test-shop.myshopify.com", "101");
  await service.trackReferralVisit({
    shopDomain: "test-shop.myshopify.com",
    code: "ABCD234567",
    visitorToken: "expired-visit",
  });
  state.referrals[0].expiresAt = new Date(Date.now() - 1000);

  const claim = await service.claimReferral({
    shopDomain: "test-shop.myshopify.com",
    visitorToken: "expired-visit",
    shopifyCustomerId: "202",
  });

  assert.equal(claim, null);
  assert.equal(state.referrals[0].status, "expired");
  assert.equal(state.emails.length, 0);
});
