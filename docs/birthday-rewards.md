# Birthday rewards

The birthday reward system collects only a customer's birth month and day and awards configured loyalty points once per calendar year.

## Merchant configuration

In **Loyalty settings → Point rules → Birthday rewards**, configure:

- Whether birthday rewards are enabled.
- The annual points amount.
- The minimum number of days the birthday must be on file before the reward date.
- The IANA time zone used to determine the birthday date, such as `America/New_York`.
- Whether birthday reward emails are enabled under **Email notifications**.

The default lead time is 30 days. Changing a birthday resets the lead-time clock. This prevents a customer from changing the date to the current day to immediately collect points.

## Customer collection

Authenticated customers can add or remove their birthday from:

- The Shopify Customer Account loyalty block.
- The Hydrogen account profile.
- The **Birthday reward** Online Store app block, backed by the signed app proxy.

Only `birthMonth` and `birthDay` are persisted. The year supplied by a date-based client is discarded. Customer identity always comes from the authenticated customer-account session, the signed app-proxy request, or the authenticated Hydrogen server action; it is not trusted from browser-submitted identity fields.

Birthday entry is one-time and enforced by the backend across every customer surface. After the first save, the birthday is displayed read-only and a different date receives HTTP 409. Identical retries are idempotent. Customers can remove their stored month/day for privacy, but the non-sensitive entry timestamps remain as a lock so a different date cannot be re-added without merchant review. An authenticated merchant can use **Customers → Allow correction** to clear the date and lock; annual reward history is retained to prevent a second reward in the same year.

## Automated issuance

Set `BIRTHDAY_REWARDS_SECRET` in the deployed app and invoke the protected endpoint at least daily (hourly is recommended so each configured shop time zone is covered):

```bash
curl --fail --request POST \
  --header "Authorization: Bearer $BIRTHDAY_REWARDS_SECRET" \
  --header "Content-Type: application/json" \
  --data '{}' \
  https://APP_HOST/api/birthday-rewards
```

The worker:

- Uses each shop's configured time zone.
- Treats February 29 as February 28 in non-leap years.
- Includes a seven-day recovery window for missed scheduler runs.
- Creates a unique `birthday-reward:<shop>:<customer>:<year>` point transaction.
- Updates the balance and reward activity log transactionally.
- Queues and immediately attempts the birthday email with its own annual idempotency key.

The endpoint also accepts `shop` and `batchSize` in its JSON body for targeted operations. The maximum batch size is 1,000 candidates per shop and run.

## Deployment and QA

1. Run `npx prisma migrate deploy` to apply `20260924120000_birthday_rewards`.
2. Configure `BIRTHDAY_REWARDS_SECRET` and the email provider variables.
3. Deploy the app and Customer Account extension, and deploy the Hydrogen storefront when used.
4. Enable the rule and choose the correct store time zone.
5. Save a test customer's birthday. For immediate QA, temporarily use a one-day lead time and set `birthdayUpdatedAt` to an eligible earlier date in a non-production test database.
6. Trigger the worker twice and confirm only one annual point transaction, one activity entry, one balance increment, and at most one email notification exist.
7. Confirm removing the birthday clears the stored month/day and prevents future issuance.
