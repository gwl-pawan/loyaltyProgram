# Referral Links, Tracking, and Reward Issuance - Technical Report

Date: 2026-09-21

## Scope

Implemented and hardened the complete referral lifecycle: referral profiles and links, storefront attribution, authenticated claims, first-paid-order qualification, idempotent reward issuance, emails, merchant configuration, reporting, customer-facing surfaces, migrations, documentation, and automated tests.

## Database Changes

Updated `prisma/schema.prisma` with:

- `LoyaltySetting.referralAttributionDays`
- `Referral.expiresAt`
- shop/status/expiry lookup index
- shop-scoped visitor-token uniqueness

Added migration:

- `prisma/migrations/20260921120000_referral_production_readiness/migration.sql`

The migration adds the attribution window data, adds expiry tracking, adds the status/expiry index, and removes the redundant global visitor-token unique index. Visitor tokens remain unique inside each shop through the existing compound constraint.

The migration was successfully applied to the local MySQL development database using:

```bash
npm run setup
```

## Referral Services

### `app/services/referrals-core.server.js`

Provides the testable referral lifecycle:

- creates or returns a customer's referral profile
- generates collision-resistant referral codes
- tracks referral visits using shop-scoped visitor tokens
- freezes the configured expiry timestamp when the visit is tracked
- claims referrals for authenticated, eligible new customers
- rejects self-referrals, expired referrals, reused tokens, and existing customers
- recovers checkout attribution from private cart attributes on a paid order
- issues advocate and friend rewards inside a database transaction
- uses unique point-transaction idempotency keys
- moves referrals through `clicked`, `claimed`, `rewarded`, and `expired` states
- queues claim and reward emails using notification idempotency keys

### `app/services/referrals.server.js`

Connects the core lifecycle to Prisma, loyalty settings, referral-code helpers, and the email notification framework.

### `app/services/referrals-api.server.js`

Provides the app-proxy request handlers as injectable factories so authentication, trusted customer identity, request validation, and route behavior can be tested independently.

## API Security and Routes

### Shopify Theme/App Proxy

Updated:

- `app/routes/api.referrals.jsx`
- `app/routes/api.loyalty-balance.api.referrals.jsx`

Security behavior:

- validates requests through `authenticate.public.appProxy`
- derives the shop from Shopify's signed request
- uses signed `logged_in_customer_id` for profile and claim operations
- ignores browser-supplied customer and shop identities
- permits anonymous tracking only after app-proxy authentication

### Customer Account

Added:

- `app/routes/api.customer-account.referrals.jsx`
- `app/routes/api.loyalty-balance.api.customer-account.referrals.jsx`

The endpoint requires a Shopify Customer Account session token, verifies it server-side, and derives the customer and shop from the token claims.

### Hydrogen

Added:

- `app/routes/api.hydrogen.referrals.jsx`

The endpoint uses the existing protected Hydrogen API authentication and supports profile, track, and claim operations. Responses use private/no-store caching behavior.

## Storefront Attribution

Updated `extensions/loyalty-theme/assets/loyalty-points.js`.

Theme behavior:

- reads and normalizes `?ref=` links
- creates or reuses a visitor token
- tracks the referral through the authenticated app proxy
- stores the server-provided expiry time locally
- writes the visitor token to Shopify's `__loyalty_referral_token` private cart attribute through `/cart/update.js`
- removes expired attribution
- clears local and cart attribution after a successful claim

The private cart attribute allows the paid-order webhook to recover the referral when the visitor proceeds directly to checkout.

## Hydrogen Integration

Updated:

- `hydrogen-loyalty-storefront/app/lib/loyalty.js`
- `hydrogen-loyalty-storefront/app/root.jsx`
- `hydrogen-loyalty-storefront/app/routes/account.profile.jsx`

Hydrogen behavior:

- tracks referral links from the root loader
- stores the visitor token and expiry in the encrypted Hydrogen session
- claims pending attribution after customer authentication
- loads the authenticated customer's referral profile
- displays the referral link, reward terms, and successful-referral count in the account profile

## Customer Account Extension

Updated `extensions/loyalty-account/src/CustomerAccount.jsx`.

The extension now:

- obtains a fresh Shopify session token
- loads referral data through the authenticated Customer Account endpoint
- shows the referral link in a dedicated tab
- provides a clipboard copy control
- displays the number of successful referrals

## Merchant Admin

Added `app/routes/app.referrals.jsx` and a Referrals navigation item.

The dashboard provides:

- active/paused program state
- total link visits
- claims
- rewarded referrals
- conversion rate
- total referral points issued
- filters for clicked, claimed, rewarded, and expired referrals
- the latest 100 referral records

Updated `app/routes/app.settings.jsx` with referral enablement and attribution-window controls.

## Paid-Order Qualification

Removed `orders/create` from:

- `shopify.app.toml`
- `shopify.app.production.toml`
- dynamic webhook subscription configuration

`app/routes/webhooks.orders.create.jsx` now safely acknowledges stale webhook deliveries without awarding points. The `orders/paid` webhook is the only normal reward source, preventing points from being issued before payment.

## Tests Added and Updated

Added or expanded:

- `app/services/referrals-api.test.js`
- `app/services/referrals-core.test.js`

Coverage includes:

- app-proxy authentication failures
- trusted signed shop and customer identities
- ignoring spoofed request identities
- anonymous authenticated tracking
- logged-out claim/profile rejection
- full click-to-claim-to-paid-order lifecycle
- advocate and friend rewards
- reward and email idempotency
- disabled referral programs
- self-referral rejection
- existing-customer rejection
- direct-checkout cart attribution
- expired referral attribution
- referral-code normalization and generation

## Tests and Validation

Passed:

```bash
npx prisma generate
npx prisma validate
npm test
npm run typecheck
npm run build
cd hydrogen-loyalty-storefront && npm run build
git diff --check
```

Results:

- 31 tests passed with no failures.
- React Router type generation and TypeScript checks passed.
- Main application client and server production builds passed.
- Hydrogen client and Oxygen server production builds passed.
- Prisma schema validation passed.
- Local Prisma migration deployment passed, and the database is up to date.

Targeted ESLint validation reports an existing accessibility error and React hook dependency warning in `app/routes/app.settings.jsx` outside the referral additions. Customer Account validation reports existing Polaris/API typing issues in the broader component. The unsupported referral icon detected by that validator was removed.

## Documentation

Added:

- `docs/referrals.md`

The guide documents lifecycle states, settings, security, storefront surfaces, deployment requirements, and live QA checks.

## Remaining Operational Steps

- Deploy the app configuration and extensions so the webhook configuration and referral surfaces are updated.
- Run `prisma migrate deploy` in the production environment.
- Deploy the Hydrogen storefront with the API secret matching the loyalty app configuration.
- Confirm the Customer Account extension is published and placed on the intended account page.
- Run the live QA flow with a new referral visit, a separate new customer, and that customer's first paid order.
- Confirm each customer receives exactly one points credit and one applicable reward email.
- Retry the paid-order webhook and confirm no duplicate points or emails are created.
