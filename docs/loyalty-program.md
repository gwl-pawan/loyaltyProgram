# Loyalty Program App Documentation

## 1. Overview

This repository contains a multi-surface Shopify loyalty program. Merchants configure earning and redemption rules in an embedded Shopify Admin app. Customers can view balances and redeem rewards through a theme app extension, Checkout UI extension, customer-account extension, iframe wallet, or the included Hydrogen storefront integration.

The application currently supports:

- Signup bonus points.
- Points earned from order value.
- Point deductions for refunds.
- Referral links, conversion tracking, and first-paid-order rewards.
- Birthday data collection and automated annual points rewards.
- Discount-code rewards.
- Gift-card rewards.
- Shopify store-credit rewards.
- Pending checkout rewards whose points are deducted after payment.
- Customer balances, reward history, and merchant activity reporting.
- Theme, checkout, customer-account, iframe, and Hydrogen surfaces.
- Merchant-editable text, rewards, colors, font settings, and custom iframe CSS.

See [Birthday rewards](birthday-rewards.md) for configuration, scheduling, privacy, and QA details.

See [Special date rewards](special-date-rewards.md) for the two configurable
customer-selected annual reward dates.

## 2. Technology stack

| Area                          | Technology                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| Admin application             | React 18, React Router 7, Shopify App Bridge, Polaris web components               |
| Server                        | Node.js 20+, React Router server runtime                                           |
| Database                      | MySQL with Prisma ORM                                                              |
| Shopify integration           | Shopify Admin GraphQL API, app proxy, webhooks, UI extensions, theme app extension |
| Storefront                    | Liquid/theme extension and optional Hydrogen React storefront                      |
| Production container          | Docker, `node:20-alpine`                                                           |
| Current hosting configuration | Railway application service plus Railway MySQL                                     |

## 3. High-level architecture

```text
Shopify Admin
  -> Embedded admin app
     -> React Router loaders/actions
        -> Prisma -> MySQL
        -> Shopify Admin GraphQL API

Shopify events
  -> Signed webhooks
     -> Customer, point, reward, and activity records

Customer surfaces
  -> Theme app extension / app proxy
  -> Checkout UI extension
  -> Customer-account UI extension
  -> Loyalty iframe
  -> Hydrogen server routes
     -> Loyalty JSON APIs
        -> Prisma + Shopify reward mutations
```

The app is multi-shop at the data-model level. `Shop` owns its settings and customers; each customer owns point transactions, rewards, and activity logs.

## 4. Repository structure

| Path                           | Purpose                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `app/routes/`                  | Admin pages, public APIs, Hydrogen APIs, auth, and webhook handlers            |
| `app/services/`                | Loyalty rules, settings, plan detection, errors, webhooks, and reward activity |
| `prisma/schema.prisma`         | MySQL data model                                                               |
| `prisma/migrations/`           | Production database migrations                                                 |
| `extensions/loyalty-theme/`    | Theme block and floating storefront widget                                     |
| `extensions/loyalty-checkout/` | Checkout UI extension                                                          |
| `extensions/loyalty-account/`  | Customer-account blocks and reward-history page                                |
| `hydrogen-loyalty-storefront/` | Example Hydrogen storefront integration                                        |
| `examples/hydrogen/`           | Reusable server-side Hydrogen client example                                   |
| `scripts/shopify-dev.mjs`      | Shopify CLI wrapper that synchronizes development tunnel URLs                  |
| `shopify.app.toml`             | Development Shopify app configuration                                          |
| `shopify.app.production.toml`  | Production Shopify app configuration                                           |
| `Dockerfile`                   | Production build and startup                                                   |

## 5. Installation and local development

### Requirements

- Node.js `20.19+` (or a compatible Node 22 version declared in `package.json`).
- npm.
- Shopify CLI.
- A Shopify Partner account and development store.
- MySQL.

### Install dependencies

```bash
npm install
```

### Environment variables

Create a local `.env` file. Do not commit real secrets.

```dotenv
DATABASE_URL="mysql://USER:PASSWORD@HOST:3306/DATABASE"
SHOPIFY_API_KEY="your-app-client-id"
SHOPIFY_API_SECRET="your-app-client-secret"
SHOPIFY_APP_URL="https://your-app-or-development-tunnel.example.com"
SCOPES="comma-separated-shopify-scopes"
NODE_ENV="development"

# Required only for protected Hydrogen endpoints
HYDROGEN_LOYALTY_API_TOKEN="a-long-random-shared-secret"
```

`LOYALTY_HYDROGEN_API_TOKEN` is accepted as a legacy alias for `HYDROGEN_LOYALTY_API_TOKEN`. `SHOP_CUSTOM_DOMAIN` is optional and supported by the Shopify app bootstrap.

### Prepare the database

```bash
npm run setup
```

This generates Prisma Client and runs all pending migrations.

### Start development

```bash
npm run dev
```

The custom development wrapper starts `shopify app dev`, reads the active tunnel from `.shopify/dev-bundle/manifest.json`, and updates generated API URL modules used by the extensions.

After Shopify CLI opens the preview, install the app on the development store.

## 6. First-install behavior

When an authenticated merchant opens the app, `ensurePlanAwareLoyaltySetup`:

1. Reads the store plan from Shopify.
2. Creates or updates the local `Shop` record.
3. Chooses the effective integration surface.
4. Creates a `LoyaltySetting` row if one does not exist.
5. Stores all default loyalty, checkout, customer-account, and iframe settings.

The install flow does not create sample customers, transactions, or activity records.

### Default earning configuration

| Setting                              |            Default |
| ------------------------------------ | -----------------: |
| Signup bonus                         |         100 points |
| Order threshold                      | 100 currency units |
| Points per order threshold           |          10 points |
| Refund threshold                     | 100 currency units |
| Points deducted per refund threshold |          10 points |
| Redemption enabled                   |                Yes |
| Checkout reward display limit        |                 10 |

### Default discount rewards

| Points | Discount value |
| -----: | -------------: |
|    100 |              2 |
|    250 |              5 |
|    500 |             10 |

The code also defines a default `$15` gift card at 1,500 points and a store-credit conversion of 100 points to 1 currency unit for surfaces that support those reward types.

## 7. Merchant admin application

The embedded admin navigation contains:

### Home

Displays program metrics, outstanding points, redemption rate, average balance, and recent customers.

Important current behavior: the dashboard queries are not filtered by shop. Before using one application database for unrelated merchants, scope `app/routes/app._index.jsx` by the authenticated shop as the Customers and History routes already do.

### Customers

Displays customers enrolled for the authenticated shop, including:

- Name and email.
- Current available points.
- Number of point transactions.
- Number of generated rewards.
- Enrollment date.

If the shop has no loyalty customers, the page displays `No customers`.

### History

Displays reward activity with customer, type, points, amount, order, message, and timestamp. Discount and gift-card codes are shown when relevant; store-credit transaction IDs are intentionally hidden. Store-credit activity is labeled `Store credit`.

### Settings

The Settings page controls:

- Signup, order, and refund earning rules.
- Reward type preference and reward tiers.
- Global redemption enablement.
- Checkout reward count limit.
- Checkout copy.
- Customer-account copy.
- Iframe text, colors, font family, font size, and custom CSS.
- Headless/Hydrogen endpoint examples.
- Iframe URL examples.

Settings are persisted in the shop's `LoyaltySetting` record.

## 8. Shopify plan behavior

The app reads `shop.plan` through Admin GraphQL and stores:

- Public plan name.
- Whether the shop is Shopify Plus.
- Whether the shop is a partner development store.

Checkout integration is available when the shop is Shopify Plus or a partner development store. Other shops use the theme integration. The shared redemption toggle can disable reward redemption across surfaces.

## 9. Points lifecycle

### Signup

The `customers/create` webhook creates the local customer once and credits the configured signup bonus. A `PointTransaction` with reason `Signup Bonus` is recorded.

### Orders

Order points use this calculation:

```text
floor(order total / orderSpendAmount) * orderSpendPoints
```

Both `orders/create` and `orders/paid` call the awarding service. Duplicate credits are prevented by checking the order-specific transaction reason.

### Refunds

The refund webhook calculates a debit using the configured refund threshold and records a debit transaction. If a redeemed discount belongs to the refunded order, its points are returned and an activity entry is created.

### Balance

`Customer.loyaltyPoints` is the current balance. `PointTransaction` is the audit trail of credits and debits.

## 10. Reward lifecycle

### Discount rewards

1. The app creates a Shopify discount code.
2. Checkout-oriented flows can store it as `pending` without immediately deducting points.
3. `orders/paid` matches the applied code, marks the reward redeemed, and deducts points.
4. Pending rewards can expire or be released if checkout no longer uses the code.
5. A refund can return the points for a redeemed loyalty discount.

### Gift-card rewards

1. The app creates a Shopify gift card.
2. Points are deducted when the gift card is issued.
3. Paid-order processing attempts to match gift-card usage and update activity.

### Store-credit rewards

1. The customer selects an eligible store-credit amount.
2. The app calls Shopify's store-credit account credit mutation.
3. Points are deducted immediately.
4. The Shopify store-credit transaction ID is stored internally as the reward identifier.
5. Merchant and customer history show the amount and activity without exposing that transaction ID as a reward code.

All reward state changes are recorded in `Reward` and, where applicable, `RewardActivityLog`.

## 11. Customer-facing integrations

### Theme app extension

`extensions/loyalty-theme` provides storefront blocks and a floating launcher. The app proxy is configured as:

```text
/apps/loyalty-points -> /api/loyalty-balance
```

Add the loyalty block in the Shopify theme editor and enable the app embed/launcher as required by the theme configuration.

### Checkout UI extension

`extensions/loyalty-checkout` targets `purchase.checkout.block.render`. It displays the signed-in customer's balance and available rewards, creates rewards through the app API, and manages pending checkout codes.

The production/development API URL is generated into the extension bundle. Merchants do not configure an API base URL manually.

### Customer-account extension

`extensions/loyalty-account` provides:

- Blocks for the order-index and profile targets.
- Native loyalty balance and store-credit conversion UI.
- A separate full-page reward-history extension target.

Merchant-facing text settings override API-managed defaults. The extension uses the generated application URL automatically.

### Iframe wallet

The iframe entry point is:

```text
GET /api/loyalty-iframe?shop=SHOP_DOMAIN&customerId=CUSTOMER_ID
```

Supported surfaces include:

```text
surface=floating
surface=account
```

Examples:

```text
/api/loyalty-iframe?shop=example.myshopify.com&customerId=123
/api/loyalty-iframe?shop=example.myshopify.com&customerId=123&surface=floating
/api/loyalty-iframe?shop=example.myshopify.com&customerId=123&surface=account
```

The default surface shows the full reward list, `floating` shows a compact wallet, and `account` shows the store-credit and history experience. Appearance is controlled from the app's Iframe settings.

### Hydrogen storefront

Hydrogen must call protected loyalty endpoints from server loaders/actions; the shared token must not be exposed in browser code.

Set these variables in Hydrogen:

```dotenv
LOYALTY_APP_URL="https://your-loyalty-app.example.com"
PUBLIC_STORE_DOMAIN="example.myshopify.com"
HYDROGEN_LOYALTY_API_TOKEN="the-same-secret-used-by-the-loyalty-app"
```

Reusable integration code lives in `hydrogen-loyalty-storefront/app/lib/loyalty.js`. See `docs/hydrogen-custom-checkout.md` for the cart-to-checkout redemption flow.

## 12. API reference

### Public/storefront endpoints

| Method   | Endpoint                       | Purpose                                             |
| -------- | ------------------------------ | --------------------------------------------------- |
| GET/POST | `/api/loyalty-balance`         | Balance, reward options, settings, and surface data |
| POST     | `/api/redeem-points`           | Create/release a reward                             |
| GET      | `/api/customer-reward-history` | Customer reward activity                            |
| GET      | `/api/loyalty-program`         | Public earning and redemption configuration         |
| GET      | `/api/loyalty-iframe`          | Render the loyalty iframe                           |
| GET/POST | `/api/points-expiry`           | Run the protected points-expiry worker              |

Typical balance request:

```text
GET /api/loyalty-balance?shop=example.myshopify.com&customerId=123&surface=theme
```

Typical redemption body:

```json
{
  "customerId": "gid://shopify/Customer/123",
  "shop": "example.myshopify.com",
  "pointsToRedeem": 250,
  "rewardType": "discount",
  "appliedDiscountCodes": [],
  "allowPendingRewardCheckout": true
}
```

Supported `rewardType` values are `discount`, `gift_card`, and `store_credit` when the selected reward and surface permit them.

### Protected Hydrogen endpoints

| Method   | Endpoint                                |
| -------- | --------------------------------------- |
| GET/POST | `/api/hydrogen/loyalty-balance`         |
| POST     | `/api/hydrogen/redeem-points`           |
| GET      | `/api/hydrogen/customer-reward-history` |

Send:

```http
Authorization: Bearer YOUR_HYDROGEN_LOYALTY_API_TOKEN
```

The protected routes return `401` for an invalid token and `503` when the server token is not configured.

### Points expiry worker

Points expiry is opt-in per shop. Each credit transaction receives a fixed
deadline based on the configured number of days or calendar months. Debits
consume the oldest available earning batches first. Expiry writes an
idempotent `expiry` point transaction and a `points_expired` activity log.

Balance, redemption, and customer-history requests process expiry lazily for
the active customer. To process inactive customers, schedule a daily request:

```http
POST /api/points-expiry
Authorization: Bearer YOUR_POINTS_EXPIRY_SECRET
Content-Type: application/json

{"batchSize": 100}
```

Set `POINTS_EXPIRY_SECRET` to a dedicated random production secret. The route
returns `503` until it is configured. Repeated or overlapping runs are safe:
each earning batch has a unique expiry idempotency key.

### Email notification dispatcher

Loyalty events write `EmailNotification` rows and immediately attempt delivery
through the configured provider. The notification is claimed before sending,
so webhook retries cannot send the same email twice.

Keep the protected dispatcher endpoint as a recovery worker for notifications
left pending when a process stops before immediate delivery begins. Schedule a
recurring backend request:

```http
POST /api/email-notifications/dispatch
Authorization: Bearer YOUR_EMAIL_DISPATCH_SECRET
Content-Type: application/json

{"limit": 25}
```

Set `EMAIL_DISPATCH_SECRET` to a dedicated random production secret. The route
returns `503` until it is configured. The endpoint is not required for normal
immediate delivery, but a recurring recovery call is recommended. By default
the dispatcher uses
`EMAIL_PROVIDER=log`, which marks queued emails as sent after writing a server
log entry. To send real email through Resend, set:

```dotenv
EMAIL_PROVIDER="resend"
EMAIL_FROM="Rewards <rewards@example.com>"
RESEND_API_KEY="..."
```

To send through Twilio SendGrid instead, create an API key with Mail Send
permission and configure a verified sender address or authenticated domain:

```dotenv
EMAIL_PROVIDER="sendgrid"
EMAIL_FROM="Rewards <rewards@example.com>"
SENDGRID_API_KEY="SG..."
```

SendGrid accepts the request only when `EMAIL_FROM` matches a verified sender
identity. Domain authentication is recommended for production delivery.

## 13. Webhooks

| Topic               | Route                         | Behavior                                                          |
| ------------------- | ----------------------------- | ----------------------------------------------------------------- |
| `customers/create`  | `/webhooks/customers/create`  | Enroll customer and add signup points                             |
| `orders/create`     | `/webhooks/orders/create`     | Award order points with duplicate protection                      |
| `orders/paid`       | `/webhooks/orders/paid`       | Award points and settle pending discounts/gift cards              |
| `refunds/create`    | `/webhooks/refunds/create`    | Deduct refund points and return eligible redeemed-discount points |
| `app/uninstalled`   | `/webhooks/app/uninstalled`   | Remove the shop record                                            |
| `app/scopes_update` | `/webhooks/app/scopes_update` | Update stored session scope                                       |

Webhook requests are authenticated with Shopify HMAC through `authenticate.webhook`. `orders/paid` payloads are also stored in `WebhookLog` for processing visibility.

## 14. Database model

| Model               | Responsibility                                                            |
| ------------------- | ------------------------------------------------------------------------- |
| `Session`           | Shopify offline/online sessions and access tokens                         |
| `Shop`              | Merchant identity and Shopify plan capabilities                           |
| `LoyaltySetting`    | Earning rules, reward configuration, and editable surface copy/appearance |
| `Customer`          | Shop-scoped Shopify customer and current point balance                    |
| `PointTransaction`  | Point credit/debit audit trail                                            |
| `Reward`            | Generated discount, gift card, or store-credit reward and lifecycle state |
| `RewardActivityLog` | Merchant/customer-facing reward timeline                                  |
| `WebhookLog`        | Stored webhook payload and processing status                              |

Important uniqueness rules:

- One `Shop` per Shopify domain.
- One `LoyaltySetting` per shop.
- One customer per `(shopId, shopifyCustomerId)`.
- Reward codes are unique.

## 15. Shopify permissions

The configured scopes are limited to the active loyalty features:

- `read_customers`: enroll customers from customer webhooks and associate rewards with Shopify customer IDs.
- `read_orders`: receive/process order and refund webhooks for points, reward settlement, and refund handling.
- `read_products`: let merchants select products/collections for optional reward eligibility rules.
- `write_discounts`: create loyalty discount codes.
- `write_gift_cards`: issue gift-card rewards.
- `read_store_credit_accounts`: show a customer's current Shopify store-credit balance.
- `write_store_credit_account_transactions`: add store credit when a customer redeems points.

Template-only product metafield and metaobject configuration has been removed because the loyalty app does not use product writes or metaobjects.

Customer data is limited to what the loyalty program needs:

- Shopify customer ID, name, and email for the local loyalty customer record and merchant-facing customer list.
- Order IDs, order names, totals, and timestamps from order/refund webhooks for point earning, reward settlement, and refund handling.
- Reward activity data such as points used, reward type, generated reward code, order ID/name, and status.

The app does not need product writes, metaobjects, saved full order webhook payloads, or gift-card reads. `orders/paid` webhook logs store only a compact processing summary instead of the full order payload.

After changing scopes, deploy the Shopify configuration and reinstall or approve the new permissions when Shopify requests it.

## 16. Validation commands

Use Node 20 for the main validation path:

```bash
npm run setup
npm run typecheck
npm run build
```

Extension configuration and code are released with:

```bash
npm run deploy
```

Changes to extension settings do not appear in Shopify's editors until the new extension version is deployed, or the local dev preview is restarted.

## 17. Production deployment

The Docker image performs:

1. Production dependency installation.
2. React Router build.
3. `npm run docker-start` at runtime.
4. Prisma generation and migration deployment.
5. Application server startup.

Required production variables include:

```dotenv
DATABASE_URL="mysql://..."
SHOPIFY_API_KEY="..."
SHOPIFY_API_SECRET="..."
SHOPIFY_APP_URL="https://your-production-domain"
SCOPES="..."
NODE_ENV="production"
HYDROGEN_LOYALTY_API_TOKEN="..." # when Hydrogen APIs are used
POINTS_EXPIRY_SECRET="..." # required for the automated expiry worker
EMAIL_DISPATCH_SECRET="..." # required for the email notification dispatcher
EMAIL_PROVIDER="log" # use "sendgrid" or "resend" for real email delivery
EMAIL_FROM="Rewards <rewards@example.com>" # required for SendGrid or Resend
SENDGRID_API_KEY="..." # required when EMAIL_PROVIDER="sendgrid"
RESEND_API_KEY="..." # required when EMAIL_PROVIDER="resend"
```

For Railway, leave the custom Start Command empty so Docker uses:

```bash
npm run docker-start
```

Keep `application_url`, auth callback URLs, and the deployed extension API URL synchronized with the production domain.

## 18. Prisma migration recovery

Normal startup uses:

```bash
npm run setup
```

If production reports `P3009`, inspect the original failed deployment for the underlying MySQL error before changing migration state. After correcting the migration, a failed record can be retried with:

```bash
npm exec -- prisma migrate resolve --rolled-back MIGRATION_NAME
npm run setup
```

Use `--applied` only when the intended schema/data change is already present or deliberately superseded. Do not repeatedly run a recovery command as the permanent Railway Start Command; once recovery succeeds, restore the normal Docker start command.

Long editable copy fields use MySQL `TEXT` to avoid error `1118` (`Row size too large`). New migrations must use MySQL syntax and backticks.

## 19. Troubleshooting

### Application deployed but does not respond

- Confirm the container is still running rather than completing a one-time command.
- Remove temporary custom Railway Start Commands.
- Confirm the server logs show `react-router-serve` listening on Railway's `PORT`.

### Settings page returns HTTP 500

- Read the Railway runtime log while refreshing `/app/settings`.
- `P2022` means Prisma expects a database column that is missing.
- Run committed migrations; do not use `db push` as the production migration strategy.

### Extension setting changes are not visible

- Run `npm run deploy` for a released extension.
- Restart `npm run dev` for a development preview.
- Close and reopen the Shopify editor after the new extension schema is active.

### Extension reports failed fetch or configuration missing

- Confirm the generated API URL module contains the active app URL.
- During development, verify `.shopify/dev-bundle/manifest.json` contains the current tunnel.
- Rebuild/redeploy the affected extension after URL changes.

### Theme widget shows zero points

- Confirm the customer is signed in and has a local `Customer` record.
- Test `/api/loyalty-balance` with the shop and customer ID.
- Confirm the theme is using the current deployed extension bundle.
- Confirm the selected integration matches the surface being tested.

### Hydrogen reports `Loyalty integration is not configured`

Confirm `LOYALTY_APP_URL`, `PUBLIC_STORE_DOMAIN`, and the shared Hydrogen token exist in the Hydrogen server environment.

## 20. Security and operational notes

- Never expose Shopify API secrets, database credentials, or the Hydrogen bearer token in client code.
- Keep reward creation server-side.
- Shopify webhook authentication must remain enabled.
- Public customer endpoints currently identify customers using shop/customer parameters and allow broad CORS. For a public production product, add stronger signed customer/session verification and restrict allowed origins.
- Review data retention requirements before deleting merchant or customer records.
- Back up MySQL before risky production migrations.
- Monitor failed reward activity and unprocessed webhook logs.

## 21. Main source references

- Defaults: `app/services/loyalty-settings.shared.js`
- Installation: `app/services/loyalty-installation.server.js`
- Earning and settlement: `app/services/order-points.server.js`
- Reward creation: `app/routes/api.redeem-points.jsx`
- Plan gating: `app/services/shop-plan.server.js`
- Hydrogen authentication: `app/services/hydrogen-api.server.js`
- Database: `prisma/schema.prisma`
- Shopify configuration: `shopify.app.toml`
