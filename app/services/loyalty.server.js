import prisma from "../db.server";
import { getLoyaltySettings } from "./loyalty-settings.server";

export async function addSignupBonus(shopDomain, customerData) {
  const { shop, settings } = await getLoyaltySettings(shopDomain);

  return prisma.$transaction(async (tx) => {
    const now = new Date();
    let customer = await tx.customer.findFirst({
      where: {
        shopId: shop.id,
        shopifyCustomerId: String(customerData.id),
      },
    });

    if (customer) {
      return customer;
    }

    customer = await tx.customer.create({
      data: {
        shopId: shop.id,
        shopifyCustomerId: String(customerData.id),
        name: `${customerData.first_name || ""} ${customerData.last_name || ""}`.trim(),
        email: customerData.email,
        loyaltyPoints: settings.signupBonusPoints,
        lastActivityAt: now,
      },
    });

    await tx.pointTransaction.create({
      data: {
        customerId: customer.id,
        points: settings.signupBonusPoints,
        transactionType: "credit",
        reason: "Signup Bonus",
      },
    });

    return customer;
  });
}
