import assert from "node:assert/strict";
import test from "node:test";

import { coordinateLoyaltyEmailDelivery } from "./email-delivery.shared.js";

test("immediately dispatches a newly queued loyalty email", async () => {
  const notification = {
    id: 42,
    status: "pending",
    eventType: "order_points",
  };
  let dispatchedNotification;

  const result = await coordinateLoyaltyEmailDelivery(
    { eventType: "order_points" },
    {
      queue: async () => ({ status: "queued", notification }),
      dispatch: async (value) => {
        dispatchedNotification = value;
        return { status: "sent", notification: value };
      },
    },
  );

  assert.equal(dispatchedNotification, notification);
  assert.equal(result.status, "queued");
  assert.equal(result.delivery.status, "sent");
});

test("recovers an existing notification that is still pending", async () => {
  let dispatchCount = 0;

  const result = await coordinateLoyaltyEmailDelivery(
    { eventType: "order_points" },
    {
      queue: async () => ({
        status: "existing",
        notification: { id: 42, status: "pending" },
      }),
      dispatch: async () => {
        dispatchCount += 1;
        return { status: "sent" };
      },
    },
  );

  assert.equal(dispatchCount, 1);
  assert.equal(result.delivery.status, "sent");
});

test("does not send an existing notification twice", async () => {
  let dispatchCount = 0;

  const result = await coordinateLoyaltyEmailDelivery(
    { eventType: "order_points" },
    {
      queue: async () => ({
        status: "existing",
        notification: { id: 42, status: "sent" },
      }),
      dispatch: async () => {
        dispatchCount += 1;
        return { status: "sent" };
      },
    },
  );

  assert.equal(dispatchCount, 0);
  assert.equal(result.delivery.status, "skipped");
  assert.equal(result.delivery.reason, "already_sent");
});
