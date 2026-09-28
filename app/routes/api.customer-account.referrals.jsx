import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { logError } from "../services/errors.server";
import { getOrCreateReferralProfile } from "../services/referrals.server";

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
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

async function getCustomerShopDomain(shopifyCustomerId) {
  const customers = await prisma.customer.findMany({
    where: { shopifyCustomerId },
    select: {
      shop: {
        select: { shopDomain: true },
      },
    },
    take: 2,
  });

  if (customers.length !== 1) return null;
  return customers[0].shop.shopDomain;
}

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: HEADERS });
  }

  try {
    const { sessionToken, cors } =
      await authenticate.public.customerAccount(request);
    const customerId = normalizeCustomerId(sessionToken.sub);
    if (!customerId) {
      return cors(
        json(
          { success: false, message: "Customer login is required" },
          { status: 401 },
        ),
      );
    }

    const shopDomain = await getCustomerShopDomain(customerId);
    if (!shopDomain) {
      return cors(
        json(
          { success: false, message: "Customer loyalty profile was not found" },
          { status: 404 },
        ),
      );
    }

    const referral = await getOrCreateReferralProfile(shopDomain, customerId);
    return cors(json({ success: true, referral }));
  } catch (error) {
    if (error instanceof Response) return responseWithCors(error);

    logError("customer-account:referrals", error);
    return json(
      { success: false, message: "Could not load referral details" },
      { status: 500 },
    );
  }
};

export const headers = () => HEADERS;
