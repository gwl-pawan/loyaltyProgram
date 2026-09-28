import assert from "node:assert/strict";
import test from "node:test";

import { createBirthdayApiHandlers } from "./birthday-api.server.js";

function handlers(overrides = {}) {
  return createBirthdayApiHandlers({
    authenticateRequest: async () => ({
      shopDomain: "secure-shop.myshopify.com",
      customerId: "42",
    }),
    parseJsonRequest: async (request) => request.body || {},
    logError: () => {},
    getProfile: async (shopDomain, customerId) => ({ shopDomain, customerId }),
    saveBirthday: async (input) => input,
    deleteBirthday: async (input) => input,
    ...overrides,
  });
}

test("birthday profile uses authenticated customer identity", async () => {
  const { loader } = handlers();
  const response = await loader({
    request: new Request(
      "https://app.example/api/birthdays?shop=spoofed.example&customerId=999",
    ),
  });
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(data.birthday, {
    shopDomain: "secure-shop.myshopify.com",
    customerId: "42",
  });
});

test("birthday save ignores spoofed identity in the request body", async () => {
  let received;
  const { action } = handlers({
    parseJsonRequest: async () => ({
      shopDomain: "spoofed.example",
      customerId: "999",
      birthday: { month: 4, day: 12 },
    }),
    saveBirthday: async (input) => {
      received = input;
      return input;
    },
  });
  const response = await action({
    request: new Request("https://app.example/api/birthdays", {
      method: "POST",
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(received, {
    shopDomain: "secure-shop.myshopify.com",
    customerId: "42",
    birthday: { month: 4, day: 12 },
  });
});

test("birthday endpoints reject missing authenticated customers", async () => {
  let calls = 0;
  const { loader, action } = handlers({
    authenticateRequest: async () => ({
      shopDomain: "secure-shop.myshopify.com",
      customerId: "",
    }),
    getProfile: async () => {
      calls += 1;
    },
    saveBirthday: async () => {
      calls += 1;
    },
  });
  const loaderResponse = await loader({
    request: new Request("https://app.example/api/birthdays"),
  });
  const actionResponse = await action({
    request: new Request("https://app.example/api/birthdays", {
      method: "POST",
    }),
  });

  assert.equal(loaderResponse.status, 401);
  assert.equal(actionResponse.status, 401);
  assert.equal(calls, 0);
});
