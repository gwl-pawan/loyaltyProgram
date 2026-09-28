# Loyalty Email Notification Framework - Work Summary

Date: 2026-09-16

## Overview

Implemented the foundation and operational flow for a native loyalty email notification system. Loyalty events now queue email notifications, merchants can control which notifications are enabled, and a protected dispatcher route can process queued notifications.

## Completed Work

- Added email notification database models and migration.
- Added default per-shop email notification settings.
- Added an idempotent email queue service.
- Queued emails from major loyalty lifecycle events:
  - signup bonus
  - order points earned
  - reward created
  - reward applied
  - refund point updates
  - points expired
  - referral rewards
- Added email dispatcher service.
- Added protected dispatch endpoint:
  - `POST /api/email-notifications/dispatch`
- Added log provider for development.
- Added Resend provider support for real email delivery.
- Added merchant controls in Admin Settings for notification preferences.
- Updated loyalty program documentation with dispatch endpoint and environment variables.
- Added unit coverage for loyalty email message rendering.

## Merchant Settings Added

The Settings page now includes an Email notifications section with:

- Master enable/disable toggle
- Signup bonus toggle
- Order points toggle
- Reward created toggle
- Reward applied toggle
- Refund updates toggle
- Points expiry toggle
- Referral rewards toggle

## Production Configuration

Required for dispatch route:

```dotenv
EMAIL_DISPATCH_SECRET="..."
```

For real email delivery through Resend:

```dotenv
EMAIL_PROVIDER="resend"
EMAIL_FROM="Rewards <rewards@example.com>"
RESEND_API_KEY="..."
```

Default development behavior:

```dotenv
EMAIL_PROVIDER="log"
```

## Validation

Passed:

```bash
npm run typecheck
node --test app/services/*.test.js
npm run build
```

## Current Status

The framework is ready for migration deployment and environment setup. Emails are queued by loyalty events and can be dispatched through the protected endpoint. Real delivery requires Resend environment variables.
