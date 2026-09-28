import prisma from "../db.server.js";

export async function getCustomerShopDomain(
  shopifyCustomerId,
  prismaClient = prisma,
) {
  const customers = await prismaClient.customer.findMany({
    where: { shopifyCustomerId: String(shopifyCustomerId) },
    select: { shop: { select: { shopDomain: true } } },
    take: 2,
  });

  return customers.length === 1 ? customers[0].shop.shopDomain : null;
}
