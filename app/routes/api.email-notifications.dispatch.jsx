/* global process */
import { dispatchPendingEmailNotifications } from "../services/email-dispatcher.server";
import { logError } from "../services/errors.server";

function getBearerToken(request) {
  const authorization = request.headers.get("authorization") || "";

  return authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : request.headers.get("x-email-dispatch-secret") || "";
}

function isAuthorized(request) {
  const configuredSecret = process.env.EMAIL_DISPATCH_SECRET;

  return Boolean(
    configuredSecret && getBearerToken(request) === configuredSecret,
  );
}

async function runDispatch(request) {
  if (!process.env.EMAIL_DISPATCH_SECRET) {
    return Response.json(
      {
        success: false,
        message: "EMAIL_DISPATCH_SECRET is not configured",
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

    const summary = await dispatchPendingEmailNotifications({
      limit: input.limit || url.searchParams.get("limit") || undefined,
    });

    return Response.json({ success: true, ...summary });
  } catch (error) {
    logError("email-dispatcher:route", error);

    return Response.json(
      { success: false, message: "Could not dispatch email notifications" },
      { status: 500 },
    );
  }
}

export const loader = async ({ request }) => runDispatch(request);
export const action = async ({ request }) => runDispatch(request);
