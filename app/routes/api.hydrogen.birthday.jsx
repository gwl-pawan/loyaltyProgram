import {
  deleteCustomerBirthday,
  getBirthdayRewardProfile,
  saveCustomerBirthday,
} from "../services/birthday-rewards.server";
import { parseJsonRequest } from "../services/errors.server";
import {
  hydrogenCorsHeaders,
  hydrogenOptionsResponse,
  requireHydrogenApiRequest,
} from "../services/hydrogen-api.server";

function json(data, init = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      ...hydrogenCorsHeaders,
      "Cache-Control": "private, no-store",
      ...init.headers,
    },
  });
}

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") return hydrogenOptionsResponse();
  const unauthorized = requireHydrogenApiRequest(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const customerId = url.searchParams.get("customerId");
  if (!shop || !customerId) {
    return json(
      { success: false, message: "shop and customerId are required" },
      { status: 400 },
    );
  }
  const birthday = await getBirthdayRewardProfile(shop, customerId);
  return json({ success: true, birthday });
};

export const action = async ({ request }) => {
  if (request.method === "OPTIONS") return hydrogenOptionsResponse();
  const unauthorized = requireHydrogenApiRequest(request);
  if (unauthorized) return unauthorized;
  const body = await parseJsonRequest(request, "Hydrogen birthday");
  if (!body.shop || !body.customerId) {
    return json(
      { success: false, message: "shop and customerId are required" },
      { status: 400 },
    );
  }
  try {
    const birthday =
      request.method === "DELETE" || body.action === "delete"
        ? await deleteCustomerBirthday({
            shopDomain: body.shop,
            shopifyCustomerId: body.customerId,
          })
        : await saveCustomerBirthday({
            shopDomain: body.shop,
            shopifyCustomerId: body.customerId,
            birthday: body.birthday || body,
          });
    return json({ success: true, birthday });
  } catch (error) {
    return json(
      { success: false, message: error?.message || "Could not save birthday" },
      { status: error?.status || 500 },
    );
  }
};

export const headers = () => ({
  ...hydrogenCorsHeaders,
  "Cache-Control": "private, no-store",
});
