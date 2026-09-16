/* global process */
import { logError } from "../services/errors.server";
import { processPointsExpiry } from "../services/points-expiry.server";

function getBearerToken(request) {
  const authorization = request.headers.get("authorization") || "";

  return authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : request.headers.get("x-points-expiry-secret") || "";
}

function isAuthorized(request) {
  const configuredSecret = process.env.POINTS_EXPIRY_SECRET;

  return Boolean(
    configuredSecret && getBearerToken(request) === configuredSecret,
  );
}

async function runExpiry(request) {
  if (!process.env.POINTS_EXPIRY_SECRET) {
    return Response.json(
      {
        success: false,
        message: "POINTS_EXPIRY_SECRET is not configured",
      },
      { status: 503 },
    );
  }

  if (!isAuthorized(request)) {
    return Response.json(
      { success: false, message: "Unauthorized" },
      { status: 401 },
    );
  }

  try {
    const url = new URL(request.url);
    let input = {};

    if (request.method !== "GET") {
      const text = await request.text();
      input = text ? JSON.parse(text) : {};
    }

    const summary = await processPointsExpiry({
      shopDomain: input.shop || url.searchParams.get("shop") || undefined,
      customerId:
        input.customerId || url.searchParams.get("customerId") || undefined,
      batchSize:
        input.batchSize || url.searchParams.get("batchSize") || undefined,
    });

    return Response.json({ success: true, ...summary });
  } catch (error) {
    logError("points-expiry:route", error);

    return Response.json(
      { success: false, message: "Could not process point expiry" },
      { status: 500 },
    );
  }
}

export const loader = async ({ request }) => runExpiry(request);
export const action = async ({ request }) => runExpiry(request);
