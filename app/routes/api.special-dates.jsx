import { authenticate } from "../shopify.server";
import {
  deleteCustomerSpecialDate,
  getSpecialDateRewardProfile,
  saveCustomerSpecialDate,
} from "../services/special-date-rewards.server";
import { logError, parseJsonRequest } from "../services/errors.server";

const HEADERS = { "Cache-Control": "private, no-store" };

function json(data, init = {}) {
  return Response.json(data, {
    ...init,
    headers: { ...HEADERS, ...init.headers },
  });
}

async function getIdentity(request) {
  const authentication = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  return {
    shopDomain: String(
      authentication?.session?.shop || url.searchParams.get("shop") || "",
    ).trim(),
    customerId: String(
      url.searchParams.get("logged_in_customer_id") || "",
    ).trim(),
  };
}

export const loader = async ({ request }) => {
  try {
    const identity = await getIdentity(request);
    if (!identity.shopDomain || !identity.customerId) {
      return json(
        { success: false, message: "Customer login is required" },
        { status: 401 },
      );
    }
    const specialDates = await getSpecialDateRewardProfile(
      identity.shopDomain,
      identity.customerId,
    );
    return json({ success: true, specialDates });
  } catch (error) {
    logError("special-dates:profile", error);
    return json(
      { success: false, message: "Could not load special dates" },
      { status: error?.status || 500 },
    );
  }
};

export const action = async ({ request }) => {
  try {
    const identity = await getIdentity(request);
    if (!identity.shopDomain || !identity.customerId) {
      return json(
        { success: false, message: "Customer login is required" },
        { status: 401 },
      );
    }
    const body = await parseJsonRequest(request, "special date");
    const input = {
      shopDomain: identity.shopDomain,
      shopifyCustomerId: identity.customerId,
      slot: body.slot,
    };
    const specialDates =
      request.method === "DELETE" || body.action === "delete"
        ? await deleteCustomerSpecialDate(input)
        : await saveCustomerSpecialDate({ ...input, date: body.date || body });
    return json({ success: true, specialDates });
  } catch (error) {
    logError("special-dates:action", error);
    return json(
      {
        success: false,
        message: error?.message || "Could not save special date",
      },
      { status: error?.status || 500 },
    );
  }
};

export const headers = () => HEADERS;
