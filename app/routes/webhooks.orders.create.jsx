import { authenticate } from "../shopify.server";
import {
  webhookAuthenticationError,
} from "../services/errors.server";

export const action = async ({ request }) => {
  try {
    await authenticate.webhook(request);
  } catch (error) {
    return webhookAuthenticationError("orders/create", error);
  }

  return new Response("Webhook ignored; loyalty rewards are issued after payment", {
    status: 200,
  });
};
