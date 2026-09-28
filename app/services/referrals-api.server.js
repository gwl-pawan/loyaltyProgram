export const REFERRAL_RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store",
};

function json(data, init = {}) {
  return Response.json(data, {
    ...init,
    headers: { ...REFERRAL_RESPONSE_HEADERS, ...init.headers },
  });
}

function requestError(message, status) {
  return Object.assign(new Error(message), { status });
}

function normalizeShop(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return String(value || "").trim();
  }
}

function getAuthenticatedIdentity(request, authentication) {
  const url = new URL(request.url);

  return {
    shopDomain: normalizeShop(
      authentication?.session?.shop || url.searchParams.get("shop"),
    ),
    customerId: String(
      url.searchParams.get("logged_in_customer_id") || "",
    ).trim(),
  };
}

function errorResponse(error, fallbackMessage, logError, context) {
  logError(context, error);

  if (error instanceof Response) return error;

  const status = [400, 401, 403, 405].includes(error?.status)
    ? error.status
    : 500;
  return json(
    {
      success: false,
      message: status === 500 ? fallbackMessage : error.message,
    },
    { status },
  );
}

export function createReferralApiHandlers({
  authenticateAppProxy,
  parseJsonRequest,
  logError,
  claimReferral,
  getOrCreateReferralProfile,
  trackReferralVisit,
}) {
  const loader = async ({ request }) => {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: REFERRAL_RESPONSE_HEADERS,
      });
    }

    try {
      const authentication = await authenticateAppProxy(request);
      const { shopDomain, customerId } = getAuthenticatedIdentity(
        request,
        authentication,
      );
      if (!shopDomain)
        throw requestError("Authenticated shop is required", 400);
      if (!customerId) throw requestError("Customer login is required", 401);

      const referral = await getOrCreateReferralProfile(shopDomain, customerId);
      return json({ success: true, referral });
    } catch (error) {
      return errorResponse(
        error,
        "Could not load referral details",
        logError,
        "referrals:profile",
      );
    }
  };

  const action = async ({ request }) => {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: REFERRAL_RESPONSE_HEADERS,
      });
    }

    try {
      if (request.method !== "POST") {
        throw requestError("Method not allowed", 405);
      }

      const authentication = await authenticateAppProxy(request);
      const { shopDomain, customerId } = getAuthenticatedIdentity(
        request,
        authentication,
      );
      if (!shopDomain)
        throw requestError("Authenticated shop is required", 400);

      const body = await parseJsonRequest(request, "referral");
      if (body.action === "track") {
        const referral = await trackReferralVisit({
          shopDomain,
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
        if (!customerId) throw requestError("Customer login is required", 401);
        const referral = await claimReferral({
          shopDomain,
          visitorToken: body.visitorToken,
          shopifyCustomerId: customerId,
        });
        return json({ success: true, claimed: Boolean(referral) });
      }

      throw requestError("Unsupported referral action", 400);
    } catch (error) {
      return errorResponse(
        error,
        "Could not process referral",
        logError,
        "referrals:action",
      );
    }
  };

  return { action, loader };
}
