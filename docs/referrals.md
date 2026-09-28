# Referral program

## Customer lifecycle

1. A signed-in customer receives a unique `?ref=CODE` sharing link.
2. The theme or Hydrogen storefront records the visit with a random visitor token.
3. Theme storefronts also persist the token as the private cart attribute `__loyalty_referral_token`.
4. The referral is claimed when the friend signs in. If they continue directly to checkout, the paid-order webhook can claim the cart attribution instead.
5. The friend must be a new customer and the referrer cannot refer themselves.
6. After the friend's first paid order, the app credits the configured points to both customers and marks the referral `rewarded`.
7. Point transactions and emails use unique idempotency keys, so webhook retries do not issue duplicate rewards.

## Referral statuses

| Status | Meaning |
| --- | --- |
| `clicked` | A valid referral link was visited. |
| `claimed` | The visit was associated with a new customer. |
| `rewarded` | The qualifying paid order credited both customers. |
| `expired` | The attribution window ended before qualification. |

## Merchant configuration

In **Settings → Point rules → Referrals**, merchants can:

- enable or pause the referral program;
- configure referrer points;
- configure friend points;
- configure the attribution window in days.

The **Referrals** admin page shows visit, claim, reward, expiration, conversion, and issued-point metrics plus the latest 100 referral records.

## Customer surfaces

- Theme app extension: link display, copy action, visit capture, sign-in claim, and private cart attribution.
- Customer Account extension: authenticated referral link and success count.
- Hydrogen example storefront: server-side visit capture, encrypted-session attribution, claim, and referral profile display.

## Deployment

Run the database migration before starting the new application version:

```bash
npm run setup
```

Deploy the Shopify app configuration so the removed `orders/create` subscription is reconciled. Referral and order rewards are issued only from `orders/paid`.

Required production variables remain:

- `DATABASE_URL`
- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SHOPIFY_APP_URL`
- `HYDROGEN_LOYALTY_API_TOKEN` when the Hydrogen storefront is enabled

## QA checklist

- Open a valid referral link in a clean browser and confirm one `clicked` record.
- Confirm the private referral token is attached to the cart.
- Sign in as the referrer and confirm self-referral is rejected.
- Sign in as an existing customer with an order and confirm the claim is rejected.
- Sign in as a new friend and confirm the status changes to `claimed`.
- Complete the friend's first paid order and confirm both point balances and point transactions.
- Replay the paid-order webhook and confirm balances do not change.
- Confirm the referrer receives claim and reward notifications and the friend receives a reward notification when enabled.
- Confirm stale visits move to `expired` and cannot earn rewards.
- Confirm the admin Referrals page and status filters show the expected records.
