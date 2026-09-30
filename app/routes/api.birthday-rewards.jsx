/* global process */
import { Buffer } from "node:buffer";
import crypto from "node:crypto";

import { processBirthdayRewards } from "../services/birthday-rewards.server";
import { processSpecialDateRewards } from "../services/special-date-rewards.server";
import { logError } from "../services/errors.server";

function getToken(request) {
  const authorization = request.headers.get("authorization") || "";
  return authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : request.headers.get("x-birthday-rewards-secret") || "";
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));

  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

async function run(request) {
  const secret = process.env.BIRTHDAY_REWARDS_SECRET;
  if (!secret) {
    return Response.json(
      { success: false, message: "BIRTHDAY_REWARDS_SECRET is not configured" },
      { status: 503 },
    );
  }
  if (!safeEqual(getToken(request), secret)) {
    return Response.json(
      { success: false, message: "Unauthorized" },
      { status: 401 },
    );
  }

  try {
    const body =
      request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const url = new URL(request.url);
    const options = {
      shopDomain: body.shop || url.searchParams.get("shop") || undefined,
      batchSize:
        body.batchSize || url.searchParams.get("batchSize") || undefined,
    };
    const birthdaySummary = await processBirthdayRewards(options);
    const specialDateRewards = await processSpecialDateRewards(options);

    return Response.json({
      success: true,
      ...birthdaySummary,
      specialDateRewards,
    });
  } catch (error) {
    logError("birthday-rewards:route", error);
    return Response.json(
      { success: false, message: "Could not process annual rewards" },
      { status: 500 },
    );
  }
}

export const loader = async ({ request }) => run(request);
export const action = async ({ request }) => run(request);
