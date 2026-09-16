import { useLoaderData } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { runShopifyGraphql } from "../services/errors.server";

const activityLabels = {
  discount_created: "Discount created",
  discount_applied: "Discount applied",
  discount_expired: "Discount expired",
  discount_failed: "Discount failed",
  gift_card_created: "Gift card created",
  gift_card_applied: "Gift card applied",
  gift_card_failed: "Gift card failed",
  store_credit_created: "Store credit added",
  store_credit_failed: "Store credit failed",
  points_refunded: "Points refunded",
  points_expired: "Points expired",
};

const statusTone = {
  discount_created: "info",
  discount_applied: "success",
  discount_expired: "warning",
  discount_failed: "critical",
  gift_card_created: "info",
  gift_card_applied: "success",
  gift_card_failed: "critical",
  store_credit_created: "success",
  store_credit_failed: "critical",
  points_refunded: "success",
  points_expired: "warning",
};

const emptyTotals = {
  all: 0,
  created: 0,
  applied: 0,
  expired: 0,
  failed: 0,
  giftCardCreated: 0,
  giftCardApplied: 0,
  giftCardFailed: 0,
  storeCreditCreated: 0,
  storeCreditFailed: 0,
  refunded: 0,
  pointsExpired: 0,
};

function getActivityLabel(activityType) {
  return activityLabels[activityType] || activityType || "Activity";
}

function getRewardType(item) {
  if (["points_refunded", "points_expired"].includes(item.activityType)) {
    return "points";
  }

  return (
    item.reward?.rewardType ||
    getMetadataValue(item.metadata, "rewardType") ||
    (item.activityType?.startsWith("store_credit")
      ? "store_credit"
      : item.activityType?.startsWith("gift_card")
        ? "gift_card"
        : "discount")
  );
}

function getRewardTypeLabel(item) {
  const rewardType = getRewardType(item);

  if (rewardType === "store_credit") return "Store credit";
  if (rewardType === "gift_card") return "Gift card";
  if (rewardType === "points") return "Points";
  return "Discount";
}

function getRewardTypeClass(item) {
  return getRewardType(item).replace("_", "-");
}

function getMetadataValue(metadata, key) {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  return metadata[key] ?? null;
}

function getOrderNumericId(orderId) {
  const value = String(orderId || "");
  const match = value.match(/\/Order\/(\d+)/);

  if (match?.[1]) {
    return match[1];
  }

  return /^\d+$/.test(value) ? value : "";
}

function getOrderAdminUrl(shopDomain, orderId) {
  const numericId = getOrderNumericId(orderId);

  if (!shopDomain || !numericId) {
    return "";
  }

  return `https://${shopDomain}/admin/orders/${numericId}`;
}

async function runAdminGraphql(admin, query, variables) {
  return runShopifyGraphql(admin, query, {
    variables,
    operation: "Load Shopify order names",
  });
}

function getOrderIdFromLog(item) {
  if (!["discount_applied", "gift_card_applied"].includes(item.activityType)) {
    return null;
  }

  return (
    getMetadataValue(item.metadata, "orderId") || item.reward?.orderId || null
  );
}

async function loadOrderNameById(admin, orderIds) {
  const graphIds = Array.from(
    new Set(
      orderIds
        .map((orderId) => String(orderId || ""))
        .filter((orderId) => orderId.startsWith("gid://shopify/Order/")),
    ),
  );

  if (graphIds.length === 0) {
    return {};
  }

  const data = await runAdminGraphql(
    admin,
    `#graphql
      query LoyaltyOrderNames($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Order {
            id
            name
          }
        }
      }
    `,
    {
      ids: graphIds,
    },
  );

  return (data.nodes || []).reduce((names, order) => {
    if (order?.id && order?.name) {
      names[order.id] = order.name;
    }

    return names;
  }, {});
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  let currencyCode = "USD";

  try {
    const currencyData = await runShopifyGraphql(
      admin,
      `#graphql
        query LoyaltyHistoryShopCurrency {
          shop {
            currencyCode
          }
        }
      `,
      { operation: "Load loyalty history shop currency" },
    );
    currencyCode = currencyData.shop?.currencyCode || currencyCode;
  } catch (error) {
    console.error("[history] Could not load shop currency", error);
  }

  const shop = await prisma.shop.findUnique({
    where: {
      shopDomain: session.shop,
    },
  });

  if (!shop) {
    return Response.json({
      history: [],
      currencyCode,
      totals: emptyTotals,
    });
  }

  if (!prisma.rewardActivityLog) {
    return Response.json({
      history: [],
      currencyCode,
      totals: emptyTotals,
      setupMessage:
        "Reward history is being prepared. Restart the app server after Prisma generate completes.",
    });
  }

  let history = [];

  try {
    history = await prisma.rewardActivityLog.findMany({
      where: {
        OR: [
          {
            customer: {
              shopId: shop.id,
            },
          },
          {
            reward: {
              customer: {
                shopId: shop.id,
              },
            },
          },
        ],
      },
      include: {
        customer: true,
        reward: {
          include: {
            customer: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 250,
    });
  } catch (error) {
    console.error("[history] Could not load reward activity logs", error);

    return Response.json({
      history: [],
      totals: emptyTotals,
      setupMessage:
        "Reward history database tables are not ready yet. Run Prisma migrations and refresh this page.",
    });
  }

  const totals = history.reduce(
    (counts, item) => {
      counts.all += 1;

      if (item.activityType === "discount_created") counts.created += 1;
      if (item.activityType === "discount_applied") counts.applied += 1;
      if (item.activityType === "discount_expired") counts.expired += 1;
      if (item.activityType === "discount_failed") counts.failed += 1;
      if (item.activityType === "gift_card_created")
        counts.giftCardCreated += 1;
      if (item.activityType === "gift_card_applied")
        counts.giftCardApplied += 1;
      if (item.activityType === "gift_card_failed") counts.giftCardFailed += 1;
      if (item.activityType === "store_credit_created") {
        counts.storeCreditCreated += 1;
      }
      if (item.activityType === "store_credit_failed") {
        counts.storeCreditFailed += 1;
      }
      if (item.activityType === "points_refunded") counts.refunded += 1;
      if (item.activityType === "points_expired") counts.pointsExpired += 1;

      return counts;
    },
    {
      all: 0,
      created: 0,
      applied: 0,
      expired: 0,
      failed: 0,
      giftCardCreated: 0,
      giftCardApplied: 0,
      giftCardFailed: 0,
      storeCreditCreated: 0,
      storeCreditFailed: 0,
      refunded: 0,
      pointsExpired: 0,
    },
  );

  let orderNameById = {};

  try {
    orderNameById = await loadOrderNameById(
      admin,
      history.map((item) => getOrderIdFromLog(item)),
    );
  } catch (error) {
    console.error("[history] Could not load Shopify order names", error);
  }

  return Response.json({
    currencyCode,
    history,
    orderNameById,
    shopDomain: session.shop,
    totals,
  });
};

export default function HistoryPage() {
  const {
    currencyCode = "USD",
    history = [],
    orderNameById = {},
    shopDomain,
    totals,
    setupMessage,
  } = useLoaderData();
  const numberFormatter = new Intl.NumberFormat("en");
  const currencyFormatter = new Intl.NumberFormat("en", {
    style: "currency",
    currency: currencyCode,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

  const metrics = [
    ["All activity", totals.all],
    ["Discounts created", totals.created],
    ["Discounts applied", totals.applied],
    ["Discounts expired", totals.expired],
    ["Discounts failed", totals.failed],
    ["Gift cards created", totals.giftCardCreated],
    ["Gift cards applied", totals.giftCardApplied],
    ["Gift card failures", totals.giftCardFailed],
    ["Store credit added", totals.storeCreditCreated],
    ["Store credit failures", totals.storeCreditFailed],
    ["Points refunded", totals.refunded],
    ["Points expired", totals.pointsExpired],
  ];

  return (
    <s-page heading="Reward history" inlineSize="large">
      <style>{historyStyles}</style>

      <div className="history-layout">
        <section className="metrics" aria-label="History totals">
          {metrics.map(([label, value]) => (
            <div className="metric" key={label}>
              <span>{label}</span>
              <strong>{numberFormatter.format(value)}</strong>
            </div>
          ))}
        </section>

        <section className="history-panel" aria-labelledby="activity-heading">
          <div className="panel-header">
            <div>
              <h2 id="activity-heading">Reward activity</h2>
              <p>
                Latest {numberFormatter.format(history.length)} history logs
              </p>
            </div>
          </div>

          {setupMessage ? (
            <div className="setup-notice">
              <strong>History setup needed</strong>
              <p>{setupMessage}</p>
            </div>
          ) : null}

          {history.length > 0 ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Activity</th>
                    <th>Customer</th>
                    <th>Reward code</th>
                    <th className="numeric">Points</th>
                    <th className="numeric">Amount</th>
                    <th className="numeric">Balance after</th>
                    <th>Order</th>
                    <th>Message</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((item) => {
                    const customer = item.customer || item.reward?.customer;
                    const rewardCode =
                      getRewardType(item) === "store_credit"
                        ? null
                        : item.rewardCode || item.reward?.rewardCode;
                    const points =
                      item.reward?.pointsUsed ||
                      getMetadataValue(item.metadata, "pointsUsed") ||
                      getMetadataValue(item.metadata, "pointsRefunded") ||
                      getMetadataValue(item.metadata, "pointsExpired") ||
                      getMetadataValue(item.metadata, "pointsToRedeem");
                    const discountAmount =
                      item.reward?.discountAmount ||
                      getMetadataValue(item.metadata, "discountAmount") ||
                      getMetadataValue(item.metadata, "amount");
                    const balanceAfterTransaction = getMetadataValue(
                      item.metadata,
                      "balanceAfterTransaction",
                    );
                    const orderId = getOrderIdFromLog(item);
                    const orderName =
                      getMetadataValue(item.metadata, "orderName") ||
                      orderNameById[orderId] ||
                      orderId;
                    const orderAdminUrl =
                      getMetadataValue(item.metadata, "orderAdminUrl") ||
                      getOrderAdminUrl(shopDomain, orderId);

                    return (
                      <tr key={item.id}>
                        <td>
                          <div className="activity-badges">
                            <span
                              className={`activity-pill ${
                                statusTone[item.activityType] || "neutral"
                              }`}
                            >
                              {getActivityLabel(item.activityType)}
                            </span>
                            <span
                              className={`reward-type-pill ${getRewardTypeClass(item)}`}
                            >
                              {getRewardTypeLabel(item)}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div className="customer">
                            <strong>
                              {customer?.name || "Unknown customer"}
                            </strong>
                            <span>{customer?.email || "No email"}</span>
                          </div>
                        </td>
                        <td>
                          <span className="code">{rewardCode || "-"}</span>
                        </td>
                        <td className="numeric">
                          {points ? numberFormatter.format(points) : "-"}
                        </td>
                        <td className="numeric">
                          {discountAmount
                            ? currencyFormatter.format(discountAmount)
                            : "-"}
                        </td>
                        <td className="numeric">
                          {balanceAfterTransaction !== null
                            ? currencyFormatter.format(balanceAfterTransaction)
                            : "-"}
                        </td>
                        <td>
                          {orderName && orderAdminUrl ? (
                            <a
                              className="order-link"
                              href={orderAdminUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {orderName}
                            </a>
                          ) : (
                            <span className="order">{orderName || "-"}</span>
                          )}
                        </td>
                        <td className="message">{item.message || "-"}</td>
                        <td>{new Date(item.createdAt).toLocaleString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">
              <h3>No reward history yet</h3>
              <p>
                Reward creation, application, expiry, failure, gift card logs,
                and refund events will appear here.
              </p>
            </div>
          )}
        </section>
      </div>
    </s-page>
  );
}

const historyStyles = `
  .history-layout {
    display: grid;
    gap: 16px;
    padding-block-end: 24px;
  }

  .metrics {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 12px;
  }

  .metric,
  .history-panel {
    background: #ffffff;
    border: 1px solid #dcdfe4;
    border-radius: 8px;
    box-shadow: 0 1px 0 rgba(0, 0, 0, 0.04);
  }

  .metric {
    padding: 14px;
  }

  .metric span {
    display: block;
    color: #616a75;
    font-size: 12px;
    line-height: 16px;
  }

  .metric strong {
    display: block;
    margin-block-start: 4px;
    color: #202223;
    font-size: 22px;
    line-height: 28px;
    font-weight: 650;
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    padding: 20px;
    border-bottom: 1px solid #e3e5e7;
  }

  .panel-header h2,
  .empty-state h3 {
    margin: 0;
    color: #202223;
    font-size: 18px;
    line-height: 24px;
    font-weight: 650;
  }

  .panel-header p,
  .empty-state p {
    margin: 4px 0 0;
    color: #616a75;
    font-size: 13px;
    line-height: 20px;
  }

  .table-scroll {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    min-width: 1120px;
  }

  th,
  td {
    padding: 12px 14px;
    border-bottom: 1px solid #eceff1;
    text-align: left;
    vertical-align: top;
    color: #202223;
    font-size: 13px;
    line-height: 20px;
  }

  th {
    background: #f6f7f8;
    color: #616a75;
    font-size: 12px;
    line-height: 16px;
    font-weight: 650;
    text-transform: uppercase;
  }

  .numeric {
    text-align: right;
    white-space: nowrap;
  }

  .activity-pill {
    display: inline-flex;
    align-items: center;
    width: max-content;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 12px;
    line-height: 16px;
    font-weight: 650;
  }

  .activity-pill.info {
    background: #e0f0ff;
    color: #00527c;
  }

  .activity-pill.success {
    background: #d1f7e6;
    color: #0c5132;
  }

  .activity-pill.warning {
    background: #fff1b8;
    color: #5c4100;
  }

  .activity-pill.critical {
    background: #fed3d1;
    color: #8e1f0b;
  }

  .activity-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  .reward-type-pill {
    display: inline-flex;
    align-items: center;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 11px;
    line-height: 16px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }

  .reward-type-pill.discount {
    background: #eef4ff;
    color: #1d4ed8;
  }

  .reward-type-pill.gift-card {
    background: #f7f5ff;
    color: #6b21a8;
  }

  .reward-type-pill.store-credit {
    background: #ecfdf3;
    color: #067647;
  }

  .activity-pill.neutral {
    background: #ebeef0;
    color: #4a4f55;
  }

  .customer strong,
  .customer span {
    display: block;
  }

  .customer span,
  .message,
  .order {
    color: #616a75;
  }

  .order-link {
    color: #005bd3;
    font-weight: 550;
    text-decoration: none;
    white-space: nowrap;
  }

  .order-link:hover {
    text-decoration: underline;
  }

  .code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    font-size: 12px;
    white-space: nowrap;
  }

  .message {
    max-width: 280px;
  }

  .empty-state {
    padding: 32px 20px;
  }

  .setup-notice {
    margin: 16px 20px 0;
    padding: 12px 14px;
    border: 1px solid #ffd79d;
    border-radius: 8px;
    background: #fff8e6;
    color: #5c4100;
  }

  .setup-notice strong {
    display: block;
    font-size: 13px;
    line-height: 20px;
    font-weight: 650;
  }

  .setup-notice p {
    margin: 2px 0 0;
    font-size: 13px;
    line-height: 20px;
  }

  @media (max-width: 900px) {
    .metrics {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
`;
