import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSendGridPayload,
  parseSendGridFromAddress,
} from "./email-sendgrid.shared.js";

test("parses a named SendGrid sender address", () => {
  assert.deepEqual(
    parseSendGridFromAddress('"Rewards Team" <rewards@example.com>'),
    {
      email: "rewards@example.com",
      name: "Rewards Team",
    },
  );
});

test("builds a SendGrid Mail Send payload with text and HTML content", () => {
  const payload = buildSendGridPayload(
    {
      to: "customer@example.com",
      toName: "Ada",
      subject: "You earned loyalty points",
      text: "You earned 100 points.",
      html: "<p>You earned 100 points.</p>",
    },
    "Rewards <rewards@example.com>",
  );

  assert.deepEqual(payload.personalizations, [
    {
      to: [{ email: "customer@example.com", name: "Ada" }],
      subject: "You earned loyalty points",
    },
  ]);
  assert.deepEqual(payload.from, {
    email: "rewards@example.com",
    name: "Rewards",
  });
  assert.deepEqual(payload.content, [
    { type: "text/plain", value: "You earned 100 points." },
    { type: "text/html", value: "<p>You earned 100 points.</p>" },
  ]);
});

test("rejects an invalid SendGrid sender address", () => {
  assert.throws(
    () => parseSendGridFromAddress("Rewards Team"),
    /EMAIL_FROM must be an email address/,
  );
});
