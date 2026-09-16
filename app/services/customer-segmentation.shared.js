export const CUSTOMER_SEGMENTS = {
  ALL: "all",
  VIP: "vip",
  INACTIVE: "inactive",
  TOP_SPENDER: "top_spender",
};

export const CUSTOMER_SEGMENT_LABELS = {
  [CUSTOMER_SEGMENTS.ALL]: "All customers",
  [CUSTOMER_SEGMENTS.VIP]: "VIP customers",
  [CUSTOMER_SEGMENTS.INACTIVE]: "Inactive customers",
  [CUSTOMER_SEGMENTS.TOP_SPENDER]: "Top spenders",
};

export const DEFAULT_SEGMENTATION_RULES = {
  vipSpendThreshold: 50000,
  inactiveCustomerDays: 90,
  topSpenderPercent: 10,
};

function toNumber(value, fallback) {
  const numericValue = Number(value);

  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function toDate(value) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function getCustomerSpend(customer) {
  const spend = Number(customer?.lifetimeSpend || 0);

  return Number.isFinite(spend) ? spend : 0;
}

function getTopSpenderIds(customers, rules) {
  const positiveSpenders = customers
    .filter((customer) => getCustomerSpend(customer) > 0)
    .sort((left, right) => {
      const spendDifference = getCustomerSpend(right) - getCustomerSpend(left);

      return spendDifference || Number(left.id || 0) - Number(right.id || 0);
    });

  if (positiveSpenders.length === 0) {
    return new Set();
  }

  const topCount = Math.max(
    1,
    Math.ceil((positiveSpenders.length * rules.topSpenderPercent) / 100),
  );
  const cutoffSpend = getCustomerSpend(
    positiveSpenders[Math.min(topCount, positiveSpenders.length) - 1],
  );

  return new Set(
    positiveSpenders
      .filter((customer) => getCustomerSpend(customer) >= cutoffSpend)
      .map((customer) => customer.id),
  );
}

export function normalizeSegmentationRules(settings = {}) {
  const vipSpendThreshold = Math.max(
    0,
    toNumber(
      settings.vipSpendThreshold,
      DEFAULT_SEGMENTATION_RULES.vipSpendThreshold,
    ),
  );
  const inactiveCustomerDays = Math.max(
    1,
    Math.round(
      toNumber(
        settings.inactiveCustomerDays,
        DEFAULT_SEGMENTATION_RULES.inactiveCustomerDays,
      ),
    ),
  );
  const topSpenderPercent = Math.min(
    100,
    Math.max(
      1,
      Math.round(
        toNumber(
          settings.topSpenderPercent,
          DEFAULT_SEGMENTATION_RULES.topSpenderPercent,
        ),
      ),
    ),
  );

  return {
    vipSpendThreshold,
    inactiveCustomerDays,
    topSpenderPercent,
  };
}

export function normalizeSegmentFilter(value) {
  return Object.values(CUSTOMER_SEGMENTS).includes(value)
    ? value
    : CUSTOMER_SEGMENTS.ALL;
}

export function getCustomerActivityDate(customer) {
  return (
    toDate(customer?.lastActivityAt) ||
    toDate(customer?.lastOrderAt) ||
    toDate(customer?.createdAt)
  );
}

export function getCustomerSegments(customer, topSpenderIds, rules, now) {
  const segments = [];
  const activityDate = getCustomerActivityDate(customer);
  const inactiveBefore = new Date(now);

  inactiveBefore.setDate(
    inactiveBefore.getDate() - rules.inactiveCustomerDays,
  );

  if (getCustomerSpend(customer) >= rules.vipSpendThreshold) {
    segments.push(CUSTOMER_SEGMENTS.VIP);
  }

  if (activityDate && activityDate <= inactiveBefore) {
    segments.push(CUSTOMER_SEGMENTS.INACTIVE);
  }

  if (topSpenderIds.has(customer.id)) {
    segments.push(CUSTOMER_SEGMENTS.TOP_SPENDER);
  }

  return segments;
}

export function segmentCustomers(customers, settings, now = new Date()) {
  const rules = normalizeSegmentationRules(settings);
  const topSpenderIds = getTopSpenderIds(customers, rules);

  return customers.map((customer) => ({
    ...customer,
    segments: getCustomerSegments(customer, topSpenderIds, rules, now),
  }));
}

export function filterSegmentedCustomers(customers, segment) {
  const normalizedSegment = normalizeSegmentFilter(segment);

  if (normalizedSegment === CUSTOMER_SEGMENTS.ALL) {
    return customers;
  }

  return customers.filter((customer) =>
    customer.segments?.includes(normalizedSegment),
  );
}

export function getSegmentCounts(customers) {
  return {
    [CUSTOMER_SEGMENTS.ALL]: customers.length,
    [CUSTOMER_SEGMENTS.VIP]: customers.filter((customer) =>
      customer.segments?.includes(CUSTOMER_SEGMENTS.VIP),
    ).length,
    [CUSTOMER_SEGMENTS.INACTIVE]: customers.filter((customer) =>
      customer.segments?.includes(CUSTOMER_SEGMENTS.INACTIVE),
    ).length,
    [CUSTOMER_SEGMENTS.TOP_SPENDER]: customers.filter((customer) =>
      customer.segments?.includes(CUSTOMER_SEGMENTS.TOP_SPENDER),
    ).length,
  };
}
