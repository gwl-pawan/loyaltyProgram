import assert from "node:assert/strict";
import test from "node:test";

import { createReferralCode, normalizeReferralCode } from "./referrals.shared.js";

test("normalizes referral codes from shared links", () => {
  assert.equal(normalizeReferralCode(" ab-cd 234 "), "ABCD234");
});

test("creates unambiguous referral codes", () => {
  const code = createReferralCode();
  assert.match(code, /^[A-HJ-NP-Z2-9]{10}$/);
});
