import { authenticate } from "../shopify.server";
import {
  deleteCustomerSpecialDate,
  getSpecialDateRewardProfile,
  saveCustomerSpecialDate,
} from "../services/special-date-rewards.server";
import { getCustomerShopDomain } from "../services/customer-account-identity.server";
import { logError, parseJsonRequest } from "../services/errors.server";

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Cache-Control": "private, no-store",
};

function json(data, init = {}) {
  return Response.json(data, {
    ...init,
    headers: { ...HEADERS, ...init.headers },
  });
}

function responseWithCors(response) {
  Object.entries(HEADERS).forEach(([name, value]) => {
    if (!response.headers.has(name)) response.headers.set(name, value);
  });
  return response;
}

function normalizeCustomerId(value) {
  return String(value || "")
    .split("/")
    .pop()
    .trim();
}

async function authenticateCustomer(request) {
  const { sessionToken, cors } =
    await authenticate.public.customerAccount(request);
  const customerId = normalizeCustomerId(sessionToken.sub);
  const shopDomain = customerId
    ? await getCustomerShopDomain(customerId)
    : null;
  return { customerId, shopDomain, cors };
}

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: HEADERS });
  }
  try {
    const { customerId, shopDomain, cors } =
      await authenticateCustomer(request);
    if (!customerId || !shopDomain) {
      return cors(
        json(
          { success: false, message: "Customer loyalty profile was not found" },
          { status: 404 },
        ),
      );
    }
    const specialDates = await getSpecialDateRewardProfile(
      shopDomain,
      customerId,
    );
    return cors(json({ success: true, specialDates }));
  } catch (error) {
    if (error instanceof Response) return responseWithCors(error);
    logError("customer-account:special-dates", error);
    return json(
      { success: false, message: "Could not load special dates" },
      { status: 500 },
    );
  }
};

export const action = async ({ request }) => {
  try {
    const { customerId, shopDomain, cors } =
      await authenticateCustomer(request);
    if (!customerId || !shopDomain) {
      return cors(
        json(
          { success: false, message: "Customer loyalty profile was not found" },
          { status: 404 },
        ),
      );
    }
    const body = await parseJsonRequest(request, "special date");
    const input = {
      shopDomain,
      shopifyCustomerId: customerId,
      slot: body.slot,
    };
    const specialDates =
      request.method === "DELETE" || body.action === "delete"
        ? await deleteCustomerSpecialDate(input)
        : await saveCustomerSpecialDate({ ...input, date: body.date || body });
    return cors(json({ success: true, specialDates }));
  } catch (error) {
    if (error instanceof Response) return responseWithCors(error);
    logError("customer-account:special-date-action", error);
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
