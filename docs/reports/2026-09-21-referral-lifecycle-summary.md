# Referral Links, Tracking, and Reward Issuance - Work Summary

Date: 2026-09-21

## Overview

Completed the referral program lifecycle across the Shopify theme, Customer Account extension, Hydrogen storefront, backend services, and merchant admin. Referral visits can now be securely attributed, claimed by eligible new customers, and rewarded once after the referred customer's first paid order.

## Completed Work

- Hardened the storefront referral API with Shopify app-proxy authentication.
- Used the signed Shopify customer identity instead of customer or shop IDs supplied by the browser.
- Added authenticated referral endpoints for Hydrogen and Customer Account surfaces.
- Added referral-code generation and customer share links.
- Added visitor-token tracking with a configurable attribution window.
- Stored referral attribution in Shopify's private cart attribute so it survives checkout.
- Added automatic referral claiming after customer login or account creation.
- Added paid-order fallback claiming when checkout happens before an explicit claim.
- Added transactional and idempotent point issuance for the advocate and referred friend.
- Added protection against self-referrals, existing-customer claims, expired attribution, repeat claims, and duplicate rewards.
- Added referral claimed and referral rewarded email events.
- Added referral controls to the merchant Settings page.
- Added an Admin Referrals dashboard with status filters, conversion totals, and points issued.
- Added referral information and share controls to the Customer Account extension and Hydrogen account profile.
- Removed loyalty reward processing from `orders/create`; rewards are now issued from `orders/paid` only.
- Added referral lifecycle and API tests.
- Added referral operations and QA documentation.

## Merchant Settings Added

The Settings page now supports:

- Referral program enable/disable toggle
- Advocate reward points
- Referred-friend reward points
- Referral attribution window in days

## Referral Lifecycle

1. An existing customer obtains and shares their referral link.
2. A visitor opens the link and receives a shop-scoped visitor token.
3. Attribution is stored locally and in the Shopify cart as a private attribute.
4. The new customer claims the referral after authentication, or the paid-order webhook claims it from checkout attribution.
5. The customer's first paid order qualifies the referral.
6. Advocate and friend points are issued once, and reward emails are queued and dispatched.

## Validation

Passed:

```bash
npx prisma validate
npm test
npm run typecheck
npm run build
```

Additional validation:

- 31 automated tests passed.
- Hydrogen production build passed.
- Prisma migration was applied successfully to the local development database.
- The local database migration status is up to date.
- Git diff whitespace validation passed.

Targeted lint still reports one accessibility error and one React hook warning in existing Settings/email UI code outside the referral additions. Customer Account component validation also reports existing component/API typing issues; the referral-specific unsupported icon found during validation was removed.

## Current Status

The implementation and local verification are complete. Production rollout still requires deploying the app configuration and extensions, applying the migration in the target environment, deploying Hydrogen with the matching API secret, and running the documented live-store referral QA scenario with fresh customers and a first paid order.
