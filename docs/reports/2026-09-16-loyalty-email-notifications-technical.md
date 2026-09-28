# Loyalty Email Notification Framework - Technical Report

Date: 2026-09-16

## Scope

Built a native app-side email notification framework for the loyalty system. The implementation covers schema, defaults, queueing, event integration, dispatching, provider abstraction, admin settings, documentation, and validation.

## Database Changes

Updated `prisma/schema.prisma` with:

- `EmailNotificationSetting`
- `EmailNotification`
- Relations from `Shop`
- Relation from `Customer`

Added migration:

- `prisma/migrations/20260916120000_email_notification_models/migration.sql`

The notification table supports:

- event type
- recipient email/name
- subject
- JSON payload
- status tracking
- provider metadata
- error message
- unique idempotency key

Note: `npx prisma migrate dev` was blocked by an older migration that does not replay cleanly in the shadow database. The new SQL migration was added manually using the repo's existing MySQL migration style.

## Services Added

### `app/services/email-notifications.shared.js`

Shared default notification settings safe for client imports.

### `app/services/email-notifications.server.js`

Provides:

- `LOYALTY_EMAIL_EVENTS`
- `DEFAULT_EMAIL_NOTIFICATION_SETTINGS`
- `getEmailNotificationSettings(shopId)`
- `queueLoyaltyEmail(...)`
- `tryQueueLoyaltyEmail(...)`

Queue behavior:

- validates shop, event type, recipient email, subject, and idempotency key
- checks global and event-specific merchant settings
- writes `EmailNotification` rows with `pending` status
- returns `queued`, `existing`, or `skipped`
- catches queue errors through `tryQueueLoyaltyEmail`

### `app/services/email-message.shared.js`

Builds text and HTML email messages from notification event type and payload.

### `app/services/email-dispatcher.server.js`

Provides:

- `EMAIL_NOTIFICATION_STATUS`
- `sendLoyaltyEmail(notification)`
- `dispatchEmailNotification(notification)`
- `dispatchPendingEmailNotifications({ limit })`

Dispatcher behavior:

- claims `pending` rows by switching them to `sending`
- sends through selected provider
- marks rows as `sent` with provider metadata
- marks rows as `failed` with error details

Providers:

- `log`: development provider, writes a server log and marks sent
- `resend`: production provider using `fetch` against Resend's email API

## Routes Added

### `app/routes/api.email-notifications.dispatch.jsx`

Protected endpoint:

```http
POST /api/email-notifications/dispatch
Authorization: Bearer YOUR_EMAIL_DISPATCH_SECRET
Content-Type: application/json

{"limit": 25}
```

Also supports:

```http
x-email-dispatch-secret: YOUR_EMAIL_DISPATCH_SECRET
```

Responses:

- `503` when `EMAIL_DISPATCH_SECRET` is missing
- `401` when unauthorized
- `200` with dispatch summary when successful
- `500` when dispatch fails unexpectedly

## Loyalty Event Integrations

Email queueing was added to:

- `app/services/loyalty.server.js`
  - signup bonus
- `app/services/order-points.server.js`
  - order points earned
  - discount reward applied
  - gift card reward applied
- `app/routes/api.redeem-points.jsx`
  - reward created
- `app/routes/webhooks.refunds.create.jsx`
  - refund point deduction
  - reward points returned
- `app/services/points-expiry.server.js`
  - points expired
- `app/services/referrals.server.js`
  - advocate referral reward
  - friend referral reward

All event integrations use idempotency keys to prevent duplicate notifications from webhook retries or repeated processing.

## Admin Settings UI

Updated `app/routes/app.settings.jsx`.

Added loader/action support for `EmailNotificationSetting`.

Added Settings page controls:

- master loyalty emails toggle
- signup bonus toggle
- order points toggle
- reward created toggle
- reward applied toggle
- refund updates toggle
- points expiry toggle
- referral rewards toggle

The settings are saved through the existing Settings form and persisted separately from `LoyaltySetting`.

## Documentation

Updated `docs/loyalty-program.md` with:

- email dispatcher endpoint
- dispatch secret
- log provider behavior
- Resend provider environment variables

Environment variables:

```dotenv
EMAIL_DISPATCH_SECRET="..."
EMAIL_PROVIDER="log"
EMAIL_FROM="Rewards <rewards@example.com>"
RESEND_API_KEY="..."
```

For real delivery:

```dotenv
EMAIL_PROVIDER="resend"
EMAIL_FROM="Rewards <rewards@example.com>"
RESEND_API_KEY="..."
```

## Tests And Validation

Added:

- `app/services/email-dispatcher.test.js`

Validated with:

```bash
npm run typecheck
node --test app/services/*.test.js
npm run build
```

All passed.

## Generated Files

React Router generated route type files during `npm run typecheck` for the new dispatch route under:

- `.react-router/types/+routes.ts`
- `.react-router/types/app/routes/+types/api.email-notifications.dispatch.ts`

## Remaining Operational Steps

- Apply the Prisma migration in the target environment.
- Set `EMAIL_DISPATCH_SECRET`.
- Keep `EMAIL_PROVIDER=log` for dry-run validation or configure Resend for real sending.
- Schedule the dispatch endpoint through the hosting platform scheduler or cron.
- Trigger a loyalty event and confirm a pending row is created.
- Run the dispatcher and confirm the row moves to `sent` or `failed`.
