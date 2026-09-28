import { authenticate } from "../shopify.server";
import {
  createBirthdayApiHandlers,
  BIRTHDAY_RESPONSE_HEADERS,
  normalizeShop,
} from "../services/birthday-api.server";
import {
  deleteCustomerBirthday,
  getBirthdayRewardProfile,
  saveCustomerBirthday,
} from "../services/birthday-rewards.server";
import { logError, parseJsonRequest } from "../services/errors.server";

const handlers = createBirthdayApiHandlers({
  authenticateRequest: async (request) => {
    const authentication = await authenticate.public.appProxy(request);
    const url = new URL(request.url);
    return {
      shopDomain: normalizeShop(
        authentication?.session?.shop || url.searchParams.get("shop"),
      ),
      customerId: String(
        url.searchParams.get("logged_in_customer_id") || "",
      ).trim(),
    };
  },
  parseJsonRequest,
  logError,
  getProfile: getBirthdayRewardProfile,
  saveBirthday: saveCustomerBirthday,
  deleteBirthday: deleteCustomerBirthday,
});

export const loader = handlers.loader;
export const action = handlers.action;
export const headers = () => BIRTHDAY_RESPONSE_HEADERS;
