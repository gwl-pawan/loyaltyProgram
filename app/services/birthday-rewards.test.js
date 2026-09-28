import assert from "node:assert/strict";
import test from "node:test";

import {
  getBirthdayDateForYear,
  getBirthdayRewardDueYear,
  getBirthdaySubmissionStatus,
  isBirthdayRewardDue,
  normalizeBirthday,
} from "./birthday-rewards.shared.js";

test("locks birthday changes after the first save while allowing retries", () => {
  assert.equal(
    getBirthdaySubmissionStatus(null, { month: 9, day: 28 }),
    "initial",
  );
  assert.equal(
    getBirthdaySubmissionStatus(
      {
        birthMonth: 9,
        birthDay: 28,
        birthdayProvidedAt: new Date("2026-09-28T00:00:00Z"),
      },
      { month: 9, day: 28 },
    ),
    "unchanged",
  );
  assert.equal(
    getBirthdaySubmissionStatus(
      {
        birthMonth: 9,
        birthDay: 28,
        birthdayProvidedAt: new Date("2026-09-28T00:00:00Z"),
      },
      { month: 10, day: 1 },
    ),
    "locked",
  );
  assert.equal(
    getBirthdaySubmissionStatus(
      {
        birthMonth: null,
        birthDay: null,
        birthdayProvidedAt: new Date("2026-09-28T00:00:00Z"),
      },
      { month: 10, day: 1 },
    ),
    "locked",
  );
});

test("normalizes a birthday while rejecting impossible dates", () => {
  assert.deepEqual(normalizeBirthday("1990-02-29"), { month: 2, day: 29 });
  assert.deepEqual(normalizeBirthday("12-31"), { month: 12, day: 31 });
  assert.equal(normalizeBirthday("2026-04-31"), null);
  assert.equal(normalizeBirthday({ month: 13, day: 1 }), null);
});

test("observes February 29 birthdays on February 28 in non-leap years", () => {
  assert.equal(
    getBirthdayDateForYear(2, 29, 2027).toISOString(),
    "2027-02-28T00:00:00.000Z",
  );
  assert.equal(
    getBirthdayDateForYear(2, 29, 2028).toISOString(),
    "2028-02-29T00:00:00.000Z",
  );
});

test("requires the configured lead time and issues only once per year", () => {
  const settings = {
    birthdayRewardEnabled: true,
    birthdayRewardMinimumLeadDays: 30,
    birthdayRewardTimeZone: "Asia/Kolkata",
  };
  const baseCustomer = {
    birthMonth: 9,
    birthDay: 24,
    birthdayUpdatedAt: new Date("2026-08-01T00:00:00Z"),
    birthdayRewardLastIssuedYear: null,
  };

  assert.equal(
    isBirthdayRewardDue({
      customer: baseCustomer,
      settings,
      now: new Date("2026-09-24T06:00:00Z"),
    }),
    true,
  );
  assert.equal(
    isBirthdayRewardDue({
      customer: { ...baseCustomer, birthdayRewardLastIssuedYear: 2026 },
      settings,
      now: new Date("2026-09-24T06:00:00Z"),
    }),
    false,
  );
  assert.equal(
    isBirthdayRewardDue({
      customer: {
        ...baseCustomer,
        birthdayUpdatedAt: new Date("2026-09-10T00:00:00Z"),
      },
      settings,
      now: new Date("2026-09-24T06:00:00Z"),
    }),
    false,
  );
});

test("the grace window recovers a recently missed birthday run", () => {
  assert.equal(
    isBirthdayRewardDue({
      customer: {
        birthMonth: 9,
        birthDay: 20,
        birthdayUpdatedAt: new Date("2026-01-01T00:00:00Z"),
      },
      settings: {
        birthdayRewardEnabled: true,
        birthdayRewardMinimumLeadDays: 0,
        birthdayRewardTimeZone: "UTC",
      },
      now: new Date("2026-09-24T12:00:00Z"),
    }),
    true,
  );
});

test("the grace window recovers a birthday across the new year", () => {
  assert.equal(
    getBirthdayRewardDueYear({
      customer: {
        birthMonth: 12,
        birthDay: 31,
        birthdayUpdatedAt: new Date("2026-01-01T00:00:00Z"),
      },
      settings: {
        birthdayRewardEnabled: true,
        birthdayRewardMinimumLeadDays: 0,
        birthdayRewardTimeZone: "UTC",
      },
      now: new Date("2027-01-02T12:00:00Z"),
    }),
    2026,
  );
});
