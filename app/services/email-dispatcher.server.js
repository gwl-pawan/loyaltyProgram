import prisma from "../db.server";
import { buildLoyaltyEmailMessage } from "./email-message.shared";
import { buildSendGridPayload } from "./email-sendgrid.shared";
import { logError } from "./errors.server";

export const EMAIL_NOTIFICATION_STATUS = {
  PENDING: "pending",
  SENDING: "sending",
  SENT: "sent",
  FAILED: "failed",
};

const LOG_EMAIL_PROVIDER = "log";
const RESEND_EMAIL_PROVIDER = "resend";
const SENDGRID_EMAIL_PROVIDER = "sendgrid";

function getEmailProvider() {
  return String(process.env.EMAIL_PROVIDER || LOG_EMAIL_PROVIDER)
    .trim()
    .toLowerCase();
}

function getEmailFromAddress() {
  return String(process.env.EMAIL_FROM || "").trim();
}

async function sendWithLogProvider(notification, message) {
  const providerId = `log:${notification.id}:${Date.now()}`;

  console.info("[email-dispatcher] Loyalty email", {
    providerId,
    notificationId: notification.id,
    eventType: notification.eventType,
    to: message.to,
    subject: message.subject,
  });

  return {
    provider: LOG_EMAIL_PROVIDER,
    providerId,
  };
}

async function parseProviderResponse(response) {
  const text = await response.text();

  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text || null;
  }
}

async function sendWithResendProvider(message) {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  const from = getEmailFromAddress();

  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not configured");
  }

  if (!from) {
    throw new Error("EMAIL_FROM is not configured");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
  });
  const result = await parseProviderResponse(response);

  if (!response.ok) {
    const message =
      typeof result === "object" && result?.message
        ? result.message
        : `Resend request failed with status ${response.status}`;

    throw new Error(message);
  }

  return {
    provider: RESEND_EMAIL_PROVIDER,
    providerId:
      typeof result === "object" && result?.id
        ? result.id
        : `resend:${Date.now()}`,
  };
}

function getSendGridErrorMessage(result, status) {
  if (Array.isArray(result?.errors)) {
    const messages = result.errors
      .map((error) => error?.message)
      .filter(Boolean);

    if (messages.length > 0) {
      return messages.join("; ");
    }
  }

  return `SendGrid request failed with status ${status}`;
}

async function sendWithSendGridProvider(message) {
  const apiKey = String(process.env.SENDGRID_API_KEY || "").trim();
  const from = getEmailFromAddress();

  if (!apiKey) {
    throw new Error("SENDGRID_API_KEY is not configured");
  }

  if (!from) {
    throw new Error("EMAIL_FROM is not configured");
  }

  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildSendGridPayload(message, from)),
  });
  const result = await parseProviderResponse(response);

  if (!response.ok) {
    throw new Error(getSendGridErrorMessage(result, response.status));
  }

  return {
    provider: SENDGRID_EMAIL_PROVIDER,
    providerId:
      response.headers.get("x-message-id") || `sendgrid:${Date.now()}`,
  };
}

export async function sendLoyaltyEmail(notification) {
  const settings = await prisma.emailNotificationSetting.findUnique({
    where: { shopId: notification.shopId },
    select: { templates: true },
  });
  const message = buildLoyaltyEmailMessage(notification, {
    templates: settings?.templates,
  });
  const provider = getEmailProvider();

  if (provider === RESEND_EMAIL_PROVIDER) {
    return sendWithResendProvider(message);
  }

  if (provider === SENDGRID_EMAIL_PROVIDER) {
    return sendWithSendGridProvider(message);
  }

  if (provider !== LOG_EMAIL_PROVIDER) {
    throw new Error(`Unsupported email provider: ${provider}`);
  }

  return sendWithLogProvider(notification, message);
}

async function claimPendingNotification(notificationId) {
  const claimed = await prisma.emailNotification.updateMany({
    where: {
      id: notificationId,
      status: EMAIL_NOTIFICATION_STATUS.PENDING,
    },
    data: {
      status: EMAIL_NOTIFICATION_STATUS.SENDING,
      errorMessage: null,
    },
  });

  return claimed.count > 0;
}

export async function dispatchEmailNotification(notification) {
  const claimed = await claimPendingNotification(notification.id);

  if (!claimed) {
    return {
      status: "skipped",
      reason: "not_pending",
      notificationId: notification.id,
    };
  }

  try {
    const providerResult = await sendLoyaltyEmail(notification);
    const sentNotification = await prisma.emailNotification.update({
      where: {
        id: notification.id,
      },
      data: {
        status: EMAIL_NOTIFICATION_STATUS.SENT,
        provider: providerResult.provider,
        providerId: providerResult.providerId,
        sentAt: new Date(),
        errorMessage: null,
      },
    });

    return {
      status: "sent",
      notification: sentNotification,
    };
  } catch (error) {
    logError("email-dispatcher:send", error, {
      notificationId: notification.id,
      eventType: notification.eventType,
    });

    const failedNotification = await prisma.emailNotification.update({
      where: {
        id: notification.id,
      },
      data: {
        status: EMAIL_NOTIFICATION_STATUS.FAILED,
        errorMessage: error?.message || "Email dispatch failed",
      },
    });

    return {
      status: "failed",
      notification: failedNotification,
      error,
    };
  }
}

export async function dispatchPendingEmailNotifications({ limit = 25 } = {}) {
  const normalizedLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const notifications = await prisma.emailNotification.findMany({
    where: {
      status: EMAIL_NOTIFICATION_STATUS.PENDING,
    },
    orderBy: {
      createdAt: "asc",
    },
    take: normalizedLimit,
  });
  const summary = {
    requested: normalizedLimit,
    found: notifications.length,
    sent: 0,
    failed: 0,
    skipped: 0,
    results: [],
  };

  for (const notification of notifications) {
    const result = await dispatchEmailNotification(notification);

    if (result.status === "sent") summary.sent += 1;
    else if (result.status === "failed") summary.failed += 1;
    else summary.skipped += 1;

    summary.results.push({
      notificationId: notification.id,
      eventType: notification.eventType,
      status: result.status,
      reason: result.reason,
    });
  }

  return summary;
}
