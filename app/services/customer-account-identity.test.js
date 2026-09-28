import assert from "node:assert/strict";
import test from "node:test";
import { getCustomerShopDomain } from "./customer-account-identity.server.js";

function createPrisma(customers) {
  return {
    customer: {
      findMany: async (query) => {
        assert.deepEqual(query, {
          where: { shopifyCustomerId: "123" },
          select: { shop: { select: { shopDomain: true } } },
          take: 2,
        });
        return customers;
      },
    },
  };
}

test("resolves the Customer Account tenant from the signed customer identity", async () => {
  const shopDomain = await getCustomerShopDomain(
    "123",
    createPrisma([{ shop: { shopDomain: "example.myshopify.com" } }]),
  );

  assert.equal(shopDomain, "example.myshopify.com");
});

test("rejects missing or ambiguous customer-to-shop mappings", async () => {
  assert.equal(await getCustomerShopDomain("123", createPrisma([])), null);
  assert.equal(
    await getCustomerShopDomain(
      "123",
      createPrisma([
        { shop: { shopDomain: "first.myshopify.com" } },
        { shop: { shopDomain: "second.myshopify.com" } },
      ]),
    ),
    null,
  );
});
