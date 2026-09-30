import {
  BIRTHDAY_REWARD_GRACE_DAYS,
  daysBetweenCalendarDates,
  getBirthdayDateForYear,
  getDatePartsInTimeZone,
  normalizeBirthday,
} from "./birthday-rewards.shared.js";

export const SPECIAL_DATE_REWARD_SLOTS = [1, 2];

export function normalizeSpecialDateSlot(value) {
  const slot = Number(value);
  return SPECIAL_DATE_REWARD_SLOTS.includes(slot) ? slot : null;
}

export function normalizeAnnualRewardDate(value) {
  const normalized = normalizeBirthday(value);
  return normalized
    ? `${String(normalized.month).padStart(2, "0")}-${String(normalized.day).padStart(2, "0")}`
    : null;
}

export function getSpecialDateRewardConfigurations(settings = {}) {
  return SPECIAL_DATE_REWARD_SLOTS.map((slot) => ({
    slot,
    enabled: settings[`specialDateReward${slot}Enabled`] === true,
    heading: String(settings[`specialDateReward${slot}Heading`] || "").trim(),
    points: Number(settings[`specialDateReward${slot}Points`] || 0),
    monthField: `specialDate${slot}Month`,
    dayField: `specialDate${slot}Day`,
    providedAtField: `specialDate${slot}ProvidedAt`,
    updatedAtField: `specialDate${slot}UpdatedAt`,
    lastIssuedYearField: `specialDateReward${slot}LastIssuedYear`,
    lastIssuedAtField: `specialDateReward${slot}LastIssuedAt`,
  }));
}

export function getSpecialDateRewardDueYear({
  customer,
  reward,
  settings,
  now = new Date(),
}) {
  if (
    !reward?.enabled ||
    !reward.heading ||
    !Number.isInteger(reward.points) ||
    reward.points <= 0
  ) {
    return null;
  }

  const date = normalizeBirthday({
    month: customer?.[reward.monthField],
    day: customer?.[reward.dayField],
  });
  const updatedAt = customer?.[reward.updatedAtField];
  if (!date || !updatedAt) return null;

  const timeZone = settings?.birthdayRewardTimeZone || "UTC";
  const today = getDatePartsInTimeZone(now, timeZone);
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
  let rewardDate = getBirthdayDateForYear(date.month, date.day, today.year);

  if (rewardDate.getTime() > todayUtc) {
    rewardDate = getBirthdayDateForYear(date.month, date.day, today.year - 1);
  }

  const rewardDateParts = {
    year: rewardDate.getUTCFullYear(),
    month: rewardDate.getUTCMonth() + 1,
    day: rewardDate.getUTCDate(),
  };
  if (customer?.[reward.lastIssuedYearField] === rewardDateParts.year) {
    return null;
  }

  const daysSinceRewardDate = daysBetweenCalendarDates(rewardDateParts, today);
  if (
    daysSinceRewardDate < 0 ||
    daysSinceRewardDate > BIRTHDAY_REWARD_GRACE_DAYS
  ) {
    return null;
  }

  const updatedParts = getDatePartsInTimeZone(new Date(updatedAt), timeZone);
  const leadDays = Math.max(
    0,
    Number(settings?.specialDateRewardMinimumLeadDays) || 0,
  );
  return daysBetweenCalendarDates(updatedParts, rewardDateParts) >= leadDays
    ? rewardDateParts.year
    : null;
}
