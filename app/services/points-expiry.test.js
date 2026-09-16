import assert from "node:assert/strict";
import test from "node:test";

import {
  addExpiryPeriod,
  calculateExpiredPointLots,
} from "./points-expiry.shared.js";

function transaction(overrides) {
  return {
    id: overrides.id,
    points: overrides.points,
    transactionType: overrides.transactionType,
    createdAt: new Date(overrides.createdAt),
    expiresAt: overrides.expiresAt ? new Date(overrides.expiresAt) : null,
    expiredAt: overrides.expiredAt ? new Date(overrides.expiredAt) : null,
  };
}

test("adds calendar-based expiry periods", () => {
  assert.equal(
    addExpiryPeriod(
      new Date("2026-01-15T00:00:00Z"),
      2,
      "months",
    ).toISOString(),
    "2026-03-15T00:00:00.000Z",
  );
  assert.equal(
    addExpiryPeriod(new Date("2026-01-15T00:00:00Z"), 10, "days").toISOString(),
    "2026-01-25T00:00:00.000Z",
  );
  assert.equal(
    addExpiryPeriod(
      new Date("2026-01-31T00:00:00Z"),
      1,
      "months",
    ).toISOString(),
    "2026-02-28T00:00:00.000Z",
  );
});

test("expires only the FIFO remainder of an earning lot", () => {
  const expired = calculateExpiredPointLots(
    [
      transaction({
        id: 1,
        points: 100,
        transactionType: "credit",
        createdAt: "2026-01-01T00:00:00Z",
        expiresAt: "2026-04-01T00:00:00Z",
      }),
      transaction({
        id: 2,
        points: 50,
        transactionType: "credit",
        createdAt: "2026-02-01T00:00:00Z",
        expiresAt: "2026-05-01T00:00:00Z",
      }),
      transaction({
        id: 3,
        points: 80,
        transactionType: "debit",
        createdAt: "2026-03-01T00:00:00Z",
      }),
    ],
    new Date("2026-04-02T00:00:00Z"),
  );

  assert.deepEqual(
    expired.map(({ sourceTransactionId, points }) => ({
      sourceTransactionId,
      points,
    })),
    [{ sourceTransactionId: 1, points: 20 }],
  );
});

test("does not expire points already consumed before their deadline", () => {
  const expired = calculateExpiredPointLots(
    [
      transaction({
        id: 1,
        points: 100,
        transactionType: "credit",
        createdAt: "2026-01-01T00:00:00Z",
        expiresAt: "2026-04-01T00:00:00Z",
      }),
      transaction({
        id: 2,
        points: 100,
        transactionType: "debit",
        createdAt: "2026-03-01T00:00:00Z",
      }),
    ],
    new Date("2026-04-02T00:00:00Z"),
  );

  assert.deepEqual(
    expired.map((item) => item.points),
    [0],
  );
});

test("a debit after expiry cannot consume an expired lot", () => {
  const expired = calculateExpiredPointLots(
    [
      transaction({
        id: 1,
        points: 100,
        transactionType: "credit",
        createdAt: "2026-01-01T00:00:00Z",
        expiresAt: "2026-03-01T00:00:00Z",
      }),
      transaction({
        id: 2,
        points: 60,
        transactionType: "credit",
        createdAt: "2026-02-01T00:00:00Z",
        expiresAt: "2026-06-01T00:00:00Z",
      }),
      transaction({
        id: 3,
        points: 50,
        transactionType: "debit",
        createdAt: "2026-04-01T00:00:00Z",
      }),
    ],
    new Date("2026-04-02T00:00:00Z"),
  );

  assert.deepEqual(
    expired.map(({ sourceTransactionId, points }) => ({
      sourceTransactionId,
      points,
    })),
    [{ sourceTransactionId: 1, points: 100 }],
  );
});

test("already finalized lots are not emitted again", () => {
  const expired = calculateExpiredPointLots(
    [
      transaction({
        id: 1,
        points: 100,
        transactionType: "credit",
        createdAt: "2026-01-01T00:00:00Z",
        expiresAt: "2026-03-01T00:00:00Z",
        expiredAt: "2026-03-01T01:00:00Z",
      }),
    ],
    new Date("2026-04-02T00:00:00Z"),
  );

  assert.deepEqual(expired, []);
});
