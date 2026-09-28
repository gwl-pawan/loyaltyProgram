function normalizeDisplayName(value) {
  const name = String(value || "").trim();

  if (name.startsWith('"') && name.endsWith('"')) {
    return name.slice(1, -1).trim();
  }

  return name;
}

export function parseSendGridFromAddress(value) {
  const configuredFrom = String(value || "").trim();
  const formattedAddress = configuredFrom.match(/^(.*)<([^<>]+)>$/);
  const email = String(
    formattedAddress ? formattedAddress[2] : configuredFrom,
  ).trim();
  const name = formattedAddress
    ? normalizeDisplayName(formattedAddress[1])
    : "";

  if (!email || !email.includes("@") || /[\s<>]/.test(email)) {
    throw new Error(
      'EMAIL_FROM must be an email address or use the format "Name <email@example.com>"',
    );
  }

  return name ? { email, name } : { email };
}

export function buildSendGridPayload(message, configuredFrom) {
  const recipient = {
    email: String(message.to || "").trim(),
  };
  const recipientName = String(message.toName || "").trim();

  if (recipientName) {
    recipient.name = recipientName;
  }

  return {
    personalizations: [
      {
        to: [recipient],
        subject: message.subject,
      },
    ],
    from: parseSendGridFromAddress(configuredFrom),
    content: [
      {
        type: "text/plain",
        value: message.text,
      },
      {
        type: "text/html",
        value: message.html,
      },
    ],
  };
}
