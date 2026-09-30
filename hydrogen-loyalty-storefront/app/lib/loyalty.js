import {LOYALTY_APP_URL as GENERATED_LOYALTY_APP_URL} from './loyalty-app-url.generated';

async function getLoyaltyConfig(context) {
  const env = context?.env || {};
  const apiBaseUrl = firstEnvValue(
    env.LOYALTY_APP_URL,
    globalThis.process?.env?.LOYALTY_APP_URL,
    GENERATED_LOYALTY_APP_URL,
  )?.replace(/\/$/, '');
  const apiToken = firstEnvValue(
    env.HYDROGEN_LOYALTY_API_TOKEN,
    env.LOYALTY_HYDROGEN_API_TOKEN,
    globalThis.process?.env?.HYDROGEN_LOYALTY_API_TOKEN,
    globalThis.process?.env?.LOYALTY_HYDROGEN_API_TOKEN,
  );
  const shopDomain = firstEnvValue(
    env.PUBLIC_STORE_DOMAIN,
    globalThis.process?.env?.PUBLIC_STORE_DOMAIN,
  );

  if (!apiBaseUrl || !apiToken || !shopDomain) {
    throw new Error('Loyalty integration is not configured.');
  }

  return {apiBaseUrl, apiToken, shopDomain};
}

async function fetchLoyaltyJson(context, path, init = {}) {
  const {apiBaseUrl, apiToken} = await getLoyaltyConfig(context);
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.success) {
    throw new Error(data?.message || 'Loyalty request failed.');
  }

  return data;
}

export async function loadLoyaltyBalance(context, customerId, options = {}) {
  const {shopDomain} = await getLoyaltyConfig(context);
  const params = new URLSearchParams({
    customerId,
    shop: shopDomain,
  });

  if (options.surface) {
    params.set('surface', options.surface);
  }

  return fetchLoyaltyJson(context, `/api/hydrogen/loyalty-balance?${params}`);
}

export async function loadLoyaltyHistory(context, customerId) {
  const {shopDomain} = await getLoyaltyConfig(context);
  const params = new URLSearchParams({
    customerId,
    shop: shopDomain,
  });

  return fetchLoyaltyJson(
    context,
    `/api/hydrogen/customer-reward-history?${params}`,
  );
}

export async function loadReferralProfile(context, customerId) {
  const {shopDomain} = await getLoyaltyConfig(context);
  const params = new URLSearchParams({customerId, shop: shopDomain});

  return fetchLoyaltyJson(context, `/api/hydrogen/referrals?${params}`);
}

export async function loadBirthdayProfile(context, customerId) {
  const {shopDomain} = await getLoyaltyConfig(context);
  const params = new URLSearchParams({customerId, shop: shopDomain});

  return fetchLoyaltyJson(context, `/api/hydrogen/birthday?${params}`);
}

export async function saveBirthdayProfile(context, customerId, birthday) {
  const {shopDomain} = await getLoyaltyConfig(context);

  return fetchLoyaltyJson(context, '/api/hydrogen/birthday', {
    method: 'POST',
    body: JSON.stringify({shop: shopDomain, customerId, birthday}),
  });
}

export async function deleteBirthdayProfile(context, customerId) {
  const {shopDomain} = await getLoyaltyConfig(context);

  return fetchLoyaltyJson(context, '/api/hydrogen/birthday', {
    method: 'DELETE',
    body: JSON.stringify({shop: shopDomain, customerId, action: 'delete'}),
  });
}

export async function loadSpecialDateProfile(context, customerId) {
  const {shopDomain} = await getLoyaltyConfig(context);
  const params = new URLSearchParams({customerId, shop: shopDomain});
  return fetchLoyaltyJson(context, `/api/hydrogen/special-dates?${params}`);
}

export async function saveSpecialDateProfile(context, customerId, slot, date) {
  const {shopDomain} = await getLoyaltyConfig(context);
  return fetchLoyaltyJson(context, '/api/hydrogen/special-dates', {
    method: 'POST',
    body: JSON.stringify({shop: shopDomain, customerId, slot, date}),
  });
}

export async function deleteSpecialDateProfile(context, customerId, slot) {
  const {shopDomain} = await getLoyaltyConfig(context);
  return fetchLoyaltyJson(context, '/api/hydrogen/special-dates', {
    method: 'DELETE',
    body: JSON.stringify({
      shop: shopDomain,
      customerId,
      slot,
      action: 'delete',
    }),
  });
}

export async function trackReferralVisit(
  context,
  {code, visitorToken, landingUrl},
) {
  const {shopDomain} = await getLoyaltyConfig(context);

  return fetchLoyaltyJson(context, '/api/hydrogen/referrals', {
    method: 'POST',
    body: JSON.stringify({
      action: 'track',
      shop: shopDomain,
      code,
      visitorToken,
      landingUrl,
    }),
  });
}

export async function claimReferralVisit(context, customerId, visitorToken) {
  const {shopDomain} = await getLoyaltyConfig(context);

  return fetchLoyaltyJson(context, '/api/hydrogen/referrals', {
    method: 'POST',
    body: JSON.stringify({
      action: 'claim',
      shop: shopDomain,
      customerId,
      visitorToken,
    }),
  });
}

export async function redeemLoyaltyReward(context, customerId, reward) {
  const {shopDomain} = await getLoyaltyConfig(context);

  return fetchLoyaltyJson(context, '/api/hydrogen/redeem-points', {
    method: 'POST',
    body: JSON.stringify({
      customerId,
      shop: shopDomain,
      pointsToRedeem: Number(reward.points),
      rewardType: reward.type || 'discount',
      appliedDiscountCodes: reward.appliedDiscountCodes,
      allowPendingRewardCheckout: reward.allowPendingRewardCheckout,
    }),
  });
}

function firstEnvValue(...values) {
  return values
    .find((value) => typeof value === 'string' && value.trim())
    ?.trim();
}

export async function loadCustomerId(customerAccount) {
  if (!(await customerAccount.isLoggedIn())) {
    return null;
  }

  const {data, errors} = await customerAccount.query(CUSTOMER_ID_QUERY, {
    variables: {
      language: customerAccount.i18n.language,
    },
  });

  if (errors?.length || !data?.customer?.id) {
    return null;
  }

  return data.customer.id;
}

const CUSTOMER_ID_QUERY = `
  query LoyaltyCustomerId($language: LanguageCode) @inContext(language: $language) {
    customer {
      id
    }
  }
`;
