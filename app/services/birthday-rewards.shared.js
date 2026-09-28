const MONTH_LENGTHS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export const BIRTHDAY_REWARD_GRACE_DAYS = 7;

export function normalizeBirthday(value) {
  let month;
  let day;

  if (typeof value === "string") {
    const match = value.trim().match(/^(?:\d{4}-)?(\d{2})-(\d{2})$/);
    if (!match) return null;
    month = Number(match[1]);
    day = Number(match[2]);
  } else {
    month = Number(value?.month);
    day = Number(value?.day);
  }

  if (
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > MONTH_LENGTHS[month - 1]
  ) {
    return null;
  }

  return { month, day };
}

export function getBirthdaySubmissionStatus(customer, requestedBirthday) {
  const requested = normalizeBirthday(requestedBirthday);
  if (!requested) return "invalid";

  const existing = normalizeBirthday({
    month: customer?.birthMonth,
    day: customer?.birthDay,
  });
  const entryLocked = Boolean(existing || customer?.birthdayProvidedAt);

  if (!entryLocked) return "initial";
  if (
    existing?.month === requested.month &&
    existing?.day === requested.day
  ) {
    return "unchanged";
  }

  return "locked";
}

export function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function getBirthdayDateForYear(month, day, year) {
  const normalized = normalizeBirthday({ month, day });
  if (!normalized) return null;

  const adjustedDay =
    normalized.month === 2 && normalized.day === 29 && !isLeapYear(year)
      ? 28
      : normalized.day;

  return new Date(Date.UTC(year, normalized.month - 1, adjustedDay));
}

export function getDatePartsInTimeZone(date, timeZone = "UTC") {
  let formatter;

  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );

  return { year: parts.year, month: parts.month, day: parts.day };
}

export function daysBetweenCalendarDates(earlier, later) {
  const earlierUtc = Date.UTC(earlier.year, earlier.month - 1, earlier.day);
  const laterUtc = Date.UTC(later.year, later.month - 1, later.day);
  return Math.floor((laterUtc - earlierUtc) / 86_400_000);
}

export function getBirthdayRewardDueYear({
  customer,
  settings,
  now = new Date(),
}) {
  if (!settings?.birthdayRewardEnabled) return null;

  const birthday = normalizeBirthday({
    month: customer?.birthMonth,
    day: customer?.birthDay,
  });
  if (!birthday || !customer?.birthdayUpdatedAt) return null;

  const timeZone = settings.birthdayRewardTimeZone || "UTC";
  const today = getDatePartsInTimeZone(now, timeZone);
  let birthdayDate = getBirthdayDateForYear(
    birthday.month,
    birthday.day,
    today.year,
  );
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
  if (birthdayDate.getTime() > todayUtc) {
    birthdayDate = getBirthdayDateForYear(
      birthday.month,
      birthday.day,
      today.year - 1,
    );
  }
  const rewardYear = birthdayDate.getUTCFullYear();
  if (customer.birthdayRewardLastIssuedYear === rewardYear) return null;

  const birthdayParts = {
    year: birthdayDate.getUTCFullYear(),
    month: birthdayDate.getUTCMonth() + 1,
    day: birthdayDate.getUTCDate(),
  };
  const daysSinceBirthday = daysBetweenCalendarDates(birthdayParts, today);
  if (daysSinceBirthday < 0 || daysSinceBirthday > BIRTHDAY_REWARD_GRACE_DAYS) {
    return null;
  }

  const updatedParts = getDatePartsInTimeZone(
    new Date(customer.birthdayUpdatedAt),
    timeZone,
  );
  const leadDays = Math.max(
    0,
    Number(settings.birthdayRewardMinimumLeadDays) || 0,
  );

  return daysBetweenCalendarDates(updatedParts, birthdayParts) >= leadDays
    ? rewardYear
    : null;
}

export function isBirthdayRewardDue(input) {
  return getBirthdayRewardDueYear(input) !== null;
}

export function formatBirthday(month, day, locale = "en") {
  const date = getBirthdayDateForYear(month, day, 2000);
  if (!date) return "";

  return new Intl.DateTimeFormat(locale, {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}
