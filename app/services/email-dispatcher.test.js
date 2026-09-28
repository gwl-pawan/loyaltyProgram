import assert from "node:assert/strict";
import test from "node:test";

import { buildLoyaltyEmailMessage } from "./email-message.shared.js";

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

test("builds a polished order-points email and hides the Shopify GID", () => {
  const message = buildLoyaltyEmailMessage({
    eventType: "order_points",
    recipientEmail: "customer@example.com",
    recipientName: "Ada <Admin>",
    subject: "You earned 90 loyalty points",
    payload: {
      points: 90,
      orderId: "gid://shopify/Order/6960430776548",
      orderTotal: 927.42,
      currencyCode: "USD",
      shopDomain: "hydrogen-jey.myshopify.com",
    },
  });

  assert.match(message.text, /Order: #6960430776548/);
  assert.doesNotMatch(message.text, /gid:\/\/shopify/);
  assert.match(message.html, /Hydrogen Jey/);
  assert.match(message.html, /\$927\.42/);
  assert.match(message.html, /\+90/);
  assert.match(message.html, /Hi Ada &lt;Admin&gt;,/);
  assert.doesNotMatch(message.html, /gid:\/\/shopify/);
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
