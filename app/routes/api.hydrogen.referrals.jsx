import {
  hydrogenCorsHeaders,
  hydrogenOptionsResponse,
  requireHydrogenApiRequest,
} from "../services/hydrogen-api.server";
import { parseJsonRequest } from "../services/errors.server";
import {
  claimReferral,
  getOrCreateReferralProfile,
  trackReferralVisit,
} from "../services/referrals.server";

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

  const referral = await getOrCreateReferralProfile(shop, customerId);
  return json({ success: true, referral });
};

export const action = async ({ request }) => {
  if (request.method === "OPTIONS") return hydrogenOptionsResponse();
  const unauthorized = requireHydrogenApiRequest(request);
  if (unauthorized) return unauthorized;

  const body = await parseJsonRequest(request, "Hydrogen referral");
  if (!body.shop) {
    return json(
      { success: false, message: "shop is required" },
      { status: 400 },
    );
  }

  if (body.action === "track") {
    const referral = await trackReferralVisit({
      shopDomain: body.shop,
      code: body.code,
      visitorToken: body.visitorToken,
      landingUrl: body.landingUrl,
    });
    return json({
      success: true,
      tracked: Boolean(referral),
      expiresAt: referral?.expiresAt || null,
    });
  }

  if (body.action === "claim") {
    if (!body.customerId) {
      return json(
        { success: false, message: "customerId is required" },
        { status: 400 },
      );
    }
    const referral = await claimReferral({
      shopDomain: body.shop,
      visitorToken: body.visitorToken,
      shopifyCustomerId: body.customerId,
    });
    return json({ success: true, claimed: Boolean(referral) });
  }

  return json(
    { success: false, message: "Unsupported referral action" },
    { status: 400 },
  );
};

export const headers = () => ({
  ...hydrogenCorsHeaders,
  "Cache-Control": "private, no-store",
});
