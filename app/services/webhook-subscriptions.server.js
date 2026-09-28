import { runShopifyGraphql } from "./errors.server";

const ORDER_WEBHOOKS = [
  {
    topic: "ORDERS_PAID",
    path: "/webhooks/orders/paid",
  },
];

function getHttpCallbackUrl(endpoint) {
  if (!endpoint || endpoint.__typename !== "WebhookHttpEndpoint") {
    return null;
  }

  return endpoint.callbackUrl || null;
}

export function getPublicRequestOrigin(request) {
  const url = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const host = forwardedHost || request.headers.get("host") || url.host;
  let protocol = forwardedProto || url.protocol.replace(":", "");

  if (host.endsWith(".trycloudflare.com")) {
    protocol = "https";
  }

  return `${protocol}://${host}`;
}

function normalizeWebhookOrigin(origin) {
  const url = new URL(origin);

  if (url.hostname.endsWith(".trycloudflare.com")) {
    url.protocol = "https:";
  }

  return url.origin;
}

async function runGraphql(admin, query, variables = {}) {
  return runShopifyGraphql(admin, query, {
    variables,
    operation: "Manage Shopify webhook subscriptions",
  });
}

export async function ensureOrderWebhookSubscriptions(admin, origin) {
  const webhookOrigin = normalizeWebhookOrigin(origin);
  const expectedWebhooks = ORDER_WEBHOOKS.map((webhook) => ({
    ...webhook,
    callbackUrl: `${webhookOrigin}${webhook.path}`,
  }));

  const data = await runGraphql(
    admin,
    `#graphql
      query GetWebhookSubscriptions {
        webhookSubscriptions(first: 100) {
          edges {
            node {
              id
              topic
              endpoint {
                __typename
                ... on WebhookHttpEndpoint {
                  callbackUrl
                }
              }
            }
          }
        }
      }
    `,
  );

  const subscriptions = (data.webhookSubscriptions?.edges || []).map(({ node }) => ({
    id: node.id,
    topic: node.topic,
    callbackUrl: getHttpCallbackUrl(node.endpoint),
  }));

  const results = [];

  for (const webhook of expectedWebhooks) {
    const existing = subscriptions.find(
      (subscription) => subscription.topic === webhook.topic,
    );

    if (!existing) {
      results.push(await createWebhookSubscription(admin, webhook));
      continue;
    }

    if (existing.callbackUrl !== webhook.callbackUrl) {
      results.push(
        await updateWebhookSubscription(admin, existing.id, webhook, existing),
      );
      continue;
    }

    results.push({
      status: "ok",
      topic: webhook.topic,
      callbackUrl: webhook.callbackUrl,
      id: existing.id,
    });
  }

  return results;
}

async function createWebhookSubscription(admin, webhook) {
  const data = await runGraphql(
    admin,
    `#graphql
      mutation CreateWebhookSubscription(
        $topic: WebhookSubscriptionTopic!
        $webhookSubscription: WebhookSubscriptionInput!
      ) {
        webhookSubscriptionCreate(
          topic: $topic
          webhookSubscription: $webhookSubscription
        ) {
          webhookSubscription {
            id
            topic
            endpoint {
              __typename
              ... on WebhookHttpEndpoint {
                callbackUrl
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      topic: webhook.topic,
      webhookSubscription: {
        callbackUrl: webhook.callbackUrl,
        format: "JSON",
      },
    },
  );

  const result = data.webhookSubscriptionCreate;

  if (result.userErrors?.length) {
    return {
      status: "create_failed",
      topic: webhook.topic,
      callbackUrl: webhook.callbackUrl,
      userErrors: result.userErrors,
    };
  }

  return {
    status: "created",
    topic: webhook.topic,
    callbackUrl: webhook.callbackUrl,
    id: result.webhookSubscription?.id,
  };
}

async function updateWebhookSubscription(admin, id, webhook, existing) {
  const data = await runGraphql(
    admin,
    `#graphql
      mutation UpdateWebhookSubscription(
        $id: ID!
        $webhookSubscription: WebhookSubscriptionInput!
      ) {
        webhookSubscriptionUpdate(
          id: $id
          webhookSubscription: $webhookSubscription
        ) {
          webhookSubscription {
            id
            topic
            endpoint {
              __typename
              ... on WebhookHttpEndpoint {
                callbackUrl
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      id,
      webhookSubscription: {
        callbackUrl: webhook.callbackUrl,
        format: "JSON",
      },
    },
  );

  const result = data.webhookSubscriptionUpdate;

  if (result.userErrors?.length) {
    return {
      status: "update_failed",
      topic: webhook.topic,
      previousCallbackUrl: existing.callbackUrl,
      callbackUrl: webhook.callbackUrl,
      id,
      userErrors: result.userErrors,
    };
  }

  return {
    status: "updated",
    topic: webhook.topic,
    previousCallbackUrl: existing.callbackUrl,
    callbackUrl: webhook.callbackUrl,
    id,
  };
}
