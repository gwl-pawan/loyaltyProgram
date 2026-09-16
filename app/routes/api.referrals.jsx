import { logError, parseJsonRequest } from "../services/errors.server";
import {
  claimReferral,
  getOrCreateReferralProfile,
  trackReferralVisit,
} from "../services/referrals.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, init = {}) {
  return Response.json(data, { ...init, headers: { ...CORS_HEADERS, ...init.headers } });
}

function normalizeShop(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return String(value || "").trim();
  }
}

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  try {
    const url = new URL(request.url);
    const shop = normalizeShop(url.searchParams.get("shop"));
    const customerId = url.searchParams.get("customerId");
    if (!shop || !customerId) return json({ success: false, message: "shop and customerId are required" }, { status: 400 });

    const referral = await getOrCreateReferralProfile(shop, customerId);
    return json({ success: true, referral });
  } catch (error) {
    logError("referrals:profile", error);
    return json({ success: false, message: "Could not load referral details" }, { status: 500 });
  }
};

export const action = async ({ request }) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  try {
    const body = await parseJsonRequest(request, "referral");
    const shopDomain = normalizeShop(body.shop);
    if (body.action === "track") {
      const referral = await trackReferralVisit({ shopDomain, code: body.code, visitorToken: body.visitorToken, landingUrl: body.landingUrl });
      return json({ success: true, tracked: Boolean(referral) });
    }
    if (body.action === "claim") {
      const referral = await claimReferral({ shopDomain, visitorToken: body.visitorToken, shopifyCustomerId: body.customerId });
      return json({ success: true, claimed: Boolean(referral) });
    }
    return json({ success: false, message: "Unsupported referral action" }, { status: 400 });
  } catch (error) {
    logError("referrals:action", error);
    return json({ success: false, message: "Could not process referral" }, { status: error?.status === 400 ? 400 : 500 });
  }
};

export const headers = () => CORS_HEADERS;
