import { authenticate } from "../shopify.server";
import {
  deleteCustomerBirthday,
  getBirthdayRewardProfile,
  saveCustomerBirthday,
} from "../services/birthday-rewards.server";
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
  // Customer Account tokens can use a generic shopify.com destination rather
  // than a myshopify.com domain. Resolve tenancy from the verified customer
  // identity so a generic token destination cannot select the wrong shop.
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
    const birthday = await getBirthdayRewardProfile(shopDomain, customerId);
    return cors(json({ success: true, birthday }));
  } catch (error) {
    if (error instanceof Response) return responseWithCors(error);
    logError("customer-account:birthday", error);
    return json(
      { success: false, message: "Could not load birthday" },
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
    const body = await parseJsonRequest(request, "birthday");
    const birthday =
      request.method === "DELETE" || body.action === "delete"
        ? await deleteCustomerBirthday({
            shopDomain,
            shopifyCustomerId: customerId,
          })
        : await saveCustomerBirthday({
            shopDomain,
            shopifyCustomerId: customerId,
            birthday: body.birthday || body,
          });
    return cors(json({ success: true, birthday }));
  } catch (error) {
    if (error instanceof Response) return responseWithCors(error);
    logError("customer-account:birthday-action", error);
    return json(
      { success: false, message: error?.message || "Could not save birthday" },
      { status: error?.status || 500 },
    );
  }
};

export const headers = () => HEADERS;
