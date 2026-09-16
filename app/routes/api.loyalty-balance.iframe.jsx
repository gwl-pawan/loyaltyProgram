import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import {
  DEFAULT_LOYALTY_SETTINGS,
  filterRewardsByRuleContext,
  getRewardOptionsForPreference,
  getStoreCreditRewardOption,
  getRewardTypePreferenceFromSettings,
} from "../services/loyalty-settings.server";
import { isRewardsRedemptionEnabled } from "../services/shop-plan.server";
import { logError, runShopifyGraphql } from "../services/errors.server";
import { normalizeCheckoutReward } from "../services/checkout-reward";
import { getCustomerStoreCreditSnapshot } from "../services/store-credit.server";
import { tryExpireCustomerPoints } from "../services/points-expiry.server";

const DEFAULT_IFRAME_COPY = {
  launcherLabel: "Rewards",
  eyebrow: "Rewards",
  heading: "Your loyalty points",
  loadingMessage: "Loading your points...",
  loggedOutMessage: "Sign in to view and use your loyalty points.",
  loginLabel: "Sign in",
  pointsTemplate: "You have {points} points.",
  rewardsHeading: "Available rewards",
  noRewardsMessage: "Keep earning points to unlock rewards.",
  redeemButtonText: "Redeem",
  historyHeading: "Reward history",
  noHistoryMessage: "No reward history yet.",
};
const ACCOUNT_HISTORY_PAGE_SIZE = 8;
const PENDING_REDEMPTION_MESSAGE =
  "A loyalty reward is already applied to this order.";
const ORDER_APPLIED_ACTIVITY_TYPES = new Set([
  "discount_applied",
  "gift_card_applied",
]);

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function normalizeShopDomain(shop) {
  if (!shop) {
    return null;
  }

  try {
    return new URL(shop).hostname;
  } catch {
    return String(shop).trim() || null;
  }
}

function getShopifyCustomerId(customerId) {
  if (!customerId) {
    return null;
  }

  return String(customerId).split("/").pop();
}

function parseJsonParam(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getRewardRuleContextFromUrl(url) {
  return {
    cartSubtotal: Number(url.searchParams.get("cartSubtotal") || 0),
    lines: parseJsonParam(url.searchParams.get("cartLines"), []),
    productIds: parseJsonParam(url.searchParams.get("productIds"), []),
    collectionIds: parseJsonParam(url.searchParams.get("collectionIds"), []),
  };
}

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function normalizeCurrencyCode(value) {
  const currencyCode = String(value || "")
    .trim()
    .toUpperCase();
  return /^[A-Z]{3}$/.test(currencyCode) ? currencyCode : null;
}

function sanitizeColor(value, fallback = "#008060") {
  const color = String(value || "").trim();

  if (/^#[0-9a-f]{3,8}$/i.test(color)) {
    return color;
  }

  if (/^[0-9a-f]{3,8}$/i.test(color)) {
    return `#${color}`;
  }

  return fallback;
}

function sanitizeFontFamily(value) {
  const fontFamilies = {
    arial: 'Arial, "Helvetica Neue", sans-serif',
    georgia: 'Georgia, "Times New Roman", serif',
    inter:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    lato: "Lato, ui-sans-serif, system-ui, sans-serif",
    merriweather: 'Merriweather, Georgia, "Times New Roman", serif',
    mono: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace',
    montserrat: "Montserrat, ui-sans-serif, system-ui, sans-serif",
    nunito: "Nunito, ui-sans-serif, system-ui, sans-serif",
    open_sans: '"Open Sans", ui-sans-serif, system-ui, sans-serif',
    oswald: "Oswald, ui-sans-serif, system-ui, sans-serif",
    playfair_display: '"Playfair Display", Georgia, "Times New Roman", serif',
    poppins: "Poppins, ui-sans-serif, system-ui, sans-serif",
    raleway: "Raleway, ui-sans-serif, system-ui, sans-serif",
    roboto: "Roboto, ui-sans-serif, system-ui, sans-serif",
    source_sans_3: '"Source Sans 3", ui-sans-serif, system-ui, sans-serif',
    system:
      'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  };
  const fontKey = String(value || "")
    .trim()
    .toLowerCase();

  return fontFamilies[fontKey] || fontFamilies.system;
}

function getGoogleFontStylesheet(value) {
  const fontStylesheets = {
    inter:
      "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
    lato: "https://fonts.googleapis.com/css2?family=Lato:wght@400;700&display=swap",
    merriweather:
      "https://fonts.googleapis.com/css2?family=Merriweather:wght@400;700&display=swap",
    montserrat:
      "https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700&display=swap",
    nunito:
      "https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700&display=swap",
    open_sans:
      "https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;600;700&display=swap",
    oswald:
      "https://fonts.googleapis.com/css2?family=Oswald:wght@400;600;700&display=swap",
    playfair_display:
      "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&display=swap",
    poppins:
      "https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap",
    raleway:
      "https://fonts.googleapis.com/css2?family=Raleway:wght@400;600;700&display=swap",
    roboto:
      "https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap",
    source_sans_3:
      "https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;600;700&display=swap",
  };

  return (
    fontStylesheets[
      String(value || "")
        .trim()
        .toLowerCase()
    ] || ""
  );
}

function buildFontAssets(fontFamily) {
  const fontKey = String(fontFamily || "")
    .trim()
    .toLowerCase();

  return {
    stylesheetUrl: getGoogleFontStylesheet(fontKey),
  };
}

function sanitizeFontSize(value) {
  const fontSize = Number(value);

  if (Number.isInteger(fontSize) && fontSize >= 12 && fontSize <= 20) {
    return fontSize;
  }

  return 14;
}

function sanitizeCustomCss(value) {
  return String(value || "")
    .replace(/<\/style/gi, "<\\/style")
    .slice(0, 20000);
}

function getParam(url, key, fallback) {
  return url.searchParams.get(key) || fallback;
}

function getSettingValue(settings, fieldName, fallback) {
  return (
    settings?.[fieldName] || DEFAULT_LOYALTY_SETTINGS[fieldName] || fallback
  );
}

function buildIframeCopy(url, settings) {
  return {
    launcherLabel: getParam(
      url,
      "launcherLabel",
      DEFAULT_IFRAME_COPY.launcherLabel,
    ),
    eyebrow: getParam(
      url,
      "eyebrow",
      getSettingValue(settings, "iframeEyebrow", DEFAULT_IFRAME_COPY.eyebrow),
    ),
    heading: getParam(
      url,
      "heading",
      getSettingValue(settings, "iframeHeading", DEFAULT_IFRAME_COPY.heading),
    ),
    loadingMessage: getParam(
      url,
      "loadingMessage",
      DEFAULT_IFRAME_COPY.loadingMessage,
    ),
    loggedOutMessage: getParam(
      url,
      "loggedOutMessage",
      getSettingValue(
        settings,
        "iframeLoggedOutMessage",
        DEFAULT_IFRAME_COPY.loggedOutMessage,
      ),
    ),
    loginLabel: getParam(
      url,
      "loginLabel",
      getSettingValue(
        settings,
        "iframeLoginLabel",
        DEFAULT_IFRAME_COPY.loginLabel,
      ),
    ),
    pointsTemplate: getParam(
      url,
      "pointsTemplate",
      getSettingValue(
        settings,
        "iframePointsTemplate",
        DEFAULT_IFRAME_COPY.pointsTemplate,
      ),
    ),
    rewardsHeading: getParam(
      url,
      "rewardsHeading",
      getSettingValue(
        settings,
        "iframeRewardsHeading",
        DEFAULT_IFRAME_COPY.rewardsHeading,
      ),
    ),
    noRewardsMessage: getParam(
      url,
      "noRewardsMessage",
      getSettingValue(
        settings,
        "iframeNoRewardsMessage",
        DEFAULT_IFRAME_COPY.noRewardsMessage,
      ),
    ),
    redeemButtonText: getParam(
      url,
      "redeemButtonText",
      getSettingValue(
        settings,
        "iframeRedeemButtonText",
        DEFAULT_IFRAME_COPY.redeemButtonText,
      ),
    ),
    historyHeading: getParam(
      url,
      "historyHeading",
      DEFAULT_IFRAME_COPY.historyHeading,
    ),
    noHistoryMessage: getParam(
      url,
      "noHistoryMessage",
      DEFAULT_IFRAME_COPY.noHistoryMessage,
    ),
  };
}

function buildIframeTheme(url, settings) {
  return {
    accentColor: sanitizeColor(
      url.searchParams.get("accentColor"),
      sanitizeColor(settings?.iframeAccentColor, "#008060"),
    ),
    backgroundColor: sanitizeColor(
      url.searchParams.get("backgroundColor"),
      sanitizeColor(settings?.iframeBackgroundColor, "#ffffff"),
    ),
    foregroundColor: sanitizeColor(
      url.searchParams.get("foregroundColor"),
      sanitizeColor(settings?.iframeForegroundColor, "#202223"),
    ),
    borderColor: sanitizeColor(
      url.searchParams.get("borderColor"),
      sanitizeColor(settings?.iframeBorderColor, "#e3e5e8"),
    ),
    fontFamily: sanitizeFontFamily(settings?.iframeFontFamily),
    fontAssets: buildFontAssets(settings?.iframeFontFamily),
    fontSize: sanitizeFontSize(settings?.iframeFontSize),
    customCss: sanitizeCustomCss(settings?.iframeCustomCss),
  };
}

function renderFontAssets(theme) {
  const stylesheetUrl = theme?.fontAssets?.stylesheetUrl || "";

  return stylesheetUrl
    ? `<link rel="stylesheet" href="${escapeAttr(stylesheetUrl)}" />`
    : "";
}

function renderCustomCss(theme) {
  return theme?.customCss ? `\n      ${theme.customCss}` : "";
}

async function getSavedIframeAppearance(shopId) {
  if (!shopId) {
    return {};
  }

  const rows = await prisma.$queryRaw`
    SELECT
      iframeAccentColor,
      iframeBackgroundColor,
      iframeForegroundColor,
      iframeBorderColor,
      iframeFontFamily,
      iframeFontSize,
      iframeCustomCss
    FROM LoyaltySetting
    WHERE shopId = ${shopId}
    LIMIT 1
  `;

  return rows?.[0] || {};
}

function formatNumber(value) {
  return new Intl.NumberFormat("en").format(Number(value) || 0);
}

function getMetadataValue(metadata, key) {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  return metadata[key] ?? null;
}

function getActivityLabel(activityType) {
  const labels = {
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

  return labels[activityType] || activityType || "Activity";
}

function getRewardTypeLabel(activityType) {
  if (activityType?.startsWith("gift_card")) {
    return "Gift card";
  }

  if (activityType?.startsWith("store_credit")) {
    return "Store credit";
  }

  if (["points_refunded", "points_expired"].includes(activityType)) {
    return "Points";
  }

  return "Discount";
}

function formatCurrency(value, currencyCode = "USD") {
  const amount = Number(value || 0);

  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: currencyCode,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currencyCode} ${amount.toLocaleString("en")}`;
  }
}

function formatRewardTitle(reward, currencyCode) {
  if (reward.type === "store_credit") {
    return reward.title || "Store credit";
  }

  if (reward.type === "gift_card") {
    return `${formatCurrency(reward.amount, currencyCode)} Gift Card`;
  }

  return `Discount ${formatCurrency(reward.discount, currencyCode)} for ${reward.points} points`;
}

function formatRewardDescription(reward, currencyCode) {
  if (reward.description && reward.type !== "gift_card") {
    return reward.description;
  }

  if (reward.type === "store_credit") {
    return `Redeem ${formatNumber(reward.points)} points for ${formatCurrency(reward.amount, currencyCode)} store credit.`;
  }

  return reward.type === "gift_card"
    ? `Redeem ${formatNumber(reward.points)} points for a ${formatCurrency(reward.amount, currencyCode)} gift card.`
    : `Redeem ${formatNumber(reward.points)} points for a discount.`;
}

function formatRewardValue(reward, currencyCode) {
  if (reward.type === "gift_card") {
    return `${formatCurrency(reward.amount, currencyCode)} gift card`;
  }

  if (reward.type === "store_credit") {
    return `${formatCurrency(reward.amount, currencyCode)} store credit`;
  }

  return `${formatCurrency(reward.discount, currencyCode)} off`;
}

function getRewardKey(reward) {
  return `${reward.type || "discount"}:${reward.points}`;
}

function normalizeStoreCreditReward(reward) {
  const points = Number(reward?.points);
  const amount = Number(reward?.amount);

  if (
    reward?.type !== "store_credit" ||
    !Number.isInteger(points) ||
    points < 1 ||
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    return null;
  }

  return {
    ...reward,
    points,
    amount,
  };
}

function formatHistoryAmount(value, currencyCode) {
  const amount = Number(value);

  return Number.isFinite(amount) && amount !== 0
    ? formatCurrency(amount, currencyCode)
    : "-";
}

function formatPoints(value) {
  const points = Number(value);

  return Number.isFinite(points) ? `${points.toLocaleString()} points` : "-";
}

function getActivityTone(activityType) {
  if (activityType?.includes("failed")) {
    return "critical";
  }

  if (
    activityType?.includes("expired") ||
    activityType?.includes("expiration")
  ) {
    return "warning";
  }

  if (activityType?.includes("created")) {
    return "info";
  }

  if (activityType?.includes("applied") || activityType?.includes("refunded")) {
    return "success";
  }

  return "neutral";
}

function getStoreCreditTransactionLabel(type) {
  return (
    {
      credit: "Store credit added",
      debit: "Store credit used",
      debit_revert: "Store credit returned",
      expiration: "Store credit expired",
    }[type] || "Store credit updated"
  );
}

async function getShopCurrencyCode(shopDomain) {
  if (!shopDomain) {
    return "USD";
  }

  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    const data = await runShopifyGraphql(
      admin,
      `#graphql
        query IframeShopCurrency {
          shop {
            currencyCode
          }
        }
      `,
      { operation: "Load iframe shop currency" },
    );

    return data.shop?.currencyCode || "USD";
  } catch (error) {
    logError("loyalty-iframe:shop-currency", error, { shopDomain });
    return "USD";
  }
}

async function getGrantedAccessScopes(shopDomain) {
  if (!shopDomain) {
    return null;
  }

  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    const data = await runShopifyGraphql(
      admin,
      `#graphql
        query IframeAppAccessScopes {
          currentAppInstallation {
            accessScopes {
              handle
            }
          }
        }
      `,
      { operation: "Load iframe app access scopes" },
    );

    return new Set(
      (data.currentAppInstallation?.accessScopes || [])
        .map((scope) => scope.handle)
        .filter(Boolean),
    );
  } catch (error) {
    logError("loyalty-iframe:access-scopes", error, { shopDomain });
    return null;
  }
}

function filterRewardsByGrantedScopes(rewards, grantedScopes) {
  if (!grantedScopes) {
    return rewards;
  }

  return rewards.filter((reward) => {
    const type = reward.type || "discount";

    if (type === "gift_card") {
      return grantedScopes.has("write_gift_cards");
    }

    if (type === "store_credit") {
      return grantedScopes.has("write_store_credit_account_transactions");
    }

    return grantedScopes.has("write_discounts");
  });
}

function getPendingCheckoutRedemption(customerId) {
  if (!customerId) {
    return null;
  }

  return prisma.reward.findFirst({
    where: {
      customerId,
      rewardType: "discount",
      status: "pending",
      OR: [
        {
          expiresAt: null,
        },
        {
          expiresAt: {
            gt: new Date(),
          },
        },
      ],
    },
    select: {
      id: true,
    },
  });
}

async function loadWidgetData(
  shopDomain,
  customerId,
  customerEmail,
  surface,
  ruleContext,
) {
  const shop = shopDomain
    ? await prisma.shop.findUnique({
        where: {
          shopDomain,
        },
        select: {
          id: true,
          shopDomain: true,
          loyaltySetting: true,
        },
      })
    : null;
  const settings = {
    ...(shop?.loyaltySetting || DEFAULT_LOYALTY_SETTINGS),
    ...(await getSavedIframeAppearance(shop?.id)),
  };
  const storeCreditEnabled = settings.storeCreditRedemptionEnabled !== false;
  const rewardTypePreference = getRewardTypePreferenceFromSettings(
    settings.redemptionRewards,
  );
  const rewardOptions = getRewardOptionsForPreference(
    settings.redemptionRewards,
    rewardTypePreference,
  ).filter((reward) => storeCreditEnabled || reward.type !== "store_credit");
  const grantedScopes = await getGrantedAccessScopes(shopDomain);
  const scopedRewardOptions = filterRewardsByGrantedScopes(
    rewardOptions,
    grantedScopes,
  );
  const configuredStoreCreditReward = getStoreCreditRewardOption(
    settings.redemptionRewards,
  );
  const surfaceRewardOptions =
    surface === "account"
      ? storeCreditEnabled
        ? [configuredStoreCreditReward].filter(Boolean)
        : []
      : filterRewardsByRuleContext(scopedRewardOptions, ruleContext);
  const storeCreditReward =
    surface === "account" && storeCreditEnabled
      ? normalizeStoreCreditReward(configuredStoreCreditReward)
      : null;
  const shopifyCustomerId = getShopifyCustomerId(customerId);
  const email = normalizeEmail(customerEmail);
  const customer =
    (shopifyCustomerId || email) && shopDomain
      ? await prisma.customer.findFirst({
          where: {
            shop: {
              shopDomain,
            },
            OR: [
              ...(shopifyCustomerId
                ? [
                    {
                      shopifyCustomerId,
                    },
                  ]
                : []),
              ...(email
                ? [
                    {
                      email,
                    },
                  ]
                : []),
            ],
          },
          select: {
            id: true,
            loyaltyPoints: true,
          },
        })
      : null;
  const expiryResult = customer
    ? await tryExpireCustomerPoints(customer.id)
    : null;

  if (customer && expiryResult) {
    customer.loyaltyPoints = expiryResult.balance;
  }
  const rewardHistory =
    customer && surface === "account"
      ? await prisma.rewardActivityLog.findMany({
          where: {
            customerId: customer.id,
          },
          select: {
            id: true,
            activityType: true,
            message: true,
            rewardCode: true,
            createdAt: true,
            metadata: true,
            reward: {
              select: {
                pointsUsed: true,
                discountAmount: true,
                orderId: true,
              },
            },
          },
          orderBy: {
            createdAt: "desc",
          },
          ...(surface === "account" ? {} : { take: 8 }),
        })
      : [];
  const currencyCode = await getShopCurrencyCode(shopDomain);
  const storeCreditSnapshot =
    surface === "account"
      ? await getCustomerStoreCreditSnapshot({
          shopDomain,
          customerId: shopifyCustomerId,
          preferredCurrencyCode: currencyCode,
          includeTransactions: true,
          operation: "Load iframe store credit balance and history",
        })
      : null;
  const pendingCheckoutRedemption =
    surface === "floating" && customer
      ? await getPendingCheckoutRedemption(customer.id)
      : null;
  const storeCreditTransactionIds = new Set(
    (storeCreditSnapshot?.transactions || []).map((item) => item.id),
  );
  const history = [
    ...(storeCreditSnapshot?.transactions || []).map((item) => ({
      id: item.id,
      activityType: `store_credit_${item.type}`,
      label: getStoreCreditTransactionLabel(item.type),
      typeLabel: "Store credit",
      message: `Balance after transaction: ${formatCurrency(
        item.balanceAfterTransaction,
        item.currencyCode || currencyCode,
      )}`,
      rewardCode: null,
      createdAt: item.createdAt,
      orderId: null,
      orderName: null,
      pointsUsed: null,
      discountAmount: item.amount,
    })),
    ...rewardHistory
      .filter(
        (item) =>
          !item.activityType?.startsWith("store_credit") ||
          !storeCreditTransactionIds.has(item.rewardCode),
      )
      .map((item) => ({
        id: item.id,
        activityType: item.activityType,
        label: getActivityLabel(item.activityType),
        typeLabel: getRewardTypeLabel(item.activityType),
        message: item.message,
        rewardCode: item.rewardCode,
        createdAt: item.createdAt,
        orderId: ORDER_APPLIED_ACTIVITY_TYPES.has(item.activityType)
          ? getMetadataValue(item.metadata, "orderId") ||
            item.reward?.orderId ||
            null
          : null,
        orderName: ORDER_APPLIED_ACTIVITY_TYPES.has(item.activityType)
          ? getMetadataValue(item.metadata, "orderName") || null
          : null,
        pointsUsed:
          item.reward?.pointsUsed ||
          getMetadataValue(item.metadata, "pointsUsed") ||
          getMetadataValue(item.metadata, "pointsExpired"),
        discountAmount:
          item.reward?.discountAmount ||
          getMetadataValue(item.metadata, "discountAmount") ||
          getMetadataValue(item.metadata, "amount"),
      })),
  ].sort(
    (left, right) =>
      new Date(right.createdAt || 0) - new Date(left.createdAt || 0),
  );

  return {
    currencyCode,
    customer,
    hasPendingCheckoutRedemption: Boolean(pendingCheckoutRedemption),
    pendingCheckoutRedemption: normalizeCheckoutReward(
      pendingCheckoutRedemption,
    ),
    history,
    redemptionEnabled: isRewardsRedemptionEnabled(settings),
    rewardOptions: surfaceRewardOptions,
    settings,
    storeCreditBalance: storeCreditSnapshot?.balance || null,
    storeCreditReward,
  };
}

function renderRewardList(
  rewards,
  points,
  redemptionEnabled,
  copy,
  currencyCode,
) {
  if (!redemptionEnabled) {
    return `<p class="gwl-loyalty-iframe__message">Rewards redemption is currently paused.</p>`;
  }

  if (rewards.length === 0) {
    return `<p class="gwl-loyalty-iframe__message">${escapeHtml(
      copy.noRewardsMessage,
    )}</p>`;
  }

  return `
    <ul class="gwl-loyalty-iframe__reward-list">
      ${rewards
        .map((reward) => {
          const available = Number(reward.points) <= points;
          return `
            <li class="gwl-loyalty-iframe__reward">
              <button
                class="gwl-loyalty-iframe__reward-button"
                type="button"
                data-reward='${escapeAttr(JSON.stringify(reward))}'
                ${available ? "" : "disabled"}
              >
                <span class="gwl-loyalty-iframe__reward-title">${escapeHtml(
                  formatRewardTitle(reward, currencyCode),
                )}</span>
                <span class="gwl-loyalty-iframe__reward-description">${escapeHtml(
                  formatRewardDescription(reward, currencyCode),
                )}</span>
                <span class="gwl-loyalty-iframe__reward-cta">${
                  available
                    ? escapeHtml(copy.redeemButtonText)
                    : `${formatNumber(reward.points)} points required`
                }</span>
              </button>
            </li>
          `;
        })
        .join("")}
    </ul>
  `;
}

function formatHistoryDate(value) {
  if (!value) {
    return "";
  }

  try {
    return new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return String(value);
  }
}

function renderAccountHistoryRows(history, noHistoryMessage, currencyCode) {
  if (!history.length) {
    return `
      <div class="gwl-account-loyalty__empty">
        <h3>No reward history</h3>
        <p>${escapeHtml(noHistoryMessage)}</p>
      </div>
    `;
  }

  const pageCount = Math.max(
    1,
    Math.ceil(history.length / ACCOUNT_HISTORY_PAGE_SIZE),
  );

  return `
    <div class="gwl-account-loyalty__history">
      <div class="gwl-account-loyalty__history-header">
        <div>
          <h3>Reward activity</h3>
          <p>Showing all ${formatNumber(history.length)} history log${
            history.length === 1 ? "" : "s"
          }</p>
        </div>
        <span>${formatNumber(history.length)} item${
          history.length === 1 ? "" : "s"
        }</span>
      </div>
      <div class="gwl-account-loyalty__history-table-wrap">
        <table class="gwl-account-loyalty__history-table">
          <thead>
            <tr>
              <th>Activity</th>
              <th>Reward code</th>
              <th>Points</th>
              <th>Amount</th>
              <th>Order</th>
              <th>Message</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            ${history
              .map((item, index) => {
                const tone = getActivityTone(item.activityType);
                const page = Math.floor(index / ACCOUNT_HISTORY_PAGE_SIZE) + 1;

                return `
                  <tr data-account-history-row data-history-page="${escapeAttr(
                    page,
                  )}" ${page === 1 ? "" : "hidden"}>
                    <td data-label="Activity">
                      <div class="gwl-account-loyalty__activity-cell">
                        <span class="gwl-account-loyalty__badge gwl-account-loyalty__badge--${escapeAttr(
                          tone,
                        )}">${escapeHtml(item.label || "Activity")}</span>
                        <span class="gwl-account-loyalty__type-badge">${escapeHtml(
                          item.typeLabel,
                        )}</span>
                      </div>
                    </td>
                    <td data-label="Reward code"><code>${escapeHtml(
                      item.rewardCode || "-",
                    )}</code></td>
                    <td data-label="Points">${escapeHtml(
                      formatPoints(item.pointsUsed),
                    )}</td>
                    <td data-label="Amount">${escapeHtml(
                      formatHistoryAmount(item.discountAmount, currencyCode),
                    )}</td>
                    <td data-label="Order">${escapeHtml(
                      item.orderName || item.orderId || "-",
                    )}</td>
                    <td data-label="Message" class="gwl-account-loyalty__history-message">${escapeHtml(
                      item.message || "-",
                    )}</td>
                    <td data-label="Time">${escapeHtml(
                      formatHistoryDate(item.createdAt),
                    )}</td>
                  </tr>
                `;
              })
              .join("")}
          </tbody>
        </table>
      </div>
      ${
        pageCount > 1
          ? `
            <div
              class="gwl-account-loyalty__pagination"
              data-account-history-pagination
              data-current-page="1"
              data-page-count="${escapeAttr(pageCount)}"
              data-page-size="${escapeAttr(ACCOUNT_HISTORY_PAGE_SIZE)}"
              data-total-count="${escapeAttr(history.length)}"
            >
              <span data-account-history-range>Showing 1-${Math.min(
                ACCOUNT_HISTORY_PAGE_SIZE,
                history.length,
              )} of ${formatNumber(history.length)}</span>
              <div class="gwl-account-loyalty__pagination-actions">
                <button type="button" data-account-history-prev disabled>Previous</button>
                <span data-account-history-page-label>Page 1 of ${formatNumber(
                  pageCount,
                )}</span>
                <button type="button" data-account-history-next>Next</button>
              </div>
            </div>
          `
          : ""
      }
    </div>
  `;
}

function renderAccountIframeDocument({
  appCustomerId,
  copy,
  currencyCode,
  customerId,
  history,
  loginUrl,
  points,
  redeemUrl,
  redemptionEnabled,
  registerUrl,
  shopDomain,
  storeCreditBalance,
  storeCreditReward,
  theme,
}) {
  const loggedIn = Boolean(customerId);
  const pointStep = storeCreditReward?.points || 100;
  const maxPoints = storeCreditReward
    ? Math.max(pointStep, Math.floor(points / pointStep) * pointStep)
    : 0;
  const readyCreditAmount = storeCreditReward
    ? Math.floor(points / storeCreditReward.points) * storeCreditReward.amount
    : 0;
  const nextCreditPoints = storeCreditReward
    ? points % storeCreditReward.points === 0
      ? storeCreditReward.points
      : storeCreditReward.points - (points % storeCreditReward.points)
    : 0;
  const selectedCreditAmount = storeCreditReward?.amount || 0;
  const currentStoreCreditAmount = Number(storeCreditBalance?.amount || 0);
  const conversionText = storeCreditReward
    ? `${formatNumber(storeCreditReward.points)} points = ${formatCurrency(
        storeCreditReward.amount,
        currencyCode,
      )} store credit`
    : "";
  const historyMarkup = renderAccountHistoryRows(
    history,
    copy.noHistoryMessage,
    currencyCode,
  );

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Rewards wallet</title>
    ${renderFontAssets(theme)}
    <style>
      :root {
        color-scheme: light;
        --loyalty-accent-color: ${escapeHtml(theme.accentColor)};
        --loyalty-background: ${escapeHtml(theme.backgroundColor)};
        --loyalty-foreground: ${escapeHtml(theme.foregroundColor)};
        --loyalty-border: ${escapeHtml(theme.borderColor)};
        --loyalty-font-family: ${theme.fontFamily};
        --loyalty-font-size: ${escapeHtml(theme.fontSize)}px;
        --loyalty-muted: #5f6b7a;
        --loyalty-soft: rgba(0, 128, 96, 0.11);
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        background: transparent;
        color: var(--loyalty-foreground);
        font-family: var(--loyalty-font-family);
        font-size: var(--loyalty-font-size);
      }

      .gwl-account-loyalty {
        border: 1px solid var(--loyalty-border);
        border-radius: 8px;
        background: var(--loyalty-background);
        padding: 24px;
      }

      .gwl-account-loyalty__header {
        align-items: flex-start;
        display: flex;
        gap: 18px;
        justify-content: space-between;
        margin-bottom: 16px;
      }

      .gwl-account-section-heading span {
        color: var(--loyalty-accent-color);
        display: block;
        font-size: 12px;
        font-weight: 800;
        margin-bottom: 4px;
        text-transform: uppercase;
      }

      .gwl-account-section-heading h1,
      .gwl-account-section-heading h2 {
        font-size: 20px;
        line-height: 1.25;
        margin: 0;
      }

      .gwl-account-loyalty__tabs {
        border: 1px solid var(--loyalty-border);
        border-radius: 999px;
        display: grid;
        grid-template-columns: 1fr 1fr;
        min-width: 320px;
        overflow: hidden;
        padding: 5px;
      }

      .gwl-account-loyalty__tabs button {
        background: transparent;
        border: 0;
        border-radius: 6px;
        color: inherit;
        cursor: pointer;
        font: inherit;
        font-weight: 700;
        padding: 12px 18px;
      }

      .gwl-account-loyalty__tabs button.gwl-is-active {
        background: var(--loyalty-accent-color);
        color: #ffffff;
      }

      .gwl-account-loyalty__message {
        background: #ecfdf5;
        border-radius: 6px;
        color: #0c5132;
        margin: 0 0 16px;
        padding: 12px 16px;
      }

      .gwl-account-loyalty__message--error {
        background: #fff4f4;
        color: #b42318;
      }

      .gwl-account-loyalty__panel {
        border: 1px solid rgba(0, 128, 96, 0.16);
        border-radius: 8px;
        display: grid;
        grid-template-columns: minmax(280px, 0.95fr) minmax(320px, 1.8fr);
        overflow: hidden;
      }

      .gwl-account-loyalty__balance-card {
        background: linear-gradient(135deg, rgba(0, 128, 96, 0.13), rgba(0, 128, 96, 0.03));
        border-right: 1px solid rgba(0, 128, 96, 0.16);
        padding: 22px;
      }

      .gwl-account-loyalty__balance-head {
        align-items: center;
        display: flex;
        gap: 16px;
        justify-content: space-between;
      }

      .gwl-account-loyalty__balance-head span {
        background: rgba(0, 128, 96, 0.12);
        border: 1px solid rgba(0, 128, 96, 0.2);
        border-radius: 999px;
        color: #54708a;
        font-size: 12px;
        font-weight: 700;
        padding: 6px 12px;
      }

      .gwl-account-loyalty__balance-head h3,
      .gwl-account-loyalty__convert-copy h3,
      .gwl-account-loyalty__history-header h3,
      .gwl-account-loyalty__empty h3 {
        font-size: 18px;
        line-height: 1.25;
        margin: 0;
      }

      .gwl-account-loyalty__points {
        display: grid;
        gap: 6px;
        margin: 34px 0 28px;
      }

      .gwl-account-loyalty__points strong {
        color: #111827;
        font-size: 64px;
        line-height: 0.95;
      }

      .gwl-account-loyalty__points span {
        font-weight: 700;
      }

      .gwl-account-loyalty__mini-stats {
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }

      .gwl-account-loyalty__stat {
        background: rgba(255, 255, 255, 0.72);
        border: 1px solid rgba(0, 128, 96, 0.16);
        border-radius: 6px;
        display: grid;
        gap: 14px;
        min-height: 96px;
        padding: 12px;
      }

      .gwl-account-loyalty__stat--primary {
        background: rgba(0, 128, 96, 0.08);
      }

      .gwl-account-loyalty__stat span,
      .gwl-account-loyalty__convert-copy p,
      .gwl-account-loyalty__history-header p,
      .gwl-account-loyalty__empty p {
        color: var(--loyalty-muted);
        font-size: 14px;
        line-height: 20px;
        margin: 0;
      }

      .gwl-account-loyalty__stat strong {
        font-size: 17px;
      }

      .gwl-account-loyalty__convert-card {
        display: grid;
        gap: 20px;
        padding: 22px;
      }

      .gwl-account-loyalty__convert-copy {
        align-items: flex-start;
        display: flex;
        gap: 16px;
        justify-content: space-between;
      }

      .gwl-account-loyalty__credit-pill {
        background: var(--loyalty-soft);
        border-radius: 999px;
        color: var(--loyalty-accent-color);
        font-size: 13px;
        font-weight: 700;
        padding: 8px 12px;
        white-space: nowrap;
      }

      .gwl-account-loyalty__redeem-form {
        display: grid;
        gap: 12px;
      }

      .gwl-account-loyalty__redeem-form label {
        font-weight: 700;
      }

      .gwl-account-loyalty__converter {
        border: 1px solid var(--loyalty-border);
        border-radius: 8px;
        display: grid;
        grid-template-columns: 44px minmax(0, 1fr) 44px;
        overflow: hidden;
      }

      .gwl-account-loyalty__converter button,
      .gwl-account-loyalty__converter input {
        border: 0;
        color: inherit;
        font: inherit;
        min-height: 46px;
      }

      .gwl-account-loyalty__converter button {
        background: #f7faf9;
        cursor: pointer;
        font-size: 20px;
        font-weight: 800;
      }

      .gwl-account-loyalty__converter button:disabled {
        cursor: default;
        opacity: 0.45;
      }

      .gwl-account-loyalty__converter input {
        border-left: 1px solid var(--loyalty-border);
        border-right: 1px solid var(--loyalty-border);
        padding: 0 12px;
        text-align: center;
      }

      .gwl-account-loyalty__preview {
        align-items: center;
        border: 1px solid rgba(0, 128, 96, 0.18);
        border-radius: 8px;
        display: flex;
        justify-content: space-between;
        padding: 12px 14px;
      }

      .gwl-account-loyalty__preview span {
        color: var(--loyalty-muted);
      }

      .gwl-account-loyalty__submit,
      .gwl-account-loyalty__button {
        background: var(--loyalty-accent-color);
        border: 1px solid var(--loyalty-accent-color);
        border-radius: 8px;
        color: #ffffff;
        cursor: pointer;
        font: inherit;
        font-weight: 800;
        min-height: 46px;
        padding: 12px 16px;
      }

      .gwl-account-loyalty__submit:disabled {
        cursor: default;
        opacity: 0.55;
      }

      .gwl-account-loyalty__button--secondary {
        background: transparent;
        color: var(--loyalty-accent-color);
      }

      .gwl-account-loyalty__guest-actions {
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        margin-top: 16px;
      }

      .gwl-account-loyalty__guest-actions a {
        text-align: center;
        text-decoration: none;
      }

      .gwl-account-loyalty__history {
        border: 1px solid var(--loyalty-border);
        border-radius: 8px;
        overflow: hidden;
      }

      .gwl-account-loyalty__history-header {
        align-items: center;
        border-bottom: 1px solid var(--loyalty-border);
        display: flex;
        gap: 14px;
        justify-content: space-between;
        padding: 16px;
      }

      .gwl-account-loyalty__history-header > span {
        background: #f4f6f8;
        border-radius: 999px;
        color: var(--loyalty-muted);
        font-size: 13px;
        font-weight: 700;
        padding: 7px 11px;
      }

      .gwl-account-loyalty__history-table-wrap {
        overflow-x: auto;
      }

      .gwl-account-loyalty__history-table {
        border-collapse: collapse;
        font-size: 14px;
        min-width: 900px;
        width: 100%;
      }

      .gwl-account-loyalty__history-table th,
      .gwl-account-loyalty__history-table td {
        border-bottom: 1px solid var(--loyalty-border);
        padding: 12px 14px;
        text-align: left;
        vertical-align: top;
      }

      .gwl-account-loyalty__history-table th {
        color: var(--loyalty-muted);
        font-size: 12px;
        text-transform: uppercase;
      }

      .gwl-account-loyalty__activity-cell {
        display: grid;
        gap: 6px;
      }

      .gwl-account-loyalty__badge,
      .gwl-account-loyalty__type-badge {
        border-radius: 999px;
        display: inline-flex;
        font-size: 12px;
        font-weight: 800;
        justify-self: start;
        padding: 5px 9px;
      }

      .gwl-account-loyalty__badge--success { background: #e8f8ef; color: #0c5132; }
      .gwl-account-loyalty__badge--critical { background: #fff4f4; color: #b42318; }
      .gwl-account-loyalty__badge--warning { background: #fff7df; color: #7a4f01; }
      .gwl-account-loyalty__badge--info,
      .gwl-account-loyalty__badge--neutral { background: #eff6ff; color: #1d4ed8; }
      .gwl-account-loyalty__type-badge { background: #f4f6f8; color: #4b5563; }

      .gwl-account-loyalty__history-message {
        color: var(--loyalty-muted);
      }

      .gwl-account-loyalty__pagination {
        align-items: center;
        background: #ffffff;
        display: flex;
        gap: 14px;
        justify-content: space-between;
        padding: 14px 16px;
      }

      .gwl-account-loyalty__pagination > span {
        color: var(--loyalty-muted);
        font-size: 14px;
      }

      .gwl-account-loyalty__pagination-actions {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      .gwl-account-loyalty__pagination-actions button {
        background: transparent;
        border: 1px solid var(--loyalty-border);
        border-radius: 6px;
        color: inherit;
        cursor: pointer;
        font: inherit;
        font-weight: 700;
        padding: 8px 12px;
      }

      .gwl-account-loyalty__pagination-actions button:disabled {
        cursor: default;
        opacity: 0.45;
      }

      .gwl-account-loyalty__pagination-actions span {
        color: var(--loyalty-muted);
        font-size: 14px;
      }

      .gwl-account-loyalty__empty {
        border: 1px solid var(--loyalty-border);
        border-radius: 8px;
        padding: 24px;
      }

      [hidden] { display: none !important; }

      @media (max-width: 760px) {
        .gwl-account-loyalty { padding: 18px; }
        .gwl-account-loyalty__header,
        .gwl-account-loyalty__convert-copy {
          display: grid;
        }
        .gwl-account-loyalty__tabs {
          min-width: 0;
          width: 100%;
        }
        .gwl-account-loyalty__panel {
          grid-template-columns: 1fr;
        }
        .gwl-account-loyalty__balance-card {
          border-right: 0;
          border-bottom: 1px solid rgba(0, 128, 96, 0.16);
        }
        .gwl-account-loyalty__mini-stats,
        .gwl-account-loyalty__guest-actions {
          grid-template-columns: 1fr;
        }
        .gwl-account-loyalty__points strong {
          font-size: 52px;
        }
        .gwl-account-loyalty__pagination {
          align-items: flex-start;
          display: grid;
        }
      }
      ${renderCustomCss(theme)}
    </style>
  </head>
  <body>
    <main
      class="gwl-account-loyalty"
      data-shop-domain="${escapeAttr(shopDomain || "")}"
      data-customer-id="${escapeAttr(appCustomerId || customerId || "")}"
      data-redeem-url="${escapeAttr(redeemUrl)}"
      data-current-points="${escapeAttr(points)}"
      data-current-credit="${escapeAttr(currentStoreCreditAmount)}"
      data-point-step="${escapeAttr(pointStep)}"
      data-credit-amount="${escapeAttr(storeCreditReward?.amount || 0)}"
    >
      <div class="gwl-account-loyalty__header">
        <div class="gwl-account-section-heading">
          <span>Loyalty</span>
          <h1>Rewards wallet</h1>
        </div>
        ${
          loggedIn
            ? `
              <div class="gwl-account-loyalty__tabs" role="tablist" aria-label="Loyalty account sections">
                <button class="gwl-is-active" type="button" role="tab" aria-selected="true" data-account-tab="store-credit">Store credit</button>
                <button type="button" role="tab" aria-selected="false" data-account-tab="history">Reward history</button>
              </div>
            `
            : ""
        }
      </div>

      ${
        loggedIn
          ? `
            <div data-account-message></div>
            <section data-account-panel="store-credit">
              <div class="gwl-account-loyalty__panel">
                <div class="gwl-account-loyalty__balance-card">
                  <div class="gwl-account-loyalty__balance-head">
                    <span>Available points</span>
                    <h3>Loyalty balance</h3>
                  </div>
                  <p class="gwl-account-loyalty__points">
                    <strong data-account-points>${formatNumber(points)}</strong>
                    <span data-account-points-label>${points === 1 ? "point" : "points"}</span>
                  </p>
                  <div class="gwl-account-loyalty__mini-stats">
                    <div class="gwl-account-loyalty__stat gwl-account-loyalty__stat--primary">
                      <span>Ready to convert</span>
                      <strong data-account-ready-credit>${escapeHtml(
                        formatCurrency(readyCreditAmount, currencyCode),
                      )}</strong>
                    </div>
                    <div class="gwl-account-loyalty__stat">
                      <span>Current store credit</span>
                      <strong data-account-current-credit>${escapeHtml(
                        formatCurrency(currentStoreCreditAmount, currencyCode),
                      )}</strong>
                    </div>
                    ${
                      storeCreditReward
                        ? `
                          <div class="gwl-account-loyalty__stat">
                            <span>Next credit</span>
                            <strong data-account-next-credit>${formatNumber(
                              nextCreditPoints,
                            )} pts</strong>
                          </div>
                        `
                        : ""
                    }
                  </div>
                </div>
                ${
                  storeCreditReward
                    ? `
                      <div class="gwl-account-loyalty__convert-card">
                        <div class="gwl-account-loyalty__convert-copy">
                          <div>
                            <h3>${escapeHtml(
                              storeCreditReward.title || "Store Credit Reward",
                            )}</h3>
                            <p>${escapeHtml(conversionText)}</p>
                          </div>
                          <span class="gwl-account-loyalty__credit-pill">Available store credit: <span data-account-current-credit-inline>${escapeHtml(
                            formatCurrency(
                              currentStoreCreditAmount,
                              currencyCode,
                            ),
                          )}</span></span>
                        </div>
                        <form class="gwl-account-loyalty__redeem-form" data-account-store-credit-form>
                          <label for="account-loyalty-points">Points to convert</label>
                          <div class="gwl-account-loyalty__converter">
                            <button type="button" aria-label="Decrease points" data-account-adjust="-${escapeAttr(
                              pointStep,
                            )}">-</button>
                            <input
                              id="account-loyalty-points"
                              name="points"
                              type="number"
                              min="${escapeAttr(pointStep)}"
                              max="${escapeAttr(maxPoints)}"
                              step="${escapeAttr(pointStep)}"
                              value="${escapeAttr(pointStep)}"
                              data-account-points-input
                              ${redemptionEnabled ? "" : "disabled"}
                            />
                            <button type="button" aria-label="Increase points" data-account-adjust="${escapeAttr(
                              pointStep,
                            )}">+</button>
                          </div>
                          <div class="gwl-account-loyalty__preview">
                            <span>Store credit value</span>
                            <strong data-account-preview-credit>${escapeHtml(
                              formatCurrency(
                                selectedCreditAmount,
                                currencyCode,
                              ),
                            )}</strong>
                          </div>
                          <button class="gwl-account-loyalty__submit" type="submit" data-account-submit ${
                            redemptionEnabled ? "" : "disabled"
                          }>Redeem</button>
                        </form>
                        ${
                          redemptionEnabled
                            ? ""
                            : "<p>Store credit conversion is currently disabled.</p>"
                        }
                      </div>
                    `
                    : `
                      <div class="gwl-account-loyalty__convert-card">
                        <p>Store credit rewards are not configured yet.</p>
                      </div>
                    `
                }
              </div>
            </section>
            <section data-account-panel="history" hidden>
              ${historyMarkup}
            </section>
          `
          : `
            <p class="gwl-account-loyalty__message gwl-account-loyalty__message--error">${escapeHtml(
              copy.loggedOutMessage,
            )}</p>
            <div class="gwl-account-loyalty__guest-actions">
              <a class="gwl-account-loyalty__button" href="${escapeAttr(
                registerUrl,
              )}" target="_top">Join</a>
              <a class="gwl-account-loyalty__button gwl-account-loyalty__button--secondary" href="${escapeAttr(
                loginUrl,
              )}" target="_top">${escapeHtml(copy.loginLabel)}</a>
            </div>
          `
      }
    </main>
    <script>
      (() => {
        const widget = document.querySelector(".gwl-account-loyalty");
        if (!widget) return;

        function escapeText(value) {
          return String(value || "").replace(/[&<>"']/g, (char) => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
          })[char]);
        }

        function formatNumber(value) {
          return new Intl.NumberFormat("en").format(Number(value) || 0);
        }

        function formatMoney(value) {
          const amount = Number(value);
          try {
            return new Intl.NumberFormat("en", {
              style: "currency",
              currency: ${JSON.stringify(currencyCode)},
              currencyDisplay: "narrowSymbol",
              minimumFractionDigits: 0,
              maximumFractionDigits: 2
            }).format(Number.isFinite(amount) ? amount : 0);
          } catch {
            return ${JSON.stringify(currencyCode)} + " " +
              (Number.isFinite(amount) ? amount.toLocaleString("en") : "0");
          }
        }

        function setNotice(message, isError) {
          const container = widget.querySelector("[data-account-message]");
          if (!container) return;
          if (!message) {
            container.innerHTML = "";
            return;
          }
          container.innerHTML =
            '<p class="gwl-account-loyalty__message ' +
            (isError ? 'gwl-account-loyalty__message--error' : '') +
            '">' +
            escapeText(message) +
            '</p>';
        }

        async function readJsonResponse(response, fallbackMessage) {
          const text = await response.text();
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            throw new Error(fallbackMessage);
          }

          if (!response.ok || !data || typeof data !== "object") {
            throw new Error(data && data.message ? data.message : fallbackMessage);
          }

          return data;
        }

        function currentPoints() {
          return Number(widget.dataset.currentPoints || 0);
        }

        function currentCredit() {
          return Number(widget.dataset.currentCredit || 0);
        }

        function pointStep() {
          return Number(widget.dataset.pointStep || 100);
        }

        function creditAmount() {
          return Number(widget.dataset.creditAmount || 0);
        }

        function maxPoints() {
          const points = currentPoints();
          const step = pointStep();
          return Math.max(step, Math.floor(points / step) * step);
        }

        function readyCredit(points = currentPoints()) {
          const step = pointStep();
          const amount = creditAmount();
          return Math.floor(points / step) * amount;
        }

        function nextCredit(points = currentPoints()) {
          const step = pointStep();
          return points % step === 0 ? step : step - (points % step);
        }

        function updateDisplay() {
          const input = widget.querySelector("[data-account-points-input]");
          const submit = widget.querySelector("[data-account-submit]");
          const selectedPoints = Number(input?.value || 0);
          const points = currentPoints();
          const step = pointStep();
          const max = maxPoints();
          const canRedeem =
            Number.isInteger(selectedPoints) &&
            selectedPoints >= step &&
            selectedPoints <= points &&
            selectedPoints % step === 0;
          const preview = creditAmount() * (selectedPoints / step);

          if (input) {
            input.max = String(max);
          }
          if (submit) {
            submit.disabled = !canRedeem;
          }
          widget.querySelectorAll("[data-account-adjust]").forEach((button) => {
            const delta = Number(button.getAttribute("data-account-adjust") || 0);
            button.disabled =
              (delta < 0 && selectedPoints <= step) ||
              (delta > 0 && selectedPoints >= max);
          });
          const previewNode = widget.querySelector("[data-account-preview-credit]");
          if (previewNode) previewNode.textContent = formatMoney(preview);
          const readyNode = widget.querySelector("[data-account-ready-credit]");
          if (readyNode) readyNode.textContent = formatMoney(readyCredit(points));
          const nextNode = widget.querySelector("[data-account-next-credit]");
          if (nextNode) nextNode.textContent = formatNumber(nextCredit(points)) + " pts";
          const pointsNode = widget.querySelector("[data-account-points]");
          if (pointsNode) pointsNode.textContent = formatNumber(points);
          const pointsLabel = widget.querySelector("[data-account-points-label]");
          if (pointsLabel) pointsLabel.textContent = points === 1 ? "point" : "points";
          const currentCreditNode = widget.querySelector("[data-account-current-credit]");
          const inlineCreditNode = widget.querySelector("[data-account-current-credit-inline]");
          if (currentCreditNode) currentCreditNode.textContent = formatMoney(currentCredit());
          if (inlineCreditNode) inlineCreditNode.textContent = formatMoney(currentCredit());
        }

        function setCurrentPoints(points) {
          widget.dataset.currentPoints = String(Math.max(0, Number(points) || 0));
          const input = widget.querySelector("[data-account-points-input]");
          if (input) {
            input.value = String(Math.min(pointStep(), maxPoints()));
          }
          updateDisplay();
        }

        function updateHistoryPage(nextPage) {
          const pagination = widget.querySelector("[data-account-history-pagination]");
          if (!pagination) return;

          const pageCount = Number(pagination.dataset.pageCount || 1);
          const pageSize = Number(pagination.dataset.pageSize || 8);
          const totalCount = Number(pagination.dataset.totalCount || 0);
          const page = Math.min(Math.max(Number(nextPage) || 1, 1), pageCount);
          const firstItem = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
          const lastItem = Math.min(page * pageSize, totalCount);

          pagination.dataset.currentPage = String(page);
          widget.querySelectorAll("[data-account-history-row]").forEach((row) => {
            row.hidden = Number(row.dataset.historyPage || 1) !== page;
          });

          const range = widget.querySelector("[data-account-history-range]");
          if (range) {
            range.textContent = "Showing " + firstItem + "-" + lastItem + " of " + formatNumber(totalCount);
          }

          const label = widget.querySelector("[data-account-history-page-label]");
          if (label) {
            label.textContent = "Page " + page + " of " + formatNumber(pageCount);
          }

          const previous = widget.querySelector("[data-account-history-prev]");
          const next = widget.querySelector("[data-account-history-next]");
          if (previous) previous.disabled = page <= 1;
          if (next) next.disabled = page >= pageCount;
          resize();
        }

        widget.querySelectorAll("[data-account-tab]").forEach((button) => {
          button.addEventListener("click", () => {
            const tab = button.getAttribute("data-account-tab");
            widget.querySelectorAll("[data-account-tab]").forEach((item) => {
              const isActive = item === button;
              item.classList.toggle("gwl-is-active", isActive);
              item.setAttribute("aria-selected", isActive ? "true" : "false");
            });
            widget.querySelectorAll("[data-account-panel]").forEach((panel) => {
              panel.hidden = panel.getAttribute("data-account-panel") !== tab;
            });
            if (tab === "history") {
              const pagination = widget.querySelector("[data-account-history-pagination]");
              updateHistoryPage(pagination?.dataset.currentPage || 1);
            }
            resize();
          });
        });

        const historyPrevious = widget.querySelector("[data-account-history-prev]");
        if (historyPrevious) {
          historyPrevious.addEventListener("click", () => {
            const pagination = widget.querySelector("[data-account-history-pagination]");
            updateHistoryPage(Number(pagination?.dataset.currentPage || 1) - 1);
          });
        }

        const historyNext = widget.querySelector("[data-account-history-next]");
        if (historyNext) {
          historyNext.addEventListener("click", () => {
            const pagination = widget.querySelector("[data-account-history-pagination]");
            updateHistoryPage(Number(pagination?.dataset.currentPage || 1) + 1);
          });
        }

        widget.querySelectorAll("[data-account-adjust]").forEach((button) => {
          button.addEventListener("click", () => {
            const input = widget.querySelector("[data-account-points-input]");
            if (!input) return;
            const delta = Number(button.getAttribute("data-account-adjust") || 0);
            const next = Math.min(
              Math.max(Number(input.value || 0) + delta, pointStep()),
              maxPoints()
            );
            input.value = String(next);
            updateDisplay();
          });
        });

        const input = widget.querySelector("[data-account-points-input]");
        if (input) {
          input.addEventListener("input", updateDisplay);
        }

        const form = widget.querySelector("[data-account-store-credit-form]");
        if (form) {
          form.addEventListener("submit", async (event) => {
            event.preventDefault();
            const submit = widget.querySelector("[data-account-submit]");
            const input = widget.querySelector("[data-account-points-input]");
            const pointsToRedeem = Number(input?.value || 0);
            const originalText = submit?.textContent || "Redeem";

            if (!pointsToRedeem) return;
            if (submit) {
              submit.disabled = true;
              submit.textContent = "Redeeming";
            }
            setNotice("Converting points to store credit...", false);

            try {
              const response = await fetch(widget.dataset.redeemUrl, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({
                  customerId: widget.dataset.customerId,
                  shop: widget.dataset.shopDomain,
                  pointsToRedeem,
                  rewardType: "store_credit"
                })
              });
              const data = await readJsonResponse(response, "Could not convert points to store credit.");
              if (!data.success || !data.reward) {
                throw new Error(data.message || "Could not convert points to store credit.");
              }

              const amount = Number(data.reward.amount || 0);
              const newPoints = currentPoints() - pointsToRedeem;
              widget.dataset.currentCredit = String(currentCredit() + amount);
              setCurrentPoints(newPoints);
              setNotice(data.message || "Store credit added: " + formatMoney(amount), false);
            } catch (error) {
              setNotice(error.message || "Could not convert points to store credit.", true);
            } finally {
              if (submit) {
                submit.textContent = originalText;
              }
              updateDisplay();
              resize();
            }
          });
        }

        const resize = () => {
          window.parent.postMessage({
            type: "loyalty-iframe-height",
            height: document.documentElement.scrollHeight
          }, "*");
        };

        updateDisplay();
        updateHistoryPage(1);
        resize();
        window.addEventListener("load", resize);
        new ResizeObserver(resize).observe(document.body);
      })();
    </script>
  </body>
</html>`;
}

function renderFloatingRewardItems(
  rewards,
  points,
  pendingCheckoutRedemption,
  copy,
  currencyCode,
) {
  if (!rewards.length) {
    return `<p class="gwl-floating-iframe__message">${escapeHtml(
      copy.noRewardsMessage,
    )}</p>`;
  }

  const hasPendingCheckoutRedemption = Boolean(
    pendingCheckoutRedemption?.rewardCode,
  );
  const normalizedPendingReward = normalizeCheckoutReward(
    pendingCheckoutRedemption,
  );

  return `
    <ul class="gwl-floating-iframe__reward-list">
      ${rewards
        .map((reward) => {
          const rewardPoints = Number(reward.points || 0);
          const canRedeem = points >= rewardPoints;
          const pointsRemaining = Math.max(rewardPoints - points, 0);
          const isApplied = Boolean(
            normalizedPendingReward?.rewardCode &&
            getRewardKey(reward) ===
              `${normalizedPendingReward.rewardType}:${normalizedPendingReward.pointsUsed}`,
          );
          const cta = canRedeem
            ? isApplied
              ? "Applied"
              : copy.redeemButtonText
            : `${formatNumber(pointsRemaining)} more needed`;

          return `
            <li>
              <button
                type="button"
                data-floating-reward='${escapeAttr(JSON.stringify(reward))}'
                data-reward-key="${escapeAttr(getRewardKey(reward))}"
                ${canRedeem && !hasPendingCheckoutRedemption ? "" : "disabled"}
                aria-label="Redeem ${escapeAttr(formatRewardTitle(reward, currencyCode))}"
              >
                <span class="gwl-floating-iframe__reward-main">
                  <span>
                    <strong>${escapeHtml(formatRewardTitle(reward, currencyCode))}</strong>
                    <span>${escapeHtml(formatRewardDescription(reward, currencyCode))}</span>
                  </span>
                  <em>${escapeHtml(formatRewardValue(reward, currencyCode))}</em>
                </span>
                <span class="gwl-floating-iframe__reward-meta">
                  <small>${formatNumber(rewardPoints)} points</small>
                  <small data-floating-reward-cta>${escapeHtml(cta)}</small>
                </span>
              </button>
            </li>
          `;
        })
        .join("")}
    </ul>
  `;
}

function renderFloatingIframeDocument({
  appCustomerId,
  cartUpdateUrl,
  copy,
  currencyCode,
  customerId,
  hasPendingCheckoutRedemption,
  pendingCheckoutRedemption,
  loginUrl,
  points,
  redeemUrl,
  redemptionEnabled,
  registerUrl,
  rewardOptions,
  shopDomain,
  theme,
}) {
  const loggedIn = Boolean(customerId);
  const rewards = rewardOptions.filter((reward) =>
    ["discount", "gift_card"].includes(reward.type || "discount"),
  );
  const availableRewards = rewards.filter(
    (reward) => Number(reward.points || 0) <= points,
  );
  const nextReward = rewards
    .filter((reward) => Number(reward.points || 0) > points)
    .sort(
      (left, right) => Number(left.points || 0) - Number(right.points || 0),
    )[0];
  const balanceMessage = hasPendingCheckoutRedemption
    ? PENDING_REDEMPTION_MESSAGE
    : "Ready when you are.";
  const availableCountText =
    availableRewards.length === 1
      ? "You have 1 reward available"
      : `You have ${availableRewards.length} rewards available`;
  const availableRewardItems = renderFloatingRewardItems(
    availableRewards,
    points,
    pendingCheckoutRedemption,
    copy,
    currencyCode,
  );
  const allRewardItems = renderFloatingRewardItems(
    rewards,
    points,
    pendingCheckoutRedemption,
    copy,
    currencyCode,
  );

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Rewards</title>
    ${renderFontAssets(theme)}
    <style>
      :root {
        color-scheme: light;
        --loyalty-accent-color: ${escapeHtml(theme.accentColor)};
        --loyalty-background: ${escapeHtml(theme.backgroundColor)};
        --loyalty-foreground: ${escapeHtml(theme.foregroundColor)};
        --loyalty-border: ${escapeHtml(theme.borderColor)};
        --loyalty-font-family: ${theme.fontFamily};
        --loyalty-font-size: ${escapeHtml(theme.fontSize)}px;
      }

      * { box-sizing: border-box; }

      html,
      body {
        background: transparent;
        color: var(--loyalty-foreground);
        font-family: var(--loyalty-font-family);
        font-size: var(--loyalty-font-size);
        margin: 0;
        min-height: 100%;
      }

      .gwl-floating-iframe {
        align-items: flex-end;
        display: flex;
        flex-direction: column;
        gap: 12px;
        justify-content: flex-end;
        min-height: 100vh;
        padding: 16px;
        pointer-events: none;
      }

      .gwl-floating-iframe button,
      .gwl-floating-iframe a {
        font: inherit;
      }

      .gwl-floating-iframe__launcher {
        align-items: center;
        background: var(--loyalty-accent-color);
        border: 0;
        border-radius: 8px;
        box-shadow: 0 6px 20px rgba(32, 34, 35, 0.18);
        color: #ffffff;
        cursor: pointer;
        display: flex;
        font-weight: 800;
        gap: 9px;
        margin-top: 0;
        min-height: 52px;
        padding: 0 20px;
        pointer-events: auto;
      }

      .gwl-floating-iframe__panel {
        background: #ffffff;
        border: 1px solid rgba(32, 34, 35, 0.12);
        border-radius: 8px;
        box-shadow: 0 12px 36px rgba(32, 34, 35, 0.22);
        max-height: min(640px, calc(100vh - 96px));
        overflow-y: auto;
        padding: 20px;
        pointer-events: auto;
        width: min(380px, calc(100vw - 32px));
      }

      .gwl-floating-iframe__top,
      .gwl-floating-iframe__view-header {
        align-items: center;
        display: flex;
        justify-content: space-between;
      }

      .gwl-floating-iframe__top {
        color: var(--loyalty-accent-color);
        margin: -4px -4px 12px;
      }

      .gwl-floating-iframe__close,
      .gwl-floating-iframe__view-close,
      .gwl-floating-iframe__back {
        background: #f1f2f3;
        border: 0;
        border-radius: 999px;
        color: #202223;
        cursor: pointer;
        height: 34px;
        width: 34px;
      }

      .gwl-floating-iframe__header {
        text-align: center;
      }

      .gwl-floating-iframe__eyebrow {
        color: var(--loyalty-accent-color);
        font-size: 12px;
        font-weight: 800;
        margin: 0 0 4px;
        text-transform: uppercase;
      }

      .gwl-floating-iframe__title {
        font-size: 22px;
        line-height: 1.25;
        margin: 0;
      }

      .gwl-floating-iframe__message {
        color: #616a75;
        font-size: 14px;
        line-height: 20px;
        margin: 14px 0 0;
      }

      .gwl-floating-iframe__message--error {
        color: #b42318;
      }

      .gwl-floating-iframe__balance {
        align-items: center;
        border: 1px solid rgba(0, 128, 96, 0.22);
        border-radius: 8px;
        display: flex;
        gap: 16px;
        justify-content: space-between;
        margin-top: 14px;
        padding: 14px;
      }

      .gwl-floating-iframe__balance span,
      .gwl-floating-iframe__next span,
      .gwl-floating-iframe__next small {
        color: #616a75;
        font-size: 14px;
      }

      .gwl-floating-iframe__balance strong {
        color: var(--loyalty-accent-color);
        font-size: 28px;
      }

      .gwl-floating-iframe__balance small {
        background: rgba(0, 128, 96, 0.08);
        border-radius: 999px;
        color: var(--loyalty-accent-color);
        font-size: 12px;
        font-weight: 800;
        padding: 6px 10px;
      }

      .gwl-floating-iframe__next {
        border: 1px solid rgba(0, 128, 96, 0.16);
        border-radius: 8px;
        display: grid;
        gap: 4px;
        margin-top: 12px;
        padding: 12px 14px;
      }

      .gwl-floating-iframe__actions,
      .gwl-floating-iframe__guest-actions,
      .gwl-floating-iframe__method-list {
        display: grid;
        gap: 10px;
        margin-top: 18px;
      }

      .gwl-floating-iframe__actions button,
      .gwl-floating-iframe__guest-actions a {
        background: #ffffff;
        border: 1px solid rgba(0, 128, 96, 0.22);
        border-radius: 8px;
        color: #202223;
        cursor: pointer;
        display: grid;
        gap: 3px;
        padding: 14px;
        text-align: left;
        text-decoration: none;
      }

      .gwl-floating-iframe__actions button {
        grid-template-columns: 1fr 18px;
      }

      .gwl-floating-iframe__actions strong,
      .gwl-floating-iframe__actions small {
        display: block;
      }

      .gwl-floating-iframe__actions small,
      .gwl-floating-iframe__reward-main span span,
      .gwl-floating-iframe__reward-meta,
      .gwl-floating-iframe__method-list p {
        color: #616a75;
        font-size: 13px;
        line-height: 18px;
      }

      .gwl-floating-iframe__guest-actions {
        grid-template-columns: 1fr 1fr;
      }

      .gwl-floating-iframe__guest-actions a:first-child {
        background: var(--loyalty-accent-color);
        color: #ffffff;
        font-weight: 800;
        text-align: center;
      }

      .gwl-floating-iframe__guest-actions a:last-child {
        color: var(--loyalty-accent-color);
        font-weight: 800;
        text-align: center;
      }

      .gwl-floating-iframe__view {
        margin: -20px;
        min-height: 480px;
      }

      .gwl-floating-iframe__view-header {
        background: #e3e5e7;
        display: grid;
        gap: 10px;
        grid-template-columns: 36px 1fr 36px;
        padding: 14px 16px;
        position: sticky;
        top: -20px;
      }

      .gwl-floating-iframe__view-header strong,
      .gwl-floating-iframe__view-header small {
        display: block;
      }

      .gwl-floating-iframe__view-header small {
        color: #616a75;
        font-size: 12px;
        margin-top: 2px;
      }

      .gwl-floating-iframe__view-content {
        padding: 22px 20px;
      }

      .gwl-floating-iframe__view-content h3 {
        font-size: 17px;
        margin: 0 0 14px;
      }

      .gwl-floating-iframe__method-list {
        margin-top: 0;
      }

      .gwl-floating-iframe__method {
        border-bottom: 1px solid #e3e5e7;
        display: grid;
        gap: 12px;
        grid-template-columns: 30px 1fr;
        padding: 16px 4px;
      }

      .gwl-floating-iframe__method > span {
        color: var(--loyalty-accent-color);
        font-size: 20px;
      }

      .gwl-floating-iframe__method strong,
      .gwl-floating-iframe__method p {
        margin: 0;
      }

      .gwl-floating-iframe__reward-list {
        display: grid;
        list-style: none;
        margin: 0;
        padding: 0;
      }

      .gwl-floating-iframe__reward-list li {
        border-bottom: 1px solid #e3e5e7;
      }

      .gwl-floating-iframe__reward-list button {
        background: transparent;
        border: 0;
        color: inherit;
        cursor: pointer;
        display: grid;
        gap: 10px;
        padding: 16px 4px;
        text-align: left;
        width: 100%;
      }

      .gwl-floating-iframe__reward-list button:disabled {
        cursor: default;
        opacity: 0.6;
      }

      .gwl-floating-iframe__reward-main,
      .gwl-floating-iframe__reward-meta {
        align-items: flex-start;
        display: flex;
        gap: 14px;
        justify-content: space-between;
      }

      .gwl-floating-iframe__reward-main strong {
        display: block;
        margin-bottom: 4px;
      }

      .gwl-floating-iframe__reward-main em {
        color: var(--loyalty-accent-color);
        font-style: normal;
        font-weight: 800;
        white-space: nowrap;
      }

      .gwl-floating-iframe__reward-meta small:last-child {
        color: var(--loyalty-accent-color);
        font-weight: 800;
      }

      [hidden] { display: none !important; }
      ${renderCustomCss(theme)}
    </style>
  </head>
  <body>
    <main
      class="gwl-floating-iframe"
      data-shop-domain="${escapeAttr(shopDomain || "")}"
      data-customer-id="${escapeAttr(appCustomerId || customerId || "")}"
      data-redeem-url="${escapeAttr(redeemUrl)}"
      data-cart-update-url="${escapeAttr(cartUpdateUrl)}"
      data-pending-reward-code="${escapeAttr(pendingCheckoutRedemption?.rewardCode || "")}"
      data-pending-reward-type="${escapeAttr(pendingCheckoutRedemption?.rewardType || "")}"
    >
      <section class="gwl-floating-iframe__panel" id="floating-loyalty-panel" aria-label="Rewards" hidden data-floating-panel>
        <div data-floating-view="overview">
          <div class="gwl-floating-iframe__top">
            <span>${escapeHtml(copy.launcherLabel)}</span>
            <button class="gwl-floating-iframe__close" type="button" aria-label="Close rewards" data-floating-close>X</button>
          </div>
          <div class="gwl-floating-iframe__header">
            <p class="gwl-floating-iframe__eyebrow">${escapeHtml(copy.eyebrow)}</p>
            <h1 class="gwl-floating-iframe__title">${escapeHtml(copy.heading)}</h1>
          </div>
          ${
            loggedIn
              ? `
                <p class="gwl-floating-iframe__message" data-floating-message>${escapeHtml(
                  balanceMessage,
                )}</p>
                <div class="gwl-floating-iframe__balance">
                  <div>
                    <span>Available points</span>
                    <strong>${formatNumber(points)}</strong>
                  </div>
                  <small>${availableRewards.length > 0 ? `${availableRewards.length} ready` : "Keep earning"}</small>
                </div>
                ${
                  nextReward
                    ? `
                      <div class="gwl-floating-iframe__next">
                        <span>Next reward</span>
                        <strong>${escapeHtml(formatRewardTitle(nextReward, currencyCode))}</strong>
                        <small>${formatNumber(
                          Number(nextReward.points || 0) - points,
                        )} more points needed</small>
                      </div>
                    `
                    : ""
                }
                ${
                  redemptionEnabled
                    ? `
                      <div class="gwl-floating-iframe__actions">
                        <button type="button" data-floating-view-target="available">
                          <span><strong>Your available rewards</strong><small>${escapeHtml(
                            availableCountText,
                          )}</small></span>
                          <span aria-hidden="true">›</span>
                        </button>
                        <button type="button" data-floating-view-target="earn">
                          <span><strong>Ways to earn</strong></span>
                          <span aria-hidden="true">›</span>
                        </button>
                        <button type="button" data-floating-view-target="redeem">
                          <span><strong>Ways to redeem</strong></span>
                          <span aria-hidden="true">›</span>
                        </button>
                      </div>
                    `
                    : `<p class="gwl-floating-iframe__message">Reward redemption is currently paused.</p>`
                }
              `
              : `
                <p class="gwl-floating-iframe__message">${escapeHtml(
                  copy.loggedOutMessage,
                )}</p>
                <div class="gwl-floating-iframe__guest-actions">
                  <a href="${escapeAttr(registerUrl)}" target="_top">Join</a>
                  <a href="${escapeAttr(loginUrl)}" target="_top">${escapeHtml(
                    copy.loginLabel,
                  )}</a>
                </div>
                <div class="gwl-floating-iframe__actions">
                  <button type="button" data-floating-view-target="earn"><span><strong>Earn points</strong></span><span aria-hidden="true">›</span></button>
                  <button type="button" data-floating-view-target="redeem"><span><strong>Redeem points</strong></span><span aria-hidden="true">›</span></button>
                </div>
              `
          }
        </div>
        <section class="gwl-floating-iframe__view" data-floating-view="available" hidden>
          <div class="gwl-floating-iframe__view-header">
            <button class="gwl-floating-iframe__back" type="button" aria-label="Back to rewards overview" data-floating-view-target="overview">‹</button>
            <div><strong>${formatNumber(points)} points</strong><small>Your available rewards</small></div>
            <button class="gwl-floating-iframe__view-close" type="button" aria-label="Close rewards" data-floating-close>×</button>
          </div>
          <div class="gwl-floating-iframe__view-content">
            <h3>Your available rewards</h3>
            ${availableRewardItems}
          </div>
        </section>
        <section class="gwl-floating-iframe__view" data-floating-view="earn" hidden>
          <div class="gwl-floating-iframe__view-header">
            <button class="gwl-floating-iframe__back" type="button" aria-label="Back to rewards overview" data-floating-view-target="overview">‹</button>
            <div><strong>${formatNumber(points)} points</strong><small>Ways to earn</small></div>
            <button class="gwl-floating-iframe__view-close" type="button" aria-label="Close rewards" data-floating-close>×</button>
          </div>
          <div class="gwl-floating-iframe__view-content">
            <h3>Ways to earn</h3>
            <div class="gwl-floating-iframe__method-list">
              <div class="gwl-floating-iframe__method"><span aria-hidden="true">+</span><div><strong>Join our rewards program</strong><p>Start earning points as soon as you join.</p></div></div>
              <div class="gwl-floating-iframe__method"><span aria-hidden="true">□</span><div><strong>Place an order</strong><p>Earn points every time you shop with us.</p></div></div>
              <div class="gwl-floating-iframe__method"><span aria-hidden="true">★</span><div><strong>Keep shopping</strong><p>Save your points and unlock more valuable rewards.</p></div></div>
            </div>
          </div>
        </section>
        <section class="gwl-floating-iframe__view" data-floating-view="redeem" hidden>
          <div class="gwl-floating-iframe__view-header">
            <button class="gwl-floating-iframe__back" type="button" aria-label="Back to rewards overview" data-floating-view-target="overview">‹</button>
            <div><strong>${formatNumber(points)} points</strong><small>Ways to redeem</small></div>
            <button class="gwl-floating-iframe__view-close" type="button" aria-label="Close rewards" data-floating-close>×</button>
          </div>
          <div class="gwl-floating-iframe__view-content">
            <h3>Ways to redeem</h3>
            ${allRewardItems}
          </div>
        </section>
      </section>
      <button class="gwl-floating-iframe__launcher gwl-floating-launcher" type="button" aria-controls="floating-loyalty-panel" aria-expanded="false" data-floating-toggle>
        <span aria-hidden="true">★</span>
        <span>${escapeHtml(copy.launcherLabel)}</span>
      </button>
    </main>
    <script>
      (() => {
        const root = document.querySelector(".gwl-floating-iframe");
        if (!root) return;
        const panel = root.querySelector("[data-floating-panel]");
        const launcher = root.querySelector("[data-floating-toggle]");

        function escapeText(value) {
          return String(value || "").replace(/[&<>"']/g, (char) => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
          })[char]);
        }

        function setOpen(open) {
          if (!panel || !launcher) return;
          panel.hidden = !open;
          launcher.setAttribute("aria-expanded", String(open));
          window.parent.postMessage({
            type: "loyalty-floating-iframe-state",
            open
          }, "*");
          resize();
        }

        function showView(viewName) {
          root.querySelectorAll("[data-floating-view]").forEach((view) => {
            view.hidden = view.dataset.floatingView !== viewName;
          });
          resize();
        }

        function setMessage(message, isError) {
          const target = root.querySelector("[data-floating-message]");
          if (!target) return;
          target.textContent = message || "";
          target.classList.toggle("gwl-floating-iframe__message--error", Boolean(isError));
        }

        async function readJsonResponse(response, fallbackMessage) {
          const text = await response.text();
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            throw new Error(fallbackMessage);
          }
          if (!response.ok || !data || typeof data !== "object") {
            throw new Error(data && data.message ? data.message : fallbackMessage);
          }
          return data;
        }

        async function redeem(button) {
          const reward = JSON.parse(button.getAttribute("data-floating-reward") || "{}");
          const cta = button.querySelector("[data-floating-reward-cta]");
          const originalText = cta?.textContent || "Redeem";
          button.disabled = true;
          if (cta) cta.textContent = "Redeeming...";
          setMessage("Creating your reward...", false);

          try {
            const response = await fetch(root.dataset.redeemUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                customerId: root.dataset.customerId,
                shop: root.dataset.shopDomain,
                pointsToRedeem: Number(reward.points),
                rewardType: reward.type || "discount",
                surface: "floating",
                allowPendingRewardCheckout: true
              })
            });
            const data = await readJsonResponse(response, "Could not redeem points.");
            if (!data.success || !data.reward) {
              throw new Error(data.message || "Could not redeem points.");
            }
            if (data.reward.rewardType === "discount") {
              const application = await applyDiscountToCart(data.reward);
              if (!application.success) {
                throw new Error(application.message || "Could not apply discount to cart.");
              }
            }
            setMessage(
              data.reward.rewardType === "discount"
                ? "Discount applied to your cart and checkout."
                : "Reward created. Open checkout to use it.",
              false
            );
            root.querySelectorAll("[data-floating-reward]").forEach((rewardButton) => {
              rewardButton.disabled = true;
            });
            if (cta) cta.textContent = "Applied";
          } catch (error) {
            setMessage(error.message || "Could not redeem points.", true);
            button.disabled = false;
            if (cta) cta.textContent = originalText;
          }
        }

        async function applyDiscountToCart(reward) {
          const response = await fetch(root.dataset.cartUpdateUrl || "/cart/update.js", {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "Accept": "application/json",
              "Content-Type": "application/json"
            },
            body: JSON.stringify({discount: reward.rewardCode})
          });
          const cart = await response.json().catch(() => null);

          if (!response.ok || !cart) {
            return {
              success: false,
              message: cart?.description || "Could not apply discount to cart."
            };
          }

          return {success: true};
        }

        launcher?.addEventListener("click", () => {
          setOpen(launcher.getAttribute("aria-expanded") !== "true");
        });
        root.querySelectorAll("[data-floating-close]").forEach((button) => {
          button.addEventListener("click", () => setOpen(false));
        });
        root.querySelectorAll("[data-floating-view-target]").forEach((button) => {
          button.addEventListener("click", () => showView(button.dataset.floatingViewTarget));
        });
        root.querySelectorAll("[data-floating-reward]").forEach((button) => {
          button.addEventListener("click", () => redeem(button));
        });
        document.addEventListener("keydown", (event) => {
          if (event.key === "Escape") setOpen(false);
        });

        const resize = () => {
          window.parent.postMessage({
            type: "loyalty-iframe-height",
            height: document.documentElement.scrollHeight
          }, "*");
        };

        window.parent.postMessage({
          type: "loyalty-floating-iframe-state",
          open: false
        }, "*");
        if (
          root.dataset.pendingRewardType === "discount" &&
          root.dataset.pendingRewardCode
        ) {
          applyDiscountToCart({
            rewardCode: root.dataset.pendingRewardCode,
            rewardType: root.dataset.pendingRewardType
          }).then((result) => {
            setMessage(
              result.success
                ? "Discount applied to your cart and checkout."
                : result.message || "Could not apply discount to cart.",
              !result.success
            );
          });
        }
        resize();
        window.addEventListener("load", resize);
        new ResizeObserver(resize).observe(document.body);
      })();
    </script>
  </body>
</html>`;
}

function renderIframeDocument({
  appCustomerId,
  copy,
  currencyCode,
  customerId,
  loginUrl,
  points,
  redeemUrl,
  redemptionEnabled,
  registerUrl,
  rewardOptions,
  shopDomain,
  showRewards,
  theme,
}) {
  const loggedIn = Boolean(customerId);
  const pointsText = copy.pointsTemplate.replace(
    "{points}",
    formatNumber(points),
  );
  const rewardsMarkup =
    loggedIn && showRewards
      ? renderRewardList(
          rewardOptions,
          points,
          redemptionEnabled,
          copy,
          currencyCode,
        )
      : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(copy.heading)}</title>
    ${renderFontAssets(theme)}
    <style>
      :root {
        color-scheme: light;
        --loyalty-accent-color: ${escapeHtml(theme.accentColor)};
        --loyalty-background: ${escapeHtml(theme.backgroundColor)};
        --loyalty-foreground: ${escapeHtml(theme.foregroundColor)};
        --loyalty-border: ${escapeHtml(theme.borderColor)};
        --loyalty-font-family: ${theme.fontFamily};
        --loyalty-font-size: ${escapeHtml(theme.fontSize)}px;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        background: transparent;
        color: var(--loyalty-foreground);
        font-family: var(--loyalty-font-family);
        font-size: var(--loyalty-font-size);
      }

      .gwl-loyalty-iframe {
        border: 1px solid var(--loyalty-border);
        border-radius: 8px;
        background: var(--loyalty-background);
        padding: 20px;
      }

      .gwl-loyalty-iframe__eyebrow {
        margin: 0 0 4px;
        color: var(--loyalty-accent-color);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0;
        text-transform: uppercase;
      }

      .gwl-loyalty-iframe__title {
        margin: 0;
        font-size: 22px;
        line-height: 1.25;
      }

      .gwl-loyalty-iframe__message {
        margin: 12px 0 0;
        color: #616a75;
        font-size: 14px;
        line-height: 20px;
      }

      .gwl-loyalty-iframe__balance {
        align-items: center;
        border: 1px solid rgba(0, 128, 96, 0.22);
        border-radius: 8px;
        display: flex;
        gap: 16px;
        justify-content: space-between;
        margin-top: 16px;
        padding: 14px;
      }

      .gwl-loyalty-iframe__balance span {
        color: #616a75;
        font-size: 14px;
      }

      .gwl-loyalty-iframe__balance strong {
        color: var(--loyalty-accent-color);
        font-size: 28px;
        line-height: 1;
      }

      .gwl-loyalty-iframe__actions {
        display: grid;
        gap: 10px;
        margin-top: 16px;
      }

      .gwl-loyalty-iframe__action,
      .gwl-loyalty-iframe__button {
        border: 1px solid var(--loyalty-border);
        border-radius: 8px;
        color: inherit;
        padding: 12px 14px;
        text-decoration: none;
      }

      .gwl-loyalty-iframe__button {
        border-color: var(--loyalty-accent-color);
        color: var(--loyalty-accent-color);
        display: block;
        font-weight: 700;
        text-align: center;
      }

      .gwl-loyalty-iframe__button--primary {
        background: var(--loyalty-accent-color);
        color: #ffffff;
      }

      .gwl-loyalty-iframe__reward-section {
        margin-top: 18px;
      }

      .gwl-loyalty-iframe__reward-section h2 {
        font-size: 16px;
        line-height: 22px;
        margin: 0 0 10px;
      }

      .gwl-loyalty-iframe__reward-list {
        display: grid;
        gap: 10px;
        list-style: none;
        margin: 0;
        padding: 0;
      }

      .gwl-loyalty-iframe__reward {
        border: 1px solid var(--loyalty-border);
        border-radius: 8px;
        overflow: hidden;
      }

      .gwl-loyalty-iframe__reward-button {
        background: transparent;
        border: 0;
        color: inherit;
        cursor: pointer;
        display: grid;
        font: inherit;
        gap: 4px;
        padding: 14px;
        text-align: left;
        width: 100%;
      }

      .gwl-loyalty-iframe__reward-button:hover,
      .gwl-loyalty-iframe__reward-button:focus-visible {
        background: rgba(0, 128, 96, 0.05);
        outline: 2px solid var(--loyalty-accent-color);
        outline-offset: -2px;
      }

      .gwl-loyalty-iframe__reward-button:disabled {
        cursor: default;
        opacity: 0.65;
      }

      .gwl-loyalty-iframe__reward-title {
        font-weight: 700;
      }

      .gwl-loyalty-iframe__reward-description {
        color: #616a75;
        font-size: 13px;
        line-height: 18px;
      }

      .gwl-loyalty-iframe__reward-cta {
        color: var(--loyalty-accent-color);
        font-size: 13px;
        font-weight: 700;
        margin-top: 6px;
      }

      .gwl-loyalty-iframe__notice {
        border-radius: 8px;
        margin: 12px 0 0;
        padding: 10px 12px;
      }

      .gwl-loyalty-iframe__notice--success {
        background: #f0fdf4;
        color: #0c5132;
      }

      .gwl-loyalty-iframe__notice--error {
        background: #fff4f4;
        color: #8e1f0b;
      }

      .gwl-loyalty-iframe__guest-actions {
        display: grid;
        gap: 10px;
        grid-template-columns: 1fr 1fr;
        margin-top: 16px;
      }

      @media (max-width: 420px) {
        .gwl-loyalty-iframe { padding: 16px; }
        .gwl-loyalty-iframe__guest-actions { grid-template-columns: 1fr; }
      }
      ${renderCustomCss(theme)}
    </style>
  </head>
  <body>
    <main
      class="gwl-loyalty-iframe"
      data-shop-domain="${escapeAttr(shopDomain || "")}"
      data-customer-id="${escapeAttr(appCustomerId || customerId || "")}"
      data-redeem-url="${escapeAttr(redeemUrl)}"
    >
      <p class="gwl-loyalty-iframe__eyebrow">${escapeHtml(copy.eyebrow)}</p>
      <h1 class="gwl-loyalty-iframe__title">${escapeHtml(copy.heading)}</h1>

      ${
        loggedIn
          ? `
            <p class="gwl-loyalty-iframe__message">${escapeHtml(pointsText)}</p>
            <div class="gwl-loyalty-iframe__balance">
              <span>Available points</span>
              <strong>${formatNumber(points)}</strong>
            </div>
            <div data-loyalty-iframe-message></div>
            <section class="gwl-loyalty-iframe__reward-section" aria-label="${escapeAttr(
              copy.rewardsHeading,
            )}">
              <h2>${escapeHtml(copy.rewardsHeading)}</h2>
              ${rewardsMarkup}
            </section>
          `
          : `
            <p class="gwl-loyalty-iframe__message">${escapeHtml(
              copy.loggedOutMessage,
            )}</p>
            <div class="gwl-loyalty-iframe__guest-actions">
              <a class="gwl-loyalty-iframe__button gwl-loyalty-iframe__button--primary" href="${escapeAttr(
                registerUrl,
              )}" target="_top">Join</a>
              <a class="gwl-loyalty-iframe__button" href="${escapeAttr(
                loginUrl,
              )}" target="_top">${escapeHtml(copy.loginLabel)}</a>
            </div>
          `
      }
    </main>
    <script>
      (() => {
        function setNotice(message, isError) {
          const container = document.querySelector("[data-loyalty-iframe-message]");
          if (!container) return;
          container.innerHTML =
            '<p class="gwl-loyalty-iframe__notice ' +
            (isError ? 'gwl-loyalty-iframe__notice--error' : 'gwl-loyalty-iframe__notice--success') +
            '">' +
            String(message || '').replace(/[&<>"']/g, (char) => ({
              '&': '&amp;',
              '<': '&lt;',
              '>': '&gt;',
              '"': '&quot;',
              "'": '&#39;'
            })[char]) +
            '</p>';
        }

        async function readJsonResponse(response, fallbackMessage) {
          const text = await response.text();
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            throw new Error(fallbackMessage);
          }

          if (!response.ok || !data || typeof data !== "object") {
            throw new Error(data && data.message ? data.message : fallbackMessage);
          }

          return data;
        }

        async function redeem(button) {
          const widget = document.querySelector(".gwl-loyalty-iframe");
          const reward = JSON.parse(button.getAttribute("data-reward") || "{}");
          const originalText = button.querySelector(".gwl-loyalty-iframe__reward-cta")?.textContent;

          button.disabled = true;
          const cta = button.querySelector(".gwl-loyalty-iframe__reward-cta");
          if (cta) cta.textContent = "Redeeming...";
          setNotice("Creating your reward...", false);

          try {
            const response = await fetch(widget.dataset.redeemUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                customerId: widget.dataset.customerId,
                shop: widget.dataset.shopDomain,
                pointsToRedeem: Number(reward.points),
                rewardType: reward.type || "discount",
                allowPendingRewardCheckout: true
              })
            });
            const data = await readJsonResponse(response, "Could not redeem points.");
            if (!data.success || !data.reward) {
              throw new Error(data.message || "Could not redeem points.");
            }
            setNotice("Your reward created and applied on checkout.", false);
            if (cta) cta.textContent = "Applied";
          } catch (error) {
            setNotice(error.message || "Could not redeem points.", true);
            button.disabled = false;
            if (cta) cta.textContent = originalText || "Redeem";
          }
        }

        document.querySelectorAll("[data-reward]").forEach((button) => {
          button.addEventListener("click", () => redeem(button));
        });

        const resize = () => {
          window.parent.postMessage({
            type: "loyalty-iframe-height",
            height: document.documentElement.scrollHeight
          }, "*");
        };

        resize();
        window.addEventListener("load", resize);
        new ResizeObserver(resize).observe(document.body);
      })();
    </script>
  </body>
</html>`;
}

export const loader = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const shopDomain = normalizeShopDomain(url.searchParams.get("shop"));
    const customerId = getShopifyCustomerId(url.searchParams.get("customerId"));
    const customerEmail = normalizeEmail(url.searchParams.get("customerEmail"));
    const presentmentCurrencyCode = normalizeCurrencyCode(
      url.searchParams.get("currencyCode"),
    );
    const showRewards = url.searchParams.get("showRewards") !== "false";
    const surface = url.searchParams.get("surface") || "theme";
    const loginUrl = getParam(url, "loginUrl", "/account/login");
    const registerUrl = getParam(url, "registerUrl", "/account/register");
    const redeemUrl = getParam(url, "redeemUrl", "/api/redeem-points");
    const cartUpdateUrl = getParam(url, "cartUpdateUrl", "/cart/update.js");
    const {
      customer,
      currencyCode: shopCurrencyCode,
      hasPendingCheckoutRedemption,
      pendingCheckoutRedemption,
      history,
      redemptionEnabled,
      rewardOptions,
      settings,
      storeCreditBalance,
      storeCreditReward,
    } = await loadWidgetData(
      shopDomain,
      customerId,
      customerEmail,
      surface,
      getRewardRuleContextFromUrl(url),
    );
    const currencyCode = presentmentCurrencyCode || shopCurrencyCode;
    const copy = buildIframeCopy(url, settings);
    const theme = buildIframeTheme(url, settings);

    if (url.searchParams.get("customCssOnly") === "true") {
      return new Response(theme.customCss || "", {
        headers: {
          "Content-Type": "text/css; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    const points = customer?.loyaltyPoints || 0;
    const document =
      surface === "account"
        ? renderAccountIframeDocument({
            appCustomerId: customer?.id,
            copy,
            currencyCode,
            customerId,
            history,
            loginUrl,
            points,
            redeemUrl,
            redemptionEnabled,
            registerUrl,
            shopDomain,
            storeCreditBalance,
            storeCreditReward,
            theme,
          })
        : surface === "floating"
          ? renderFloatingIframeDocument({
              appCustomerId: customer?.id,
              cartUpdateUrl,
              copy,
              currencyCode,
              customerId,
              hasPendingCheckoutRedemption,
              pendingCheckoutRedemption,
              loginUrl,
              points,
              redeemUrl,
              redemptionEnabled,
              registerUrl,
              rewardOptions,
              shopDomain,
              theme,
            })
          : renderIframeDocument({
              appCustomerId: customer?.id,
              copy,
              currencyCode,
              customerId,
              loginUrl,
              points,
              redeemUrl,
              redemptionEnabled,
              registerUrl,
              rewardOptions,
              shopDomain,
              showRewards,
              theme,
            });

    return new Response(document, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    logError("loyalty-iframe", error, {
      requestUrl: request.url,
    });

    return new Response(
      "<!doctype html><p>Could not load loyalty widget.</p>",
      {
        status: 500,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }
};
