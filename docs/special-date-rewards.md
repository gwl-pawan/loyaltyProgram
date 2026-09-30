# Special date rewards

Special date rewards let each customer save up to two personal annual dates,
such as an anniversary. The merchant controls each reward's enablement, dynamic
heading, and points value; the merchant does not choose the customer's date.

## Merchant configuration

In **Loyalty settings → Point rules → Special date rewards**:

- Enable or disable each reward independently.
- Set the heading shown to customers, in reward history, and in email.
- Set the points credited for that reward.
- Set the shared minimum lead time required after a customer saves or changes a
  date.

Both rewards use the birthday reward time zone. Special-date email delivery can
be enabled under **Email notifications**, and the email can be customized on the
**Email templates** page with the `{{reward_heading}}` placeholder.

## Customer date collection

Authenticated customers can save, update, or remove each enabled special date
from Customer Accounts, the Hydrogen account profile, or the **Special date
rewards** Online Store app block. Only month and day are stored; any supplied
year is discarded. Updating a date restarts the lead-time eligibility period.

## Processing and idempotency

The protected `POST /api/birthday-rewards` worker processes birthday and special
date rewards together. Schedule it at least daily with
`BIRTHDAY_REWARDS_SECRET`.

The worker has a seven-day recovery window. Each customer can receive each
special-date reward only once per calendar year, enforced by:

`special-date-reward:<shop>:<customer>:<slot>:<year>`

Changing a date does not clear the last-issued year, preventing a second reward
from the same slot in the same year. Email delivery uses a separate annual
idempotency key.

## Deployment and QA

1. Run `npx prisma migrate deploy` to apply the pending special-date migrations,
   including `20260930130000_customer_special_dates` and
   `20260930140000_remove_merchant_special_dates`.
2. Deploy the app and storefront extensions.
3. Enable a slot, set its heading and points, and temporarily lower the lead
   time in a non-production environment.
4. Sign in as a customer and save today's month and day.
5. Run the authenticated worker twice.
6. Verify one balance credit, one point transaction, one activity log, and at
   most one email.
