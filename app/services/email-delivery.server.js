import { dispatchEmailNotification } from "./email-dispatcher.server";
import { coordinateLoyaltyEmailDelivery } from "./email-delivery.shared";
import { queueLoyaltyEmail } from "./email-notifications.server";
import { logError } from "./errors.server";

export async function queueAndDispatchLoyaltyEmail(
  input,
  { queue = queueLoyaltyEmail, dispatch = dispatchEmailNotification } = {},
) {
  return coordinateLoyaltyEmailDelivery(input, { queue, dispatch });
}

export async function tryQueueAndDispatchLoyaltyEmail(input) {
  try {
    return await queueAndDispatchLoyaltyEmail(input);
  } catch (error) {
    logError("email-delivery:queue-and-dispatch", error, {
      eventType: input?.eventType,
      shopId: input?.shopId,
      customerId: input?.customerId,
      idempotencyKey: input?.idempotencyKey,
    });

    return {
      status: "skipped",
      reason: "queue_or_dispatch_error",
      error,
    };
  }
}
