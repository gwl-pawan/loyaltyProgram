import { useLoaderData } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  loadLoyaltyAnalytics,
  normalizeAnalyticsFilters,
} from "../services/loyalty-analytics.server";

const emptyAnalytics = {
  currencyCode: "USD",
  revenue: {
    attributedRevenue: 0,
    attributedOrders: 0,
    averageOrderValue: 0,
    redemptionValue: 0,
    revenueToRewardRatio: 0,
  },
  redemptions: {
    count: 0,
    pointsEarned: 0,
    pointsRedeemed: 0,
    trend: [],
    rewardMix: [],
  },
  engagement: {
    totalMembers: 0,
    activeMembers: 0,
    earners: 0,
    redeemers: 0,
    repeatRedeemers: 0,
    newMembers: 0,
    engagementRate: 0,
  },
};

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const filters = normalizeAnalyticsFilters(new URL(request.url));
  const shop = await prisma.shop.findUnique({
    where: {
      shopDomain: session.shop,
    },
    select: {
      id: true,
    },
  });

  if (!shop) {
    return Response.json({
      totalCustomers: 0,
      totalRewards: 0,
      totalPointsIssued: 0,
      totalRedeemed: 0,
      customers: [],
      analytics: emptyAnalytics,
      filters,
    });
  }

  const customerScope = { shopId: shop.id };
  const transactionScope = {
    customer: customerScope,
  };
  const [
    totalCustomers,
    totalRewards,
    issuedAggregate,
    redeemedAggregate,
    customers,
    analytics,
  ] = await Promise.all([
    prisma.customer.count({ where: customerScope }),
    prisma.reward.count({ where: { customer: customerScope } }),
    prisma.pointTransaction.aggregate({
      where: { ...transactionScope, transactionType: "credit" },
      _sum: { points: true },
    }),
    prisma.pointTransaction.aggregate({
      where: { ...transactionScope, transactionType: "debit" },
      _sum: { points: true },
    }),
    prisma.customer.findMany({
      where: customerScope,
      orderBy: {
        createdAt: "desc",
      },
      take: 10,
    }),
    loadLoyaltyAnalytics({ admin, shopId: shop.id, filters }),
  ]);
  const totalPointsIssued = issuedAggregate._sum.points || 0;
  const totalRedeemed = redeemedAggregate._sum.points || 0;

  return Response.json({
    totalCustomers,
    totalRewards,
    totalPointsIssued,
    totalRedeemed,
    customers,
    analytics,
    filters,
  });
};

export default function Dashboard() {
  const {
    totalCustomers,
    totalRewards,
    totalPointsIssued,
    totalRedeemed,
    customers,
    analytics = emptyAnalytics,
    filters,
  } = useLoaderData();

  const formatter = new Intl.NumberFormat("en");
  const currencyFormatter = new Intl.NumberFormat("en", {
    style: "currency",
    currency: analytics.currencyCode || "USD",
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: 2,
  });
  const percentFormatter = new Intl.NumberFormat("en", {
    maximumFractionDigits: 1,
  });

  const netPoints = totalPointsIssued - totalRedeemed;
  const redemptionRate =
    totalPointsIssued > 0
      ? Math.round((totalRedeemed / totalPointsIssued) * 100)
      : 0;
  const averageBalance =
    totalCustomers > 0 ? Math.round(netPoints / totalCustomers) : 0;

  const stats = [
    {
      label: "Customers",
      value: totalCustomers,
      detail: "Enrolled in loyalty",
      tone: "metric-info",
    },
    {
      label: "Points issued",
      value: totalPointsIssued,
      detail: "Credits earned by customers",
      tone: "metric-success",
    },
    {
      label: "Points redeemed",
      value: totalRedeemed,
      detail: "Debits used for rewards",
      tone: "metric-warning",
    },
    {
      label: "Rewards",
      value: totalRewards,
      detail: `${formatter.format(netPoints)} points outstanding`,
      tone: "metric-attention",
    },
  ];
  const maximumTrendRedemptions = Math.max(
    1,
    ...analytics.redemptions.trend.map((bucket) => bucket.redemptions),
  );
  const maximumRewardMix = Math.max(
    1,
    ...analytics.redemptions.rewardMix.map((item) => item.count),
  );
  const rewardTypeLabels = {
    discount: "Discounts",
    gift_card: "Gift cards",
    store_credit: "Store credit",
  };

  return (
    <s-page heading="Loyalty dashboard" inlineSize="large">
      <style>{dashboardStyles}</style>

      <div className="dashboard">
        <section className="hero-panel" aria-label="Program overview">
          <div>
            <span className="status-pill">Program active</span>
            <h2>Reward customers with every order</h2>
            <p>
              Track member growth, earned points, redemptions, and reward
              activity from one focused loyalty workspace.
            </p>
          </div>

          <div className="hero-actions">
            <s-button href="/app/settings" variant="primary">
              Configure points
            </s-button>
            <s-button href="/app/customers">View customers</s-button>
          </div>
        </section>

        <section className="health-panel" aria-label="Program health">
          <div className="panel-heading">
            <span>Program health</span>
            <span>{formatter.format(netPoints)} outstanding</span>
          </div>

          <div className="health-grid">
            <div>
              <span>Redemption rate</span>
              <strong>{redemptionRate}%</strong>
            </div>
            <div>
              <span>Avg. balance</span>
              <strong>{formatter.format(averageBalance)}</strong>
            </div>
          </div>
        </section>

        <section className="filter-panel" aria-labelledby="analytics-filters">
          <div>
            <h2 id="analytics-filters">Loyalty analytics</h2>
            <p>Filter revenue, redemption, and engagement insights.</p>
          </div>
          <form method="get" className="analytics-filters">
            <label>
              <span>Date range</span>
              <select name="range" defaultValue={filters.range}>
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
                <option value="90d">Last 90 days</option>
                <option value="365d">Last 12 months</option>
                <option value="all">All time</option>
              </select>
            </label>
            <label>
              <span>Reward type</span>
              <select name="rewardType" defaultValue={filters.rewardType}>
                <option value="all">All rewards</option>
                <option value="discount">Discounts</option>
                <option value="gift_card">Gift cards</option>
                <option value="store_credit">Store credit</option>
              </select>
            </label>
            <label>
              <span>Customer segment</span>
              <select
                name="customerSegment"
                defaultValue={filters.customerSegment}
              >
                <option value="all">All customers</option>
                <option value="active">Active customers</option>
                <option value="earners">Points earners</option>
                <option value="redeemers">Reward redeemers</option>
              </select>
            </label>
            <div className="filter-actions">
              <button type="submit" className="filter-apply">
                Apply filters
              </button>
              <a href="/app" className="filter-reset">
                Reset
              </a>
            </div>
          </form>
        </section>

        <section className="metrics-grid" aria-label="Loyalty metrics">
          {stats.map((stat) => (
            <article className="metric-card" key={stat.label}>
              <div className={`metric-icon ${stat.tone}`} aria-hidden="true" />
              <div>
                <span>{stat.label}</span>
                <strong>{formatter.format(stat.value)}</strong>
                <p>{stat.detail}</p>
              </div>
            </article>
          ))}
        </section>

        <section
          className="analytics-section revenue-panel"
          aria-labelledby="revenue-impact"
        >
          <div className="section-heading">
            <div>
              <h2 id="revenue-impact">Revenue impact</h2>
              <p>Order revenue connected to completed loyalty rewards.</p>
            </div>
            <span className="section-badge">
              {filters.range === "all" ? "All time" : filters.range}
            </span>
          </div>
          <div className="analytics-metric-grid">
            <article>
              <span>Attributed revenue</span>
              <strong>
                {currencyFormatter.format(analytics.revenue.attributedRevenue)}
              </strong>
              <p>
                {formatter.format(analytics.revenue.attributedOrders)} linked
                orders
              </p>
            </article>
            <article>
              <span>Reward value redeemed</span>
              <strong>
                {currencyFormatter.format(analytics.revenue.redemptionValue)}
              </strong>
              <p>Completed loyalty reward value</p>
            </article>
            <article>
              <span>Attributed order value</span>
              <strong>
                {currencyFormatter.format(analytics.revenue.averageOrderValue)}
              </strong>
              <p>Average across linked orders</p>
            </article>
            <article>
              <span>Revenue / reward value</span>
              <strong>
                {analytics.revenue.revenueToRewardRatio.toFixed(1)}×
              </strong>
              <p>Revenue generated per reward-value unit</p>
            </article>
          </div>
          <p className="analytics-note">
            Attributed revenue includes paid orders linked to applied discounts
            and gift cards. Store-credit issuance is included in redeemed value,
            but revenue is attributed only after a reward is linked to an order.
          </p>
        </section>

        <section
          className="analytics-chart-panel"
          aria-labelledby="redemption-trends"
        >
          <div className="section-heading">
            <div>
              <h2 id="redemption-trends">Redemption trends</h2>
              <p>
                {formatter.format(analytics.redemptions.count)} completed
                redemptions ·{" "}
                {formatter.format(analytics.redemptions.pointsRedeemed)} points
              </p>
            </div>
          </div>
          {analytics.redemptions.count > 0 ? (
            <div
              className="trend-chart"
              role="img"
              aria-label="Completed redemptions over time"
            >
              {analytics.redemptions.trend.map((bucket, index) => (
                <div className="trend-column" key={`${bucket.label}-${index}`}>
                  <span className="trend-value">
                    {formatter.format(bucket.redemptions)}
                  </span>
                  <div className="trend-track">
                    <span
                      className="trend-bar"
                      style={{
                        height: `${Math.max(4, (bucket.redemptions / maximumTrendRedemptions) * 100)}%`,
                      }}
                      title={`${bucket.label}: ${bucket.redemptions} redemptions`}
                    />
                  </div>
                  <span className="trend-label">{bucket.label}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="analytics-empty">
              No completed redemptions match these filters.
            </div>
          )}
        </section>

        <section className="reward-mix-panel" aria-labelledby="reward-mix">
          <div className="section-heading">
            <div>
              <h2 id="reward-mix">Reward mix</h2>
              <p>Completed redemptions by reward type.</p>
            </div>
          </div>
          <div className="mix-list">
            {analytics.redemptions.rewardMix.map((item) => (
              <div className="mix-item" key={item.type}>
                <div>
                  <span>{rewardTypeLabels[item.type]}</span>
                  <strong>{formatter.format(item.count)}</strong>
                </div>
                <div className="mix-track">
                  <span
                    style={{
                      width: `${(item.count / maximumRewardMix) * 100}%`,
                    }}
                  />
                </div>
                <small>{currencyFormatter.format(item.value)} value</small>
              </div>
            ))}
          </div>
        </section>

        <section
          className="analytics-section engagement-panel"
          aria-labelledby="customer-engagement"
        >
          <div className="section-heading">
            <div>
              <h2 id="customer-engagement">Customer engagement</h2>
              <p>Member participation during the selected period.</p>
            </div>
            <span className="engagement-rate">
              {percentFormatter.format(analytics.engagement.engagementRate)}%
              engaged
            </span>
          </div>
          <div className="engagement-grid">
            <article>
              <span>Active members</span>
              <strong>
                {formatter.format(analytics.engagement.activeMembers)}
              </strong>
              <p>Earned points or redeemed rewards</p>
            </article>
            <article>
              <span>Points earners</span>
              <strong>{formatter.format(analytics.engagement.earners)}</strong>
              <p>
                {formatter.format(analytics.redemptions.pointsEarned)} points
                earned
              </p>
            </article>
            <article>
              <span>Reward redeemers</span>
              <strong>
                {formatter.format(analytics.engagement.redeemers)}
              </strong>
              <p>Customers with completed rewards</p>
            </article>
            <article>
              <span>Repeat redeemers</span>
              <strong>
                {formatter.format(analytics.engagement.repeatRedeemers)}
              </strong>
              <p>Redeemed two or more times</p>
            </article>
            <article>
              <span>New members</span>
              <strong>
                {formatter.format(analytics.engagement.newMembers)}
              </strong>
              <p>Joined during this period</p>
            </article>
          </div>
        </section>

        <section className="table-panel" aria-labelledby="recent-customers">
          <div className="table-header">
            <div>
              <h2 id="recent-customers">Recent customers</h2>
              <p>{formatter.format(customers.length)} latest loyalty members</p>
            </div>
            <s-button href="/app/customers">View all customers</s-button>
          </div>

          {customers.length > 0 ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Email</th>
                    <th className="numeric">Points</th>
                  </tr>
                </thead>
                <tbody>
                  {customers.map((customer) => (
                    <tr key={customer.id}>
                      <td>{customer.name || "Unnamed customer"}</td>
                      <td>{customer.email || "No email"}</td>
                      <td className="numeric">
                        <span className="points-pill">
                          {formatter.format(customer.loyaltyPoints)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">
              <h3>No loyalty customers yet</h3>
              <p>New customers will appear here after they earn points.</p>
            </div>
          )}
        </section>
      </div>
    </s-page>
  );
}

const dashboardStyles = `
  .dashboard {
    display: grid;
    grid-template-columns: minmax(0, 1.45fr) minmax(280px, 0.8fr);
    gap: 16px;
    padding-block-end: 24px;
  }

  .hero-panel,
  .health-panel,
  .filter-panel,
  .metric-card,
  .analytics-section,
  .analytics-chart-panel,
  .reward-mix-panel,
  .table-panel {
    background: #ffffff;
    border: 1px solid #dcdfe4;
    border-radius: 8px;
    box-shadow: 0 1px 0 rgba(0, 0, 0, 0.04);
  }

  .hero-panel {
    display: flex;
    justify-content: space-between;
    gap: 24px;
    padding: 24px;
  }

  .hero-panel h2,
  .filter-panel h2,
  .section-heading h2,
  .table-header h2,
  .empty-state h3 {
    margin: 0;
    color: #202223;
    font-size: 20px;
    line-height: 28px;
    font-weight: 650;
  }

  .hero-panel p,
  .filter-panel p,
  .section-heading p,
  .table-header p,
  .empty-state p,
  .metric-card p {
    margin: 4px 0 0;
    color: #616a75;
    font-size: 13px;
    line-height: 20px;
  }

  .status-pill,
  .points-pill {
    display: inline-flex;
    align-items: center;
    width: fit-content;
    border-radius: 999px;
    font-size: 12px;
    line-height: 16px;
    font-weight: 650;
  }

  .status-pill {
    margin-block-end: 12px;
    padding: 3px 8px;
    color: #0c5132;
    background: #d1f7e6;
  }

  .hero-actions {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    flex-wrap: wrap;
  }

  .health-panel {
    padding: 20px;
  }

  .panel-heading {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    color: #616a75;
    font-size: 13px;
    line-height: 20px;
  }

  .health-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    margin-block-start: 16px;
  }

  .health-grid div {
    border-radius: 8px;
    background: #f6f6f7;
    padding: 14px;
  }

  .health-grid span,
  .metric-card span {
    display: block;
    color: #616a75;
    font-size: 12px;
    line-height: 16px;
    font-weight: 550;
  }

  .health-grid strong,
  .metric-card strong {
    display: block;
    margin-block-start: 6px;
    color: #202223;
    font-size: 24px;
    line-height: 32px;
    font-weight: 700;
  }

  .filter-panel {
    grid-column: 1 / -1;
    display: flex;
    justify-content: space-between;
    align-items: end;
    gap: 20px;
    padding: 18px 20px;
  }

  .analytics-filters {
    display: flex;
    align-items: end;
    justify-content: flex-end;
    gap: 10px;
    flex-wrap: wrap;
  }

  .analytics-filters label {
    display: grid;
    gap: 5px;
    color: #616a75;
    font-size: 12px;
    line-height: 16px;
    font-weight: 600;
  }

  .analytics-filters select {
    min-width: 148px;
    height: 36px;
    padding: 0 34px 0 10px;
    color: #202223;
    background: #fff;
    border: 1px solid #8c9196;
    border-radius: 8px;
    font: inherit;
    font-size: 13px;
  }

  .filter-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 36px;
  }

  .filter-apply {
    height: 36px;
    padding: 0 14px;
    color: #fff;
    background: #303030;
    border: 1px solid #303030;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 650;
    cursor: pointer;
  }

  .filter-apply:hover {
    background: #1f1f1f;
  }

  .filter-reset {
    color: #303030;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
  }

  .metrics-grid {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 16px;
  }

  .metric-card {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 14px;
    padding: 18px;
    min-block-size: 132px;
  }

  .metric-icon {
    width: 10px;
    height: 44px;
    border-radius: 999px;
    background: #8a8f98;
  }

  .metric-info {
    background: #91d0ff;
  }

  .metric-success {
    background: #4fd18b;
  }

  .metric-warning {
    background: #ffc453;
  }

  .metric-attention {
    background: #a6a6ff;
  }

  .analytics-section,
  .analytics-chart-panel,
  .reward-mix-panel {
    padding: 20px;
  }

  .analytics-section {
    grid-column: 1 / -1;
  }

  .analytics-chart-panel,
  .reward-mix-panel {
    min-width: 0;
  }

  .section-heading {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    margin-block-end: 18px;
  }

  .section-heading h2 {
    margin: 0;
  }

  .section-badge,
  .engagement-rate {
    display: inline-flex;
    align-items: center;
    min-height: 28px;
    padding: 4px 10px;
    border-radius: 999px;
    color: #3b3f44;
    background: #f1f2f3;
    font-size: 12px;
    font-weight: 650;
    white-space: nowrap;
  }

  .engagement-rate {
    color: #0c5132;
    background: #d1f7e6;
  }

  .analytics-metric-grid,
  .engagement-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
  }

  .analytics-metric-grid article,
  .engagement-grid article {
    padding: 16px;
    border: 1px solid #e3e5e7;
    border-radius: 8px;
    background: #fafafa;
  }

  .analytics-metric-grid span,
  .engagement-grid span {
    color: #616a75;
    font-size: 12px;
    font-weight: 600;
  }

  .analytics-metric-grid strong,
  .engagement-grid strong {
    display: block;
    margin-block-start: 7px;
    color: #202223;
    font-size: 24px;
    line-height: 30px;
  }

  .analytics-metric-grid p,
  .engagement-grid p,
  .analytics-note {
    margin: 4px 0 0;
    color: #616a75;
    font-size: 12px;
    line-height: 18px;
  }

  .analytics-note {
    margin-block-start: 14px;
    padding: 10px 12px;
    border-radius: 8px;
    background: #f6f6f7;
  }

  .trend-chart {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(34px, 1fr));
    align-items: end;
    gap: 8px;
    min-height: 220px;
    padding-block-start: 10px;
  }

  .trend-column {
    display: grid;
    grid-template-rows: 18px 150px auto;
    gap: 6px;
    min-width: 0;
    text-align: center;
  }

  .trend-value,
  .trend-label {
    overflow: hidden;
    color: #616a75;
    font-size: 10px;
    line-height: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .trend-track {
    display: flex;
    align-items: end;
    justify-content: center;
    height: 150px;
    border-radius: 6px;
    background: linear-gradient(to top, #f1f2f3 1px, transparent 1px);
    background-size: 100% 38px;
  }

  .trend-bar {
    display: block;
    width: min(28px, 75%);
    min-height: 4px;
    border-radius: 6px 6px 2px 2px;
    background: linear-gradient(180deg, #5c6ac4, #303f9f);
  }

  .mix-list {
    display: grid;
    gap: 18px;
  }

  .mix-item > div:first-child {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    color: #3b3f44;
    font-size: 13px;
  }

  .mix-track {
    height: 8px;
    margin-block: 7px 5px;
    overflow: hidden;
    border-radius: 999px;
    background: #eceff1;
  }

  .mix-track span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: #4fd18b;
  }

  .mix-item small {
    color: #616a75;
    font-size: 11px;
  }

  .analytics-empty {
    display: grid;
    place-items: center;
    min-height: 180px;
    color: #616a75;
    font-size: 13px;
    text-align: center;
  }

  .engagement-grid {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }

  .table-panel {
    grid-column: 1 / -1;
    overflow: hidden;
  }

  .table-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    padding: 18px 20px;
    border-block-end: 1px solid #e3e5e7;
  }

  .table-scroll {
    overflow-x: auto;
  }

  .dashboard table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    line-height: 20px;
  }

  .dashboard th,
  .dashboard td {
    padding: 12px 20px;
    border-block-end: 1px solid #eceff1;
    color: #202223;
    text-align: start;
  }

  .dashboard th {
    color: #616a75;
    background: #f6f6f7;
    font-weight: 650;
  }

  .dashboard tbody tr:hover {
    background: #fafafa;
  }

  .numeric {
    text-align: end;
  }

  .points-pill {
    justify-content: center;
    min-width: 36px;
    padding: 3px 8px;
    color: #0c5132;
    background: #d1f7e6;
  }

  .empty-state {
    padding: 28px 20px;
  }

  @media (max-width: 900px) {
    .dashboard {
      grid-template-columns: 1fr;
    }

    .metrics-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .filter-panel {
      align-items: flex-start;
      flex-direction: column;
    }

    .analytics-filters {
      justify-content: flex-start;
    }

    .analytics-metric-grid,
    .engagement-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 620px) {
    .hero-panel,
    .filter-panel,
    .table-header {
      flex-direction: column;
      align-items: flex-start;
    }

    .health-grid,
    .metrics-grid,
    .analytics-metric-grid,
    .engagement-grid {
      grid-template-columns: 1fr;
    }

    .analytics-filters,
    .analytics-filters label,
    .analytics-filters select {
      width: 100%;
    }

    .filter-actions {
      width: 100%;
      justify-content: space-between;
    }

    .dashboard th,
    .dashboard td {
      padding-inline: 14px;
    }
  }
`;
