import {
  normalizeEmailTemplates,
  renderEmailTemplate,
} from "./email-notifications.shared.js";

const DEFAULT_STORE_NAME = "Loyalty Rewards";

function hasValue(value) {
  return value !== null && value !== undefined && value !== "";
}

function formatPoints(value) {
  return Number(value || 0).toLocaleString("en");
}

function formatMoney(value, currencyCode) {
  if (!hasValue(value)) {
    return "";
  }

  const amount = Number(value);

  if (!Number.isFinite(amount)) {
    return "";
  }

  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: currencyCode || "USD",
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currencyCode || "USD"} ${amount.toLocaleString("en")}`;
  }
}

function formatDate(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function rewardLabel(payload = {}) {
  const amount = formatMoney(
    payload.amount ?? payload.discountAmount,
    payload.currencyCode,
  );
  const rewardType =
    payload.rewardType === "gift_card"
      ? "gift card"
      : payload.rewardType === "store_credit"
        ? "store credit"
        : "discount";

  return amount ? `${amount} ${rewardType}` : rewardType;
}

function formatOrderReference(payload = {}) {
  const reference = String(payload.orderName || "").trim();

  if (!reference) {
    return "";
  }

  const orderNumber = reference.match(/^#?(\d+)$/)?.[1];

  return orderNumber ? `#${orderNumber}` : reference;
}

function getStoreUrl(shopDomain) {
  const value = String(shopDomain || "").trim();

  if (!value) {
    return "";
  }

  try {
    const url = new URL(
      /^https?:\/\//i.test(value) ? value : `https://${value}`,
    );

    return ["http:", "https:"].includes(url.protocol)
      ? url.href.replace(/\/$/, "")
      : "";
  } catch {
    return "";
  }
}

function getStoreName(shopDomain) {
  const storeUrl = getStoreUrl(shopDomain);

  if (!storeUrl) {
    return DEFAULT_STORE_NAME;
  }

  const hostname = new URL(storeUrl).hostname;
  const storeHandle = hostname.split(".")[0];
  const name = storeHandle
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim();

  return name || DEFAULT_STORE_NAME;
}

function detail(label, value, options = {}) {
  return hasValue(value) && String(value).trim()
    ? { label, value: String(value), ...options }
    : null;
}

function compactDetails(details) {
  return details.filter(Boolean);
}

function buildEventContent(eventType, payload) {
  const orderReference = formatOrderReference(payload);
  const orderTotal = formatMoney(payload.orderTotal, payload.currencyCode);
  const points = formatPoints(payload.points);

  switch (eventType) {
    case "signup_bonus":
      return {
        category: "WELCOME BONUS",
        title: "Your rewards journey starts here",
        preheader: `${points} welcome points are ready in your account.`,
        intro:
          "Welcome to the loyalty program. We have added a bonus to get you started.",
        highlight: {
          value: `+${points}`,
          unit: "points",
          label: "Available now",
          tone: "positive",
        },
        details: [],
        note: "Keep earning points whenever you shop.",
        ctaLabel: "Visit store",
      };

    case "order_points":
      return {
        category: "POINTS EARNED",
        title: `${points} points were added to your account`,
        preheader: `You earned ${points} loyalty points from your order.`,
        intro:
          "Thanks for your order. Your new points are ready to use toward future rewards.",
        highlight: {
          value: `+${points}`,
          unit: "points",
          label: "Added to your balance",
          tone: "positive",
        },
        details: compactDetails([
          detail("Order", orderReference),
          detail("Order total", orderTotal),
        ]),
        note: "Keep shopping to unlock your next reward.",
        ctaLabel: "Visit store",
      };

    case "birthday_reward":
      return {
        category: "BIRTHDAY REWARD",
        title: "A birthday gift from us",
        preheader: `${points} birthday points are waiting in your account.`,
        intro:
          "Happy birthday! We added bonus points to your loyalty balance to help you celebrate.",
        highlight: {
          value: `+${points}`,
          unit: "points",
          label: "Birthday bonus",
          tone: "positive",
        },
        details: compactDetails([
          detail(
            "New balance",
            hasValue(payload.pointsBalanceAfter)
              ? `${formatPoints(payload.pointsBalanceAfter)} points`
              : "",
          ),
        ]),
        note: "Use your points whenever you are ready for your next reward.",
        ctaLabel: "View rewards",
      };

    case "special_date_reward": {
      const rewardHeading =
        String(payload.rewardHeading || "").trim() || "Special day reward";

      return {
        category: "SPECIAL REWARD",
        title: rewardHeading,
        preheader: `${points} special reward points are waiting in your account.`,
        intro:
          "We added special reward points to your loyalty balance to celebrate with you.",
        highlight: {
          value: `+${points}`,
          unit: "points",
          label: rewardHeading,
          tone: "positive",
        },
        details: compactDetails([
          detail(
            "New balance",
            hasValue(payload.pointsBalanceAfter)
              ? `${formatPoints(payload.pointsBalanceAfter)} points`
              : "",
          ),
        ]),
        note: "Use your points whenever you are ready for your next reward.",
        ctaLabel: "View rewards",
      };
    }

    case "reward_created": {
      const reward = rewardLabel(payload);
      const isStoreCredit = payload.rewardType === "store_credit";

      return {
        category: "REWARD READY",
        title: "Your loyalty reward is ready",
        preheader: `Your ${reward} is ready to use.`,
        intro:
          payload.rewardType === "store_credit"
            ? "Your store credit has been added and is ready for your next purchase."
            : "You turned your points into a reward. Use it on your next eligible purchase.",
        highlight: {
          value: reward,
          label: "Your reward",
          tone: "positive",
        },
        details: compactDetails([
          detail("Points used", `${formatPoints(payload.pointsUsed)} points`),
          detail("Valid until", formatDate(payload.expiresAt)),
        ]),
        rewardCode: isStoreCredit ? "" : payload.rewardCode || "",
        note: isStoreCredit
          ? "Your store credit is available automatically at checkout."
          : payload.rewardCode
            ? "Enter this code at checkout. Reward conditions may apply."
            : "Your reward is available in your loyalty account.",
        ctaLabel: "Shop with your reward",
      };
    }

    case "reward_applied": {
      const reward = rewardLabel(payload);

      return {
        category: "REWARD USED",
        title: "Your reward was applied successfully",
        preheader: "Your loyalty reward was applied to your order.",
        intro:
          "Your loyalty savings have been confirmed. Here is a summary for your records.",
        highlight: {
          value: reward,
          label: "Reward applied",
          tone: "positive",
        },
        details: compactDetails([
          detail("Order", orderReference),
          detail("Points used", `${formatPoints(payload.pointsUsed)} points`),
          detail("Order total", orderTotal),
        ]),
        note: "Thank you for putting your points to good use.",
        ctaLabel: "Visit store",
      };
    }

    case "refund_points": {
      const pointsReturned = hasValue(payload.pointsRefunded);
      const adjustedPoints = pointsReturned
        ? formatPoints(payload.pointsRefunded)
        : formatPoints(payload.pointsDeducted);

      return {
        category: pointsReturned ? "POINTS RETURNED" : "BALANCE UPDATED",
        title: pointsReturned
          ? "Points are back in your account"
          : "Your points balance was updated",
        preheader: pointsReturned
          ? `${adjustedPoints} points were returned after your refund.`
          : `${adjustedPoints} points were deducted after your refund.`,
        intro: pointsReturned
          ? "The points used on your refunded loyalty reward have been returned."
          : "We adjusted the points earned from your order to reflect the refund.",
        highlight: {
          value: `${pointsReturned ? "+" : "-"}${adjustedPoints}`,
          unit: "points",
          label: pointsReturned
            ? "Returned to your balance"
            : "Balance adjustment",
          tone: pointsReturned ? "positive" : "warning",
        },
        details: compactDetails([
          detail("Order", orderReference),
          detail(
            "Refund amount",
            formatMoney(payload.refundAmount, payload.currencyCode),
          ),
          detail(
            "Reward value",
            formatMoney(payload.discountAmount, payload.currencyCode),
          ),
        ]),
        note: "Your loyalty balance now reflects this refund.",
        ctaLabel: "Visit store",
      };
    }

    case "points_expiring_soon": {
      const expiringPoints = formatPoints(
        payload.pointsExpiring ?? payload.points,
      );

      return {
        category: "EXPIRY REMINDER",
        title: `${expiringPoints} points expire soon`,
        preheader: `Use your ${expiringPoints} points before they expire.`,
        intro:
          "There is still time to turn these points into a loyalty reward.",
        highlight: {
          value: expiringPoints,
          unit: "points",
          label: "Expiring soon",
          tone: "warning",
        },
        details: compactDetails([
          detail("Expiry date", formatDate(payload.expiresAt)),
        ]),
        note: "Redeem your points before the expiry date to keep their value.",
        ctaLabel: "Use your points",
      };
    }

    case "points_expired": {
      const expiredPoints = formatPoints(payload.pointsExpired);

      return {
        category: "POINTS UPDATE",
        title: `${expiredPoints} points have expired`,
        preheader: `${expiredPoints} loyalty points have expired.`,
        intro:
          "These points reached their expiry date and were removed from your balance.",
        highlight: {
          value: `-${expiredPoints}`,
          unit: "points",
          label: "Expired",
          tone: "warning",
        },
        details: compactDetails([
          detail(
            "Current balance",
            `${formatPoints(payload.pointsBalanceAfter)} points`,
          ),
          detail("Expired on", formatDate(payload.expiredAt)),
        ]),
        note: "New points can still be earned on eligible purchases.",
        ctaLabel: "Start earning again",
      };
    }

    case "referral_rewarded":
      return {
        category: "REFERRAL REWARD",
        title: `${points} referral points were added`,
        preheader: `You earned ${points} points from a successful referral.`,
        intro:
          payload.role === "advocate"
            ? "Your referral completed the qualifying action. Thanks for sharing the program."
            : "Your referral reward is now available in your loyalty account.",
        highlight: {
          value: `+${points}`,
          unit: "points",
          label: "Referral reward",
          tone: "positive",
        },
        details: [],
        note: "Keep sharing to earn more referral rewards.",
        ctaLabel: "Visit store",
      };

    case "referral_claimed":
      return {
        category: "REFERRAL UPDATE",
        title: "Your referral was claimed",
        preheader: "A friend joined through your referral.",
        intro:
          "Your referral has been recorded. Eligible rewards will be added after the qualifying action is complete.",
        highlight: {
          value: "Referral claimed",
          label: "Reward pending",
          tone: "neutral",
        },
        details: [],
        note: "We will let you know when your referral reward is ready.",
        ctaLabel: "Visit store",
      };

    default:
      return {
        category: "LOYALTY UPDATE",
        title: "There is an update to your loyalty account",
        preheader: "Your loyalty account has been updated.",
        intro: "Sign in to your store account to review the latest update.",
        highlight: {
          value: "Account updated",
          label: "Loyalty program",
          tone: "neutral",
        },
        details: [],
        note: "Thanks for being part of the loyalty program.",
        ctaLabel: "Visit store",
      };
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderDetails(details) {
  if (!details.length) {
    return "";
  }

  const rows = details
    .map(
      (item, index) => `
        <tr>
          <td style="padding:14px 0;${index < details.length - 1 ? "border-bottom:1px solid #e7ebe9;" : ""}font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#66736e;">
            ${escapeHtml(item.label)}
          </td>
          <td align="right" style="padding:14px 0 14px 20px;${index < details.length - 1 ? "border-bottom:1px solid #e7ebe9;" : ""}font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;font-weight:700;color:#1d2925;">
            ${escapeHtml(item.value)}
          </td>
        </tr>`,
    )
    .join("");

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 20px;">
      ${rows}
    </table>`;
}

function renderRewardCode(rewardCode) {
  if (!rewardCode) {
    return "";
  }

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 22px;background-color:#f5f7f6;border:1px dashed #9aa8a2;border-radius:6px;">
      <tr>
        <td align="center" style="padding:18px 20px;">
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:16px;font-weight:700;letter-spacing:0;color:#66736e;text-transform:uppercase;">Reward code</div>
          <div style="padding-top:5px;font-family:'Courier New',Courier,monospace;font-size:22px;line-height:28px;font-weight:700;letter-spacing:0;color:#173f35;word-break:break-all;">${escapeHtml(rewardCode)}</div>
        </td>
      </tr>
    </table>`;
}

function getHighlightColors(tone) {
  if (tone === "warning") {
    return {
      background: "#fff5e6",
      border: "#edcc96",
      value: "#8a4b08",
    };
  }

  if (tone === "neutral") {
    return {
      background: "#eef2f4",
      border: "#ccd5d9",
      value: "#34434a",
    };
  }

  return {
    background: "#eaf6ef",
    border: "#b9ddc7",
    value: "#116447",
  };
}

function buildHtml({ content, greeting, storeName, storeUrl }) {
  const colors = getHighlightColors(content.highlight.tone);
  const action = storeUrl
    ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:26px 0 4px;">
        <tr>
          <td bgcolor="#173f35" style="border-radius:6px;">
            <a href="${escapeHtml(storeUrl)}" target="_blank" style="display:inline-block;padding:13px 22px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(content.ctaLabel)}</a>
          </td>
        </tr>
      </table>`
    : "";
  const storeLink = storeUrl
    ? `<a href="${escapeHtml(storeUrl)}" target="_blank" style="color:#51615b;text-decoration:underline;">${escapeHtml(storeName)}</a>`
    : escapeHtml(storeName);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>${escapeHtml(content.title)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f2f5f3;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${escapeHtml(content.preheader)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f2f5f3">
      <tr>
        <td align="center" style="padding:32px 14px;">
          <div style="width:100%;max-width:600px;margin:0 auto;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;">
            <tr>
              <td style="padding:0 4px 14px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="font-family:Arial,Helvetica,sans-serif;font-size:18px;line-height:24px;font-weight:700;color:#173f35;">${escapeHtml(storeName)}</td>
                    <td align="right" style="font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:16px;font-weight:700;letter-spacing:0;color:#66736e;">LOYALTY REWARDS</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td bgcolor="#173f35" style="padding:32px 34px;background-color:#173f35;border-radius:8px 8px 0 0;">
                <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;font-weight:700;letter-spacing:0;color:#a9dec4;">${escapeHtml(content.category)}</div>
                <h1 style="margin:8px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:28px;line-height:36px;font-weight:700;color:#ffffff;">${escapeHtml(content.title)}</h1>
              </td>
            </tr>
            <tr>
              <td bgcolor="#ffffff" style="padding:32px 34px 34px;background-color:#ffffff;border:1px solid #dfe5e2;border-top:0;border-radius:0 0 8px 8px;">
                <p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:25px;color:#1d2925;">${escapeHtml(greeting)}</p>
                <p style="margin:0 0 24px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:25px;color:#45534e;">${escapeHtml(content.intro)}</p>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 20px;background-color:${colors.background};border:1px solid ${colors.border};border-radius:7px;">
                  <tr>
                    <td align="center" style="padding:22px 20px;">
                      <div style="font-family:Arial,Helvetica,sans-serif;font-size:30px;line-height:36px;font-weight:700;color:${colors.value};">${escapeHtml(content.highlight.value)}</div>
                      ${content.highlight.unit ? `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;font-weight:700;color:${colors.value};">${escapeHtml(content.highlight.unit)}</div>` : ""}
                      <div style="padding-top:5px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;font-weight:700;letter-spacing:0;text-transform:uppercase;color:#66736e;">${escapeHtml(content.highlight.label)}</div>
                    </td>
                  </tr>
                </table>

                ${renderDetails(content.details)}
                ${renderRewardCode(content.rewardCode)}

                <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#66736e;">${escapeHtml(content.note)}</p>
                ${action}
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:20px 24px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:19px;color:#72807b;">
                Thanks for being part of our loyalty program.<br>
                ${storeLink}<br>
                <span style="color:#909b97;">This transactional email was sent because of activity in your loyalty account.</span>
              </td>
            </tr>
          </table>
          </div>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildText({ content, greeting, storeName, storeUrl }) {
  const highlight = [content.highlight.value, content.highlight.unit]
    .filter(Boolean)
    .join(" ");
  const details = content.details
    .map((item) => `${item.label}: ${item.value}`)
    .join("\n");
  const sections = [
    greeting,
    `${content.title}\n${content.intro}`,
    `${highlight}\n${content.highlight.label}`,
    details,
    content.rewardCode ? `Reward code: ${content.rewardCode}` : "",
    content.note,
    storeUrl ? `${content.ctaLabel}: ${storeUrl}` : "",
    `Thanks for being part of our loyalty program.\n${storeName}`,
  ];

  return sections.filter(Boolean).join("\n\n");
}

function getTemplatePoints(payload) {
  return (
    payload.points ??
    payload.pointsExpiring ??
    payload.pointsExpired ??
    payload.pointsRefunded ??
    payload.pointsDeducted ??
    payload.pointsUsed ??
    0
  );
}

function buildTemplateVariables(notification, payload, storeName) {
  return {
    customer_name: notification.recipientName || "",
    store_name: storeName,
    points: formatPoints(getTemplatePoints(payload)),
    points_balance: hasValue(payload.pointsBalanceAfter)
      ? formatPoints(payload.pointsBalanceAfter)
      : "",
    order_number: formatOrderReference(payload),
    order_total: formatMoney(payload.orderTotal, payload.currencyCode),
    reward: rewardLabel(payload),
    reward_code:
      payload.rewardType === "store_credit" ? "" : payload.rewardCode || "",
    refund_amount: formatMoney(payload.refundAmount, payload.currencyCode),
    expiry_date: formatDate(payload.expiresAt || payload.expiredAt),
    reward_heading: String(payload.rewardHeading || "").trim(),
  };
}

function applyContentTemplate(content, template, variables) {
  if (!template || typeof template !== "object") {
    return content;
  }

  return {
    ...content,
    ...Object.fromEntries(
      ["title", "intro", "note", "ctaLabel"]
        .filter((field) => template[field])
        .map((field) => [
          field,
          renderEmailTemplate(template[field], variables),
        ]),
    ),
  };
}

export function buildLoyaltyEmailMessage(notification, options = {}) {
  const payload = notification?.payload || {};
  const storeUrl = getStoreUrl(payload.shopDomain);
  const storeName = getStoreName(payload.shopDomain);
  const greeting = notification.recipientName
    ? `Hi ${notification.recipientName},`
    : "Hi,";
  const templates = normalizeEmailTemplates(options.templates);
  const template = templates[notification.eventType] || {};
  const variables = buildTemplateVariables(notification, payload, storeName);
  const content = applyContentTemplate(
    buildEventContent(notification.eventType, payload),
    template,
    variables,
  );
  const customSubject = template.subject
    ? renderEmailTemplate(template.subject, variables).trim()
    : "";

  return {
    to: notification.recipientEmail,
    toName: notification.recipientName || undefined,
    subject: customSubject || notification.subject,
    text: buildText({ content, greeting, storeName, storeUrl }),
    html: buildHtml({ content, greeting, storeName, storeUrl }),
  };
}
