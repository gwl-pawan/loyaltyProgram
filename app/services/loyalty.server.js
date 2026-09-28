import prisma from "../db.server";
import { tryQueueAndDispatchLoyaltyEmail } from "./email-delivery.server";
import { LOYALTY_EMAIL_EVENTS } from "./email-notifications.server";
import { getLoyaltySettings } from "./loyalty-settings.server";

export async function addSignupBonus(shopDomain, customerData) {
  const { shop, settings } = await getLoyaltySettings(shopDomain);

  const result = await prisma.$transaction(async (tx) => {
    const now = new Date();
    const shopifyCustomerId = String(customerData.id);
    let customer = await tx.customer.findFirst({
      where: {
        shopId: shop.id,
        shopifyCustomerId,
      },
    });

    if (customer) {
      return {
        customer,
        created: false,
      };
    }

    customer = await tx.customer.create({
      data: {
        shopId: shop.id,
        shopifyCustomerId,
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

    return {
      customer,
      created: true,
    };
  });

  if (result.created && result.customer.email) {
    await tryQueueAndDispatchLoyaltyEmail({
      shopId: shop.id,
      customerId: result.customer.id,
      eventType: LOYALTY_EMAIL_EVENTS.SIGNUP_BONUS,
      recipientEmail: result.customer.email,
      recipientName: result.customer.name,
      subject: `You earned ${settings.signupBonusPoints} welcome points`,
      payload: {
        points: settings.signupBonusPoints,
        shopDomain,
        customerId: result.customer.shopifyCustomerId,
      },
      idempotencyKey: `signup-bonus:${shop.id}:${result.customer.shopifyCustomerId}`,
    });
  }

  return result.customer;
}
