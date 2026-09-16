import assert from "node:assert/strict";
import test from "node:test";

import {
  CUSTOMER_SEGMENTS,
  filterSegmentedCustomers,
  getSegmentCounts,
  segmentCustomers,
} from "./customer-segmentation.shared.js";

const now = new Date("2026-07-17T00:00:00Z");

function customer(overrides) {
  return {
    id: overrides.id,
    lifetimeSpend: overrides.lifetimeSpend || 0,
    createdAt: overrides.createdAt || "2026-07-01T00:00:00Z",
    lastActivityAt: overrides.lastActivityAt || null,
    lastOrderAt: overrides.lastOrderAt || null,
  };
}

test("classifies VIP, inactive, and top spender customers independently", () => {
  const segmented = segmentCustomers(
    [
      customer({
        id: 1,
        lifetimeSpend: 60000,
        lastActivityAt: "2026-07-01T00:00:00Z",
      }),
      customer({
        id: 2,
        lifetimeSpend: 45000,
        lastActivityAt: "2026-03-01T00:00:00Z",
      }),
      customer({
        id: 3,
        lifetimeSpend: 1000,
        lastActivityAt: "2026-07-10T00:00:00Z",
      }),
    ],
    {
      vipSpendThreshold: 50000,
      inactiveCustomerDays: 90,
      topSpenderPercent: 1,
    },
    now,
  );

  assert.deepEqual(segmented[0].segments.sort(), [
    CUSTOMER_SEGMENTS.TOP_SPENDER,
    CUSTOMER_SEGMENTS.VIP,
  ]);
  assert.deepEqual(segmented[1].segments, [CUSTOMER_SEGMENTS.INACTIVE]);
  assert.deepEqual(segmented[2].segments, []);
});

test("counts and filters segmented customers", () => {
  const segmented = segmentCustomers(
    [
      customer({ id: 1, lifetimeSpend: 250, lastActivityAt: "2026-07-01" }),
      customer({ id: 2, lifetimeSpend: 200, lastActivityAt: "2026-01-01" }),
      customer({ id: 3, lifetimeSpend: 0, lastActivityAt: "2026-07-01" }),
    ],
    {
      vipSpendThreshold: 225,
      inactiveCustomerDays: 90,
      topSpenderPercent: 50,
    },
    now,
  );

  assert.deepEqual(getSegmentCounts(segmented), {
    all: 3,
    vip: 1,
    inactive: 1,
    top_spender: 1,
  });
  assert.deepEqual(
    filterSegmentedCustomers(segmented, CUSTOMER_SEGMENTS.TOP_SPENDER).map(
      (item) => item.id,
    ),
    [1],
  );
});
