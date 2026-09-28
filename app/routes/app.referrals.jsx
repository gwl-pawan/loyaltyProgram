import { useLoaderData } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

const STATUS_LABELS = {
  clicked: "Clicked",
  claimed: "Claimed",
  rewarded: "Rewarded",
  expired: "Expired",
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const requestedStatus = url.searchParams.get("status");
  const status = Object.hasOwn(STATUS_LABELS, requestedStatus)
    ? requestedStatus
    : "all";
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: {
      id: true,
      loyaltySetting: {
        select: {
          referralProgramEnabled: true,
          referralAdvocatePoints: true,
          referralFriendPoints: true,
          referralAttributionDays: true,
        },
      },
    },
  });

  if (!shop) {
    return Response.json({
      referrals: [],
      totals: { all: 0, clicked: 0, claimed: 0, rewarded: 0, expired: 0 },
      pointsIssued: 0,
      status,
      settings: null,
    });
  }

  const [statusGroups, referrals, pointsAggregate] = await Promise.all([
    prisma.referral.groupBy({
      by: ["status"],
      where: { shopId: shop.id },
      _count: { _all: true },
    }),
    prisma.referral.findMany({
      where: {
        shopId: shop.id,
        ...(status === "all" ? {} : { status }),
      },
      include: {
        advocateCustomer: {
          select: { name: true, email: true, shopifyCustomerId: true },
        },
        referredCustomer: {
          select: { name: true, email: true, shopifyCustomerId: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.pointTransaction.aggregate({
      where: {
        transactionType: "credit",
        idempotencyKey: { startsWith: "referral:" },
        customer: { shopId: shop.id },
      },
      _sum: { points: true },
    }),
  ]);
  const totals = {
    all: 0,
    clicked: 0,
    claimed: 0,
    rewarded: 0,
    expired: 0,
  };

  statusGroups.forEach((group) => {
    const count = group._count._all;
    totals.all += count;
    if (Object.hasOwn(totals, group.status)) totals[group.status] = count;
  });

  return Response.json({
    referrals,
    totals,
    pointsIssued: pointsAggregate._sum.points || 0,
    status,
    settings: shop.loyaltySetting,
  });
};

function customerLabel(customer) {
  return (
    customer?.name ||
    customer?.email ||
    (customer?.shopifyCustomerId
      ? `Customer ${customer.shopifyCustomerId}`
      : "Not claimed")
  );
}

function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default function ReferralsPage() {
  const { referrals, totals, pointsIssued, status, settings } = useLoaderData();
  const conversionRate =
    totals.all > 0 ? Math.round((totals.rewarded / totals.all) * 1000) / 10 : 0;

  return (
    <s-page heading="Referrals" inlineSize="large">
      <style>{styles}</style>
      <div className="referrals-page">
        <section className="referral-hero">
          <div>
            <span className="status-pill">
              {settings?.referralProgramEnabled === false
                ? "Program paused"
                : "Program active"}
            </span>
            <h2>Referral performance</h2>
            <p>
              Track link visits, customer claims, qualified first orders, and
              issued points.
            </p>
          </div>
          <s-button href="/app/settings">Configure referrals</s-button>
        </section>

        <section className="metric-grid" aria-label="Referral metrics">
          <article>
            <span>Link visits</span>
            <strong>{totals.all}</strong>
          </article>
          <article>
            <span>Claims</span>
            <strong>{totals.claimed}</strong>
          </article>
          <article>
            <span>Rewarded</span>
            <strong>{totals.rewarded}</strong>
          </article>
          <article>
            <span>Conversion</span>
            <strong>{conversionRate}%</strong>
          </article>
          <article>
            <span>Points issued</span>
            <strong>{pointsIssued}</strong>
          </article>
        </section>

        <section className="referral-table-card">
          <div className="table-heading">
            <div>
              <h2>Referral activity</h2>
              <p>Showing the latest 100 referrals.</p>
            </div>
            <nav aria-label="Referral status filters">
              {["all", "clicked", "claimed", "rewarded", "expired"].map(
                (item) => (
                  <a
                    className={status === item ? "is-active" : ""}
                    href={
                      item === "all"
                        ? "/app/referrals"
                        : `/app/referrals?status=${item}`
                    }
                    key={item}
                  >
                    {item === "all" ? "All" : STATUS_LABELS[item]} (
                    {totals[item]})
                  </a>
                ),
              )}
            </nav>
          </div>

          {referrals.length === 0 ? (
            <div className="empty-state">
              <h3>No referrals found</h3>
              <p>
                Referral visits will appear here after customers share their
                links.
              </p>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Referrer</th>
                    <th>Friend</th>
                    <th>Status</th>
                    <th>Code</th>
                    <th>Clicked</th>
                    <th>Qualified order</th>
                  </tr>
                </thead>
                <tbody>
                  {referrals.map((referral) => (
                    <tr key={referral.id}>
                      <td>{customerLabel(referral.advocateCustomer)}</td>
                      <td>{customerLabel(referral.referredCustomer)}</td>
                      <td>
                        <span
                          className={`referral-status referral-status--${referral.status}`}
                        >
                          {STATUS_LABELS[referral.status] || referral.status}
                        </span>
                      </td>
                      <td>
                        <code>{referral.referralCode}</code>
                      </td>
                      <td>{formatDate(referral.clickedAt)}</td>
                      <td>{referral.qualifiedOrderId || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </s-page>
  );
}

const styles = `
  .referrals-page { display: grid; gap: 20px; padding-block: 16px 32px; }
  .referral-hero, .referral-table-card { background: #fff; border: 1px solid #e1e3e5; border-radius: 16px; padding: 24px; }
  .referral-hero { display: flex; justify-content: space-between; gap: 20px; align-items: center; }
  .referral-hero h2, .table-heading h2, .empty-state h3 { margin: 8px 0 4px; }
  .referral-hero p, .table-heading p, .empty-state p { margin: 0; color: #616a75; }
  .status-pill { display: inline-flex; background: #e5f5ec; color: #0b6b3a; border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 650; }
  .metric-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
  .metric-grid article { background: #fff; border: 1px solid #e1e3e5; border-radius: 14px; padding: 18px; display: grid; gap: 8px; }
  .metric-grid span { color: #616a75; font-size: 13px; }
  .metric-grid strong { font-size: 28px; }
  .table-heading { display: flex; justify-content: space-between; align-items: end; gap: 16px; margin-bottom: 18px; }
  .table-heading nav { display: flex; flex-wrap: wrap; gap: 6px; }
  .table-heading a { color: #3f4e5d; text-decoration: none; border-radius: 8px; padding: 7px 10px; background: #f3f4f6; font-size: 13px; }
  .table-heading a.is-active { background: #202223; color: #fff; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 12px; border-top: 1px solid #e1e3e5; vertical-align: middle; }
  th { color: #616a75; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  td { font-size: 13px; }
  code { font-size: 12px; }
  .referral-status { display: inline-flex; border-radius: 999px; padding: 4px 8px; background: #eef0f2; }
  .referral-status--rewarded { background: #e5f5ec; color: #0b6b3a; }
  .referral-status--claimed { background: #e8f0fe; color: #174ea6; }
  .referral-status--expired { background: #f5e9e8; color: #8e1f0b; }
  .empty-state { padding: 48px 16px; text-align: center; }
  @media (max-width: 900px) { .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .referral-hero, .table-heading { align-items: stretch; flex-direction: column; } }
`;
