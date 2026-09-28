import assert from "node:assert/strict";
import test from "node:test";

import { createReferralApiHandlers } from "./referrals-api.server.js";

function createHandlers(overrides = {}) {
  const calls = {
    authenticate: 0,
    claim: [],
    profile: [],
    track: [],
  };
  const handlers = createReferralApiHandlers({
    authenticateAppProxy: async () => {
      calls.authenticate += 1;
      return { session: { shop: "secure-shop.myshopify.com" } };
    },
    parseJsonRequest: (request) => request.json(),
    logError: () => {},
    claimReferral: async (input) => {
      calls.claim.push(input);
      return { id: 1 };
    },
    getOrCreateReferralProfile: async (...input) => {
      calls.profile.push(input);
      return { code: "REFER12345" };
    },
    trackReferralVisit: async (input) => {
      calls.track.push(input);
      return { id: 1 };
    },
    ...overrides,
  });

  return { calls, ...handlers };
}

test("profile uses the authenticated shop and signed customer identity", async () => {
  const { calls, loader } = createHandlers();
  const request = new Request(
    "https://app.example/api/referrals?shop=spoofed.example&customerId=999&logged_in_customer_id=202",
  );

  const response = await loader({ request });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(calls.profile, [["secure-shop.myshopify.com", "202"]]);
});

test("claim ignores customer and shop values supplied in the request body", async () => {
  const { action, calls } = createHandlers();
  const request = new Request(
    "https://app.example/api/referrals?shop=secure-shop.myshopify.com&logged_in_customer_id=202",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "claim",
        shop: "spoofed.example",
        customerId: "999",
        visitorToken: "visit-1",
      }),
    },
  );

  const response = await action({ request });

  assert.equal(response.status, 200);
  assert.deepEqual(calls.claim, [
    {
      shopDomain: "secure-shop.myshopify.com",
      shopifyCustomerId: "202",
      visitorToken: "visit-1",
    },
  ]);
});

test("tracking supports logged-out visitors but still requires app-proxy authentication", async () => {
  const { action, calls } = createHandlers();
  const request = new Request(
    "https://app.example/api/referrals?shop=secure-shop.myshopify.com",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "track",
        code: "REFER12345",
        visitorToken: "visit-1",
        landingUrl: "https://secure-shop.myshopify.com/products/example",
      }),
    },
  );

  const response = await action({ request });

  assert.equal(response.status, 200);
  assert.equal(calls.authenticate, 1);
  assert.deepEqual(calls.track[0], {
    shopDomain: "secure-shop.myshopify.com",
    code: "REFER12345",
    visitorToken: "visit-1",
    landingUrl: "https://secure-shop.myshopify.com/products/example",
  });
});

test("claim and profile reject customers who are not logged in", async () => {
  const { action, loader } = createHandlers();
  const profileResponse = await loader({
    request: new Request(
      "https://app.example/api/referrals?shop=secure-shop.myshopify.com",
    ),
  });
  const claimResponse = await action({
    request: new Request(
      "https://app.example/api/referrals?shop=secure-shop.myshopify.com",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "claim", visitorToken: "visit-1" }),
      },
    ),
  });

  assert.equal(profileResponse.status, 401);
  assert.equal(claimResponse.status, 401);
});

test("authentication failures are returned without calling referral services", async () => {
  const denied = new Response("Invalid app proxy signature", { status: 401 });
  const { calls, loader } = createHandlers({
    authenticateAppProxy: async () => {
      throw denied;
    },
  });

  const response = await loader({
    request: new Request("https://app.example/api/referrals"),
  });

  assert.equal(response, denied);
  assert.deepEqual(calls.profile, []);
});
