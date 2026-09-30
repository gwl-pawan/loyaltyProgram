import assert from "node:assert/strict";
import test from "node:test";

import {
  getSpecialDateRewardConfigurations,
  getSpecialDateRewardDueYear,
  normalizeSpecialDateSlot,
} from "./special-date-rewards.shared.js";

const settings = {
  birthdayRewardTimeZone: "UTC",
  specialDateRewardMinimumLeadDays: 30,
  specialDateReward1Enabled: true,
  specialDateReward1Heading: "Anniversary reward",
  specialDateReward1Points: 300,
  specialDateReward2Enabled: false,
  specialDateReward2Heading: "Another special day",
  specialDateReward2Points: 100,
};

test("accepts only the two configured special-date slots", () => {
  assert.equal(normalizeSpecialDateSlot("1"), 1);
  assert.equal(normalizeSpecialDateSlot(2), 2);
  assert.equal(normalizeSpecialDateSlot(3), null);
});

test("builds two customer-date reward configurations", () => {
  const rewards = getSpecialDateRewardConfigurations(settings);
  assert.equal(rewards.length, 2);
  assert.deepEqual(rewards[0], {
    slot: 1,
    enabled: true,
    heading: "Anniversary reward",
    points: 300,
    monthField: "specialDate1Month",
    dayField: "specialDate1Day",
    providedAtField: "specialDate1ProvidedAt",
    updatedAtField: "specialDate1UpdatedAt",
    lastIssuedYearField: "specialDateReward1LastIssuedYear",
    lastIssuedAtField: "specialDateReward1LastIssuedAt",
  });
  assert.equal(rewards[1].enabled, false);
});

test("uses the customer's selected date and lead time", () => {
  const reward = getSpecialDateRewardConfigurations(settings)[0];
  const eligibleCustomer = {
    specialDate1Month: 9,
    specialDate1Day: 30,
    specialDate1UpdatedAt: new Date("2026-08-01T00:00:00Z"),
    specialDateReward1LastIssuedYear: null,
  };

  assert.equal(
    getSpecialDateRewardDueYear({
      customer: eligibleCustomer,
      reward,
      settings,
      now: new Date("2026-09-30T12:00:00Z"),
    }),
    2026,
  );
  assert.equal(
    getSpecialDateRewardDueYear({
      customer: {
        ...eligibleCustomer,
        specialDate1UpdatedAt: new Date("2026-09-15T00:00:00Z"),
      },
      reward,
      settings,
      now: new Date("2026-09-30T12:00:00Z"),
    }),
    null,
  );
});

test("is annual, idempotent, and supports the recovery window", () => {
  const reward = getSpecialDateRewardConfigurations(settings)[0];
  const customer = {
    specialDate1Month: 9,
    specialDate1Day: 30,
    specialDate1UpdatedAt: new Date("2026-08-01T00:00:00Z"),
    specialDateReward1LastIssuedYear: null,
  };

  assert.equal(
    getSpecialDateRewardDueYear({
      customer,
      reward,
      settings,
      now: new Date("2026-10-07T12:00:00Z"),
    }),
    2026,
  );
  assert.equal(
    getSpecialDateRewardDueYear({
      customer,
      reward,
      settings,
      now: new Date("2026-10-08T12:00:00Z"),
    }),
    null,
  );
  assert.equal(
    getSpecialDateRewardDueYear({
      customer: { ...customer, specialDateReward1LastIssuedYear: 2026 },
      reward,
      settings,
      now: new Date("2026-09-30T12:00:00Z"),
    }),
    null,
  );
});
