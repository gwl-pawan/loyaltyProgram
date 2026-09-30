import assert from "node:assert/strict";
import test from "node:test";

import { buildLoyaltyEmailMessage } from "./email-message.shared.js";
import {
  EMAIL_TEMPLATE_DEFINITIONS,
  normalizeEmailTemplates,
} from "./email-notifications.shared.js";

test("keeps template defaults prefilled without storing unchanged overrides", () => {
  const orderTemplate = EMAIL_TEMPLATE_DEFINITIONS.find(
    (template) => template.eventType === "order_points",
  );
  const templates = normalizeEmailTemplates({
    order_points: {
      ...orderTemplate.defaults,
      title: "A custom heading for {{customer_name}}",
    },
  });

  assert.deepEqual(templates, {
    order_points: {
      title: "A custom heading for {{customer_name}}",
    },
  });
});

test("builds reward-created email content from notification payload", () => {
  const message = buildLoyaltyEmailMessage({
    eventType: "reward_created",
    recipientEmail: "customer@example.com",
    recipientName: "Ada",
    subject: "Your loyalty reward is ready",
    payload: {
      rewardType: "discount",
      rewardCode: "LOYALTY-123",
      amount: 5,
      currencyCode: "USD",
      pointsUsed: 250,
      shopDomain: "example.myshopify.com",
    },
  });

  assert.equal(message.to, "customer@example.com");
  assert.equal(message.subject, "Your loyalty reward is ready");
  assert.match(message.text, /Hi Ada,/);
  assert.match(message.text, /LOYALTY-123/);
  assert.match(message.text, /250/);
  assert.match(message.html, /LOYALTY-123/);
  assert.match(message.html, /REWARD READY/);
  assert.match(message.html, /Shop with your reward/);
  assert.match(message.html, /https:\/\/example\.myshopify\.com/);
  assert.match(message.html, /<!doctype html>/);
});

test("hides internal reward codes from store-credit emails", () => {
  const transactionId =
    "gid://shopify/StoreCreditAccountCreditTransaction/4676288740";
  const message = buildLoyaltyEmailMessage({
    eventType: "reward_created",
    recipientEmail: "customer@example.com",
    recipientName: "Ada",
    subject: "Store credit added",
    payload: {
      rewardType: "store_credit",
      rewardCode: transactionId,
      amount: 1,
      currencyCode: "INR",
      pointsUsed: 150,
      shopDomain: "example.myshopify.com",
    },
  });

  assert.doesNotMatch(message.html, /Reward code/i);
  assert.doesNotMatch(message.html, /StoreCreditAccountCreditTransaction/);
  assert.doesNotMatch(message.html, /Enter this code at checkout/i);
  assert.match(message.html, /available automatically at checkout/i);
  assert.doesNotMatch(message.text, /Reward code/i);
  assert.doesNotMatch(message.text, /StoreCreditAccountCreditTransaction/);
});

test("builds a polished order-points email and hides the Shopify GID", () => {
  const message = buildLoyaltyEmailMessage({
    eventType: "order_points",
    recipientEmail: "customer@example.com",
    recipientName: "Ada <Admin>",
    subject: "You earned 90 loyalty points",
    payload: {
      points: 90,
      orderId: "gid://shopify/Order/6960430776548",
      orderName: "#1077",
      orderTotal: 927.42,
      currencyCode: "USD",
      shopDomain: "hydrogen-jey.myshopify.com",
    },
  });

  assert.match(message.text, /Order: #1077/);
  assert.doesNotMatch(message.text, /gid:\/\/shopify/);
  assert.match(message.html, /Hydrogen Jey/);
  assert.match(message.html, /\$927\.42/);
  assert.match(message.html, /\+90/);
  assert.match(message.html, /Hi Ada &lt;Admin&gt;,/);
  assert.doesNotMatch(message.html, /gid:\/\/shopify/);
});

test("applies dynamic templates and safely escapes customized content", () => {
  const message = buildLoyaltyEmailMessage(
    {
      eventType: "order_points",
      recipientEmail: "customer@example.com",
      recipientName: "Ada",
      subject: "Default subject",
      payload: {
        points: 90,
        orderName: "#1077",
        shopDomain: "example.myshopify.com",
      },
    },
    {
      templates: {
        order_points: {
          subject: "{{customer_name}}, you earned {{points}} points",
          title: "Reward from {{store_name}}",
          intro:
            "Order {{order_number}} earned {{points}} points <script>alert(1)</script>",
          note: "New balance: {{points_balance}}",
          ctaLabel: "View rewards",
        },
      },
    },
  );

  assert.equal(message.subject, "Ada, you earned 90 points");
  assert.match(message.html, /Reward from Example/);
  assert.match(message.html, /Order #1077 earned 90 points/);
  assert.match(message.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(message.html, /<script>alert/);
  assert.match(message.text, /Order #1077 earned 90 points/);
});

test("renders a dynamic special-date reward heading", () => {
  const message = buildLoyaltyEmailMessage(
    {
      eventType: "special_date_reward",
      recipientEmail: "customer@example.com",
      recipientName: "Ada",
      subject: "Founder's Day reward",
      payload: {
        points: 300,
        pointsBalanceAfter: 1000,
        rewardHeading: "Founder's Day",
        shopDomain: "example.myshopify.com",
      },
    },
    {
      templates: {
        special_date_reward: {
          title: "{{reward_heading}}",
          intro: "You received {{points}} points for {{reward_heading}}.",
        },
      },
    },
  );

  assert.match(message.html, /Founder&#39;s Day/);
  assert.match(message.text, /You received 300 points for Founder's Day/);
});

test("renders complete HTML and text for every loyalty email event", () => {
  const fixtures = [
    ["signup_bonus", { points: 100 }],
    ["order_points", { points: 90, orderName: "#1001" }],
    [
      "reward_created",
      { pointsUsed: 250, rewardType: "discount", rewardCode: "SAVE-5" },
    ],
    [
      "reward_applied",
      { pointsUsed: 250, rewardType: "discount", orderName: "#1001" },
    ],
    ["refund_points", { pointsDeducted: 25, orderName: "#1001" }],
    ["points_expiring_soon", { pointsExpiring: 50 }],
    ["points_expired", { pointsExpired: 50, pointsBalanceAfter: 200 }],
    ["referral_rewarded", { points: 100, role: "advocate" }],
    ["referral_claimed", {}],
    ["birthday_reward", { points: 250, pointsBalanceAfter: 700 }],
    [
      "special_date_reward",
      {
        points: 300,
        pointsBalanceAfter: 1000,
        rewardHeading: "Founder's Day",
      },
    ],
  ];

  for (const [eventType, payload] of fixtures) {
    const message = buildLoyaltyEmailMessage({
      eventType,
      recipientEmail: "customer@example.com",
      recipientName: "Ada",
      subject: "Loyalty account update",
      payload: {
        ...payload,
        shopDomain: "example.myshopify.com",
      },
    });

    assert.match(message.html, /<!doctype html>/, eventType);
    assert.match(
      message.html,
      /Visit store|View rewards|Use your points|Shop with your reward|Start earning again/,
      eventType,
    );
    assert.doesNotMatch(
      message.html,
      /undefined|null|\[object Object\]/,
      eventType,
    );
    assert.doesNotMatch(
      message.text,
      /undefined|null|\[object Object\]/,
      eventType,
    );
  }
});
