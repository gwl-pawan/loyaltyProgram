import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import {
  ensureOrderWebhookSubscriptions,
  getPublicRequestOrigin,
} from "../services/webhook-subscriptions.server";
import { logError } from "../services/errors.server";
import { ensurePlanAwareLoyaltySetup } from "../services/loyalty-installation.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const origin = getPublicRequestOrigin(request);

  try {
    await ensureOrderWebhookSubscriptions(admin, origin);
  } catch (error) {
    logError("app:webhook-subscriptions", error, {
      shop: session.shop,
      origin,
    });
  }

  try {
    const setup = await ensurePlanAwareLoyaltySetup(session.shop, admin);

    if (setup.planSyncError) {
      logError("app:shop-plan-sync", setup.planSyncError, {
        shop: session.shop,
      });
    }
  } catch (error) {
    logError("app:loyalty-setup", error, {
      shop: session.shop,
    });
  }

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/customers">Customers</s-link>
        <s-link href="/app/history">History</s-link>
        <s-link href="/app/referrals">Referrals</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
