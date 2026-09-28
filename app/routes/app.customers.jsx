import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { useMemo, useState } from "react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { logError, runShopifyGraphql } from "../services/errors.server";
import {
  CUSTOMER_SEGMENT_LABELS,
  CUSTOMER_SEGMENTS,
  filterSegmentedCustomers,
  getCustomerActivityDate,
  getSegmentCounts,
  normalizeSegmentFilter,
  normalizeSegmentationRules,
  segmentCustomers,
} from "../services/customer-segmentation.shared";
import { formatBirthday } from "../services/birthday-rewards.shared";

function parseSelectedCustomerIds(formData) {
  return formData
    .getAll("customerIds")
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);
}

function escapeCsvValue(value) {
  const text = String(value ?? "");

  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function buildSampleCsv(customers) {
  const headers = [
    "customerId",
    "shopifyCustomerId",
    "email",
    "operation",
    "points",
    "reason",
  ];
  const rows =
    customers.length > 0
      ? customers.map((customer) => [
          customer.id,
          customer.shopifyCustomerId,
          customer.email || "",
          "add",
          100,
          "CSV sample adjustment",
        ])
      : [["", "", "customer@example.com", "add", 100, "CSV sample adjustment"]];

  return [headers, ...rows]
    .map((row) => row.map(escapeCsvValue).join(","))
    .join("\n");
}

function normalizeShopifyCustomerGid(value) {
  const customerId = String(value || "").trim();

  if (!customerId) {
    return "";
  }

  if (customerId.startsWith("gid://shopify/Customer/")) {
    return customerId;
  }

  return `gid://shopify/Customer/${customerId.split("/").pop()}`;
}

function chunkItems(items, size) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function toValidDate(value) {
  const date = value ? new Date(value) : null;

  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function getLatestDate(leftValue, rightValue) {
  const left = toValidDate(leftValue);
  const right = toValidDate(rightValue);

  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  return right > left ? right : left;
}

function formatNullableDate(value) {
  const date = toValidDate(value);

  return date ? date.toLocaleDateString() : "No activity";
}

async function refreshCustomerMetricsFromShopify(admin, shopId) {
  const localCustomers = await prisma.customer.findMany({
    where: {
      shopId,
    },
    select: {
      id: true,
      shopifyCustomerId: true,
      lastActivityAt: true,
    },
  });
  const customersByGid = new Map(
    localCustomers
      .map((customer) => [
        normalizeShopifyCustomerGid(customer.shopifyCustomerId),
        customer,
      ])
      .filter(([customerGid]) => customerGid),
  );
  let updated = 0;
  let skipped = 0;

  for (const batch of chunkItems(Array.from(customersByGid.keys()), 100)) {
    const data = await runShopifyGraphql(
      admin,
      `#graphql
        query CustomerSegmentMetrics($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Customer {
              id
              amountSpent {
                amount
              }
              numberOfOrders
              lastOrder {
                createdAt
              }
            }
          }
        }
      `,
      {
        variables: {
          ids: batch,
        },
        operation: "Refresh customer segmentation metrics",
      },
    );

    for (const node of data.nodes || []) {
      if (!node?.id) {
        skipped += 1;
        continue;
      }

      const customer = customersByGid.get(node.id);

      if (!customer) {
        skipped += 1;
        continue;
      }

      const lastOrderAt = toValidDate(node.lastOrder?.createdAt);

      await prisma.customer.update({
        where: {
          id: customer.id,
        },
        data: {
          lifetimeSpend: Math.max(Number(node.amountSpent?.amount || 0), 0),
          orderCount: Math.max(Number(node.numberOfOrders || 0), 0),
          lastOrderAt,
          lastActivityAt: getLatestDate(customer.lastActivityAt, lastOrderAt),
        },
      });

      updated += 1;
    }
  }

  return {
    updated,
    skipped,
  };
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const nextCharacter = line[index + 1];

    if (character === '"' && quoted && nextCharacter === '"') {
      value += '"';
      index += 1;
      continue;
    }

    if (character === '"') {
      quoted = !quoted;
      continue;
    }

    if (character === "," && !quoted) {
      values.push(value.trim());
      value = "";
      continue;
    }

    value += character;
  }

  values.push(value.trim());
  return values;
}

function normalizeCsvHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function getCsvValue(row, aliases) {
  for (const alias of aliases) {
    const value = row[alias];

    if (value !== undefined && value !== "") {
      return value;
    }
  }

  return "";
}

function parseBulkPointsCsv(csvText) {
  const lines = String(csvText || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");

  if (lines.length < 2) {
    return {
      errors: ["CSV must include a header row and at least one data row."],
      rows: [],
    };
  }

  const headers = parseCsvLine(lines[0]).map(normalizeCsvHeader);
  const rows = [];
  const errors = [];

  lines.slice(1).forEach((line, lineIndex) => {
    const columns = parseCsvLine(line);
    const rawRow = {};

    headers.forEach((header, index) => {
      rawRow[header] = String(columns[index] || "").trim();
    });

    const rowNumber = lineIndex + 2;
    const operation = getCsvValue(rawRow, [
      "operation",
      "action",
    ]).toLowerCase();
    const points = Number(getCsvValue(rawRow, ["points", "point"]));
    const id = getCsvValue(rawRow, ["id", "customerid", "appcustomerid"]);
    const shopifyCustomerId = getCsvValue(rawRow, [
      "shopifycustomerid",
      "shopifyid",
      "customer_gid",
      "customergid",
    ]);
    const email = getCsvValue(rawRow, ["email", "customeremail"]);
    const reason = getCsvValue(rawRow, ["reason", "note"]);

    if (!["add", "deduct"].includes(operation)) {
      errors.push(`Row ${rowNumber}: operation must be add or deduct.`);
    }

    if (!Number.isInteger(points) || points < 1) {
      errors.push(
        `Row ${rowNumber}: points must be a whole number greater than 0.`,
      );
    }

    if (!id && !shopifyCustomerId && !email) {
      errors.push(
        `Row ${rowNumber}: provide customerId, shopifyCustomerId, or email.`,
      );
    }

    rows.push({
      rowNumber,
      operation,
      points,
      id: Number(id),
      shopifyCustomerId: shopifyCustomerId
        ? String(shopifyCustomerId).split("/").pop()
        : "",
      email: email.toLowerCase(),
      reason,
    });
  });

  return {
    errors,
    rows,
  };
}

async function applyPointAdjustment(tx, customer, operation, points, reason) {
  const pointsToChange =
    operation === "add"
      ? points
      : Math.min(points, Math.max(customer.loyaltyPoints || 0, 0));

  if (pointsToChange <= 0) {
    return 0;
  }

  await tx.customer.update({
    where: {
      id: customer.id,
    },
    data: {
      loyaltyPoints:
        operation === "add"
          ? {
              increment: pointsToChange,
            }
          : {
              decrement: pointsToChange,
            },
      lastActivityAt: new Date(),
    },
  });

  await tx.pointTransaction.create({
    data: {
      customerId: customer.id,
      points: pointsToChange,
      transactionType: operation === "add" ? "credit" : "debit",
      reason:
        reason ||
        (operation === "add"
          ? "Bulk points adjustment"
          : "Bulk points deduction"),
    },
  });

  return pointsToChange;
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const selectedSegment = normalizeSegmentFilter(
    url.searchParams.get("segment"),
  );
  let currencyCode = "USD";

  const shop = await prisma.shop.findUnique({
    where: {
      shopDomain: session.shop,
    },
    include: {
      loyaltySetting: true,
    },
  });

  if (!shop) {
    return Response.json({
      customers: [],
      totalCustomers: 0,
      segmentCounts: getSegmentCounts([]),
      selectedSegment,
      segmentationRules: normalizeSegmentationRules(),
      currencyCode,
    });
  }

  try {
    const currencyResponse = await admin.graphql(`#graphql
      query CustomersShopCurrency {
        shop {
          currencyCode
        }
      }
    `);
    const currencyData = await currencyResponse.json();
    currencyCode = currencyData.data?.shop?.currencyCode || currencyCode;
  } catch {
    currencyCode = "USD";
  }

  const customers = await prisma.customer.findMany({
    where: {
      shopId: shop.id,
    },
    include: {
      _count: {
        select: {
          rewards: true,
          transactions: true,
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });
  const segmentedCustomers = segmentCustomers(customers, shop.loyaltySetting);
  const filteredCustomers = filterSegmentedCustomers(
    segmentedCustomers,
    selectedSegment,
  );

  return Response.json({
    customers: filteredCustomers,
    totalCustomers: customers.length,
    segmentCounts: getSegmentCounts(segmentedCustomers),
    selectedSegment,
    segmentationRules: normalizeSegmentationRules(shop.loyaltySetting),
    currencyCode,
  });
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (
    ![
      "birthdayReset",
      "bulkPoints",
      "csvBulkPoints",
      "refreshSegments",
    ].includes(actionType)
  ) {
    return Response.json(
      {
        success: false,
        message: "Unsupported action.",
      },
      { status: 400 },
    );
  }

  const shop = await prisma.shop.findUnique({
    where: {
      shopDomain: session.shop,
    },
    select: {
      id: true,
    },
  });

  if (!shop) {
    return Response.json(
      {
        success: false,
        message: "Shop not found.",
      },
      { status: 404 },
    );
  }

  if (actionType === "birthdayReset") {
    const customerId = Number(formData.get("customerId"));

    if (!Number.isInteger(customerId) || customerId < 1) {
      return Response.json(
        { success: false, message: "Choose a valid customer." },
        { status: 400 },
      );
    }

    const result = await prisma.customer.updateMany({
      where: {
        id: customerId,
        shopId: shop.id,
      },
      data: {
        birthMonth: null,
        birthDay: null,
        birthdayProvidedAt: null,
        birthdayUpdatedAt: null,
      },
    });

    if (result.count !== 1) {
      return Response.json(
        { success: false, message: "Customer was not found." },
        { status: 404 },
      );
    }

    return Response.json({
      success: true,
      message:
        "Birthday entry reset. The customer can now enter it once again; annual reward history was preserved.",
    });
  }

  if (actionType === "refreshSegments") {
    let result;

    try {
      result = await refreshCustomerMetricsFromShopify(admin, shop.id);
    } catch (error) {
      logError("customers:refresh-segment-metrics", error, {
        shop: session.shop,
      });

      return Response.json(
        {
          success: false,
          message:
            "Could not refresh segment metrics from Shopify. Please try again.",
        },
        { status: 500 },
      );
    }

    return Response.json({
      success: true,
      message: `Segment metrics refreshed for ${result.updated.toLocaleString()} customer(s).`,
      ...result,
    });
  }

  if (actionType === "csvBulkPoints") {
    const csvFile = formData.get("csvFile");

    if (!csvFile || typeof csvFile.text !== "function") {
      return Response.json(
        {
          success: false,
          message: "Choose a CSV file to upload.",
        },
        { status: 400 },
      );
    }

    const parsedCsv = parseBulkPointsCsv(await csvFile.text());

    if (parsedCsv.errors.length > 0) {
      return Response.json(
        {
          success: false,
          message: parsedCsv.errors.slice(0, 5).join(" "),
        },
        { status: 400 },
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      let affectedCustomers = 0;
      let skipped = 0;
      let totalChanged = 0;

      for (const row of parsedCsv.rows) {
        const customer = await tx.customer.findFirst({
          where: {
            shopId: shop.id,
            OR: [
              ...(Number.isInteger(row.id) && row.id > 0
                ? [
                    {
                      id: row.id,
                    },
                  ]
                : []),
              ...(row.shopifyCustomerId
                ? [
                    {
                      shopifyCustomerId: row.shopifyCustomerId,
                    },
                  ]
                : []),
              ...(row.email
                ? [
                    {
                      email: row.email,
                    },
                  ]
                : []),
            ],
          },
          select: {
            id: true,
            loyaltyPoints: true,
          },
        });

        if (!customer) {
          skipped += 1;
          continue;
        }

        const pointsChanged = await applyPointAdjustment(
          tx,
          customer,
          row.operation,
          row.points,
          row.reason ||
            (row.operation === "add"
              ? "CSV bulk points adjustment"
              : "CSV bulk points deduction"),
        );

        if (pointsChanged > 0) {
          affectedCustomers += 1;
          totalChanged += pointsChanged;
        } else {
          skipped += 1;
        }
      }

      return {
        affectedCustomers,
        skipped,
        totalChanged,
      };
    });

    return Response.json({
      success: true,
      message: `CSV processed: updated ${result.affectedCustomers.toLocaleString()} customer(s), skipped ${result.skipped.toLocaleString()} row(s).`,
      ...result,
    });
  }

  const operation = String(formData.get("operation") || "");
  const points = Number(formData.get("points"));
  const reason = String(formData.get("reason") || "").trim();
  const customerIds = parseSelectedCustomerIds(formData);

  if (!["add", "deduct"].includes(operation)) {
    return Response.json(
      {
        success: false,
        message: "Choose add or deduct.",
      },
      { status: 400 },
    );
  }

  if (!Number.isInteger(points) || points < 1) {
    return Response.json(
      {
        success: false,
        message: "Enter whole points greater than 0.",
      },
      { status: 400 },
    );
  }

  if (customerIds.length === 0) {
    return Response.json(
      {
        success: false,
        message: "Select at least one customer.",
      },
      { status: 400 },
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const customers = await tx.customer.findMany({
      where: {
        shopId: shop.id,
        id: {
          in: customerIds,
        },
      },
      select: {
        id: true,
        loyaltyPoints: true,
      },
    });

    let totalChanged = 0;
    let skipped = 0;

    for (const customer of customers) {
      const pointsChanged = await applyPointAdjustment(
        tx,
        customer,
        operation,
        points,
        reason,
      );

      if (pointsChanged <= 0) {
        skipped += 1;
        continue;
      }

      totalChanged += pointsChanged;
    }

    return {
      affectedCustomers: customers.length,
      skipped,
      totalChanged,
    };
  });

  return Response.json({
    success: true,
    message:
      operation === "add"
        ? `Added ${points.toLocaleString()} points to ${result.affectedCustomers.toLocaleString()} customer(s).`
        : `Deducted points from ${result.affectedCustomers.toLocaleString()} customer(s).`,
    ...result,
  });
};

export default function CustomersPage() {
  const {
    customers = [],
    totalCustomers = 0,
    segmentCounts = {},
    selectedSegment = CUSTOMER_SEGMENTS.ALL,
    segmentationRules = {},
    currencyCode = "USD",
  } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const [selectedCustomerIds, setSelectedCustomerIds] = useState([]);
  const formatter = new Intl.NumberFormat("en");
  const currencyFormatter = new Intl.NumberFormat("en", {
    style: "currency",
    currency: currencyCode,
  });
  const isSubmitting = navigation.state === "submitting";
  const isRefreshingSegments =
    isSubmitting &&
    navigation.formData?.get("actionType") === "refreshSegments";
  const selectedCustomers = useMemo(
    () =>
      customers.filter((customer) => selectedCustomerIds.includes(customer.id)),
    [customers, selectedCustomerIds],
  );
  const totalPoints = customers.reduce(
    (sum, customer) => sum + (customer.loyaltyPoints || 0),
    0,
  );
  const totalRewards = customers.reduce(
    (sum, customer) => sum + (customer._count?.rewards || 0),
    0,
  );
  const totalSpend = customers.reduce(
    (sum, customer) => sum + Number(customer.lifetimeSpend || 0),
    0,
  );
  const selectedPoints = selectedCustomers.reduce(
    (sum, customer) => sum + (customer.loyaltyPoints || 0),
    0,
  );
  const allVisibleSelected =
    customers.length > 0 && selectedCustomerIds.length === customers.length;

  const downloadSampleCsv = () => {
    const csv = buildSampleCsv(customers);
    const blob = new Blob([csv], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "loyalty-bulk-points-sample.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const toggleCustomer = (customerId) => {
    setSelectedCustomerIds((ids) =>
      ids.includes(customerId)
        ? ids.filter((id) => id !== customerId)
        : [...ids, customerId],
    );
  };

  const toggleAllVisible = () => {
    setSelectedCustomerIds(
      allVisibleSelected ? [] : customers.map((customer) => customer.id),
    );
  };
  const segmentFilters = [
    CUSTOMER_SEGMENTS.ALL,
    CUSTOMER_SEGMENTS.VIP,
    CUSTOMER_SEGMENTS.TOP_SPENDER,
    CUSTOMER_SEGMENTS.INACTIVE,
  ];

  return (
    <s-page heading="Customers" inlineSize="large">
      <style>{customerStyles}</style>
      <div className="customers-layout">
        <section className="customer-summary" aria-label="Customer summary">
          <div>
            <span className="summary-label">Enrolled customers</span>
            <strong>{formatter.format(totalCustomers)}</strong>
            <span className="summary-note">
              Customers in this loyalty store
            </span>
          </div>
          <div>
            <span className="summary-label">Available points</span>
            <strong>{formatter.format(totalPoints)}</strong>
            <span className="summary-note">Current customer balance total</span>
          </div>
          <div>
            <span className="summary-label">Rewards created</span>
            <strong>{formatter.format(totalRewards)}</strong>
            <span className="summary-note">Redeemed reward records</span>
          </div>
          <div>
            <span className="summary-label">Lifetime spend</span>
            <strong>{currencyFormatter.format(totalSpend)}</strong>
            <span className="summary-note">Visible customer net spend</span>
          </div>
        </section>

        <section className="bulk-panel" aria-labelledby="bulk-points-heading">
          <div className="bulk-panel-header">
            <div>
              <h2 id="bulk-points-heading">Bulk points management</h2>
              <p>Add or deduct points for selected loyalty customers.</p>
            </div>
            <span>{formatter.format(selectedCustomerIds.length)} selected</span>
          </div>

          {actionData?.message ? (
            <div
              className={
                actionData.success
                  ? "bulk-message success"
                  : "bulk-message error"
              }
            >
              {actionData.message}
            </div>
          ) : null}

          <Form method="post" className="bulk-form">
            <input type="hidden" name="actionType" value="bulkPoints" />
            {selectedCustomerIds.map((customerId) => (
              <input
                key={customerId}
                type="hidden"
                name="customerIds"
                value={customerId}
              />
            ))}

            <div className="bulk-form-grid">
              <label className="bulk-field">
                <span>Action</span>
                <select name="operation" defaultValue="add">
                  <option value="add">Add points</option>
                  <option value="deduct">Deduct points</option>
                </select>
              </label>
              <label className="bulk-field">
                <span>Points</span>
                <input
                  name="points"
                  type="number"
                  min="1"
                  step="1"
                  inputMode="numeric"
                  placeholder="100"
                />
              </label>
              <label className="bulk-field bulk-reason">
                <span>Reason</span>
                <input
                  name="reason"
                  type="text"
                  placeholder="Campaign bonus, manual correction..."
                />
              </label>
            </div>

            <div className="bulk-footer">
              <div>
                <strong>{formatter.format(selectedCustomerIds.length)}</strong>
                <span>
                  selected customers with {formatter.format(selectedPoints)}{" "}
                  current points
                </span>
              </div>
              <s-button
                type="submit"
                variant="primary"
                loading={isSubmitting}
                disabled={selectedCustomerIds.length === 0 || isSubmitting}
              >
                Apply bulk update
              </s-button>
            </div>
          </Form>

          <Form
            method="post"
            encType="multipart/form-data"
            className="csv-form"
          >
            <input type="hidden" name="actionType" value="csvBulkPoints" />
            <div className="csv-card">
              <div className="csv-copy">
                <h3>Upload CSV</h3>
                <p>
                  Use columns: customerId, shopifyCustomerId, or email, plus
                  operation, points, and optional reason.
                </p>
                <s-button type="button" onClick={downloadSampleCsv}>
                  Download sample CSV
                </s-button>
              </div>
              <div className="csv-upload-area">
                <label className="bulk-field">
                  <span>CSV file</span>
                  <input name="csvFile" type="file" accept=".csv,text/csv" />
                </label>
                <pre className="csv-example">
                  email,shopifyCustomerId,operation,points,reason{"\n"}
                  customer@example.com,,add,100,VIP bonus{"\n"}
                  ,9165706985700,deduct,50,Manual correction
                </pre>
                <div className="bulk-footer">
                  <span>
                    Matched customers are updated. Unknown rows are skipped.
                  </span>
                  <s-button type="submit" loading={isSubmitting}>
                    Upload and apply CSV
                  </s-button>
                </div>
              </div>
            </div>
          </Form>
        </section>

        <section
          className="segment-panel"
          aria-labelledby="customer-segments-heading"
        >
          <div className="segment-panel-header">
            <div>
              <h2 id="customer-segments-heading">
                Customer segmentation rules
              </h2>
              <p>
                VIPs use lifetime spend, inactive customers use last order or
                loyalty activity, and top spenders use the configured spend
                percentile.
              </p>
            </div>
            <Form method="post">
              <input type="hidden" name="actionType" value="refreshSegments" />
              <s-button type="submit" loading={isRefreshingSegments}>
                Refresh metrics
              </s-button>
            </Form>
          </div>

          <div className="segment-rule-summary">
            <span>
              VIP at{" "}
              {currencyFormatter.format(
                segmentationRules.vipSpendThreshold || 0,
              )}
            </span>
            <span>
              Inactive after{" "}
              {formatter.format(segmentationRules.inactiveCustomerDays || 0)}{" "}
              days
            </span>
            <span>
              Top {formatter.format(segmentationRules.topSpenderPercent || 0)}%
              by spend
            </span>
          </div>

          <div className="segment-filter-grid">
            {segmentFilters.map((segment) => {
              const href =
                segment === CUSTOMER_SEGMENTS.ALL
                  ? "/app/customers"
                  : `/app/customers?segment=${segment}`;

              return (
                <a
                  className={
                    selectedSegment === segment
                      ? "segment-filter-card active"
                      : "segment-filter-card"
                  }
                  href={href}
                  key={segment}
                >
                  <span>{CUSTOMER_SEGMENT_LABELS[segment]}</span>
                  <strong>
                    {formatter.format(segmentCounts[segment] || 0)}
                  </strong>
                </a>
              );
            })}
          </div>
        </section>

        <section
          className="customer-panel"
          aria-labelledby="customer-list-heading"
        >
          <div className="customer-panel-header">
            <div>
              <h2 id="customer-list-heading">Customer list</h2>
              <p>Select customers before applying a bulk points update.</p>
            </div>
            <span>{formatter.format(customers.length)} shown</span>
          </div>

          {customers.length > 0 ? (
            <div className="customer-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th className="select-column">
                      <input
                        type="checkbox"
                        aria-label="Select all customers"
                        checked={allVisibleSelected}
                        onChange={toggleAllVisible}
                      />
                    </th>
                    <th>Customer</th>
                    <th>Email</th>
                    <th>Segments</th>
                    <th className="numeric">Lifetime spend</th>
                    <th className="numeric">Orders</th>
                    <th className="numeric">Points</th>
                    <th className="numeric">Transactions</th>
                    <th className="numeric">Rewards</th>
                    <th>Birthday</th>
                    <th>Last activity</th>
                    <th>Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {customers.map((customer) => (
                    <tr key={customer.id}>
                      <td className="select-column">
                        <input
                          type="checkbox"
                          aria-label={`Select ${
                            customer.name || customer.email || "customer"
                          }`}
                          checked={selectedCustomerIds.includes(customer.id)}
                          onChange={() => toggleCustomer(customer.id)}
                        />
                      </td>
                      <td>
                        <div className="customer-name-cell">
                          <span aria-hidden="true">
                            {(customer.name || customer.email || "U")
                              .trim()
                              .slice(0, 1)
                              .toUpperCase()}
                          </span>
                          <strong>{customer.name || "Unnamed customer"}</strong>
                        </div>
                      </td>
                      <td className="secondary">
                        {customer.email || "No email"}
                      </td>
                      <td>
                        <div className="segment-badges">
                          {customer.segments?.length > 0 ? (
                            customer.segments.map((segment) => (
                              <span className="segment-badge" key={segment}>
                                {CUSTOMER_SEGMENT_LABELS[segment]}
                              </span>
                            ))
                          ) : (
                            <span className="segment-badge muted">
                              Standard
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="numeric">
                        {currencyFormatter.format(customer.lifetimeSpend || 0)}
                      </td>
                      <td className="numeric">
                        {formatter.format(customer.orderCount || 0)}
                      </td>
                      <td className="numeric">
                        <span className="points-pill">
                          {formatter.format(customer.loyaltyPoints || 0)}
                        </span>
                      </td>
                      <td className="numeric">
                        {formatter.format(customer._count?.transactions || 0)}
                      </td>
                      <td className="numeric">
                        {formatter.format(customer._count?.rewards || 0)}
                      </td>
                      <td className="secondary">
                        <div className="birthday-admin-cell">
                          <span>
                            {customer.birthMonth && customer.birthDay
                              ? formatBirthday(
                                  customer.birthMonth,
                                  customer.birthDay,
                                )
                              : customer.birthdayProvidedAt
                                ? "Removed (locked)"
                                : "Not provided"}
                          </span>
                          {customer.birthdayProvidedAt ||
                          (customer.birthMonth && customer.birthDay) ? (
                            <Form
                              method="post"
                              onSubmit={(event) => {
                                if (
                                  !window.confirm(
                                    "Clear this birthday and allow the customer to enter it once again? Annual reward history will be preserved.",
                                  )
                                ) {
                                  event.preventDefault();
                                }
                              }}
                            >
                              <input
                                type="hidden"
                                name="actionType"
                                value="birthdayReset"
                              />
                              <input
                                type="hidden"
                                name="customerId"
                                value={customer.id}
                              />
                              <button
                                type="submit"
                                className="birthday-reset-button"
                                disabled={
                                  isSubmitting &&
                                  navigation.formData?.get("actionType") ===
                                    "birthdayReset" &&
                                  Number(
                                    navigation.formData?.get("customerId"),
                                  ) === customer.id
                                }
                              >
                                Allow correction
                              </button>
                            </Form>
                          ) : null}
                        </div>
                      </td>
                      <td className="secondary">
                        {formatNullableDate(getCustomerActivityDate(customer))}
                      </td>
                      <td className="secondary">
                        {new Date(customer.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="customer-empty-state">
              <div className="empty-icon" aria-hidden="true">
                0
              </div>
              <h3>No customers</h3>
              <p>
                Customers will appear here after they join your loyalty program.
              </p>
            </div>
          )}
        </section>
      </div>
    </s-page>
  );
}

const customerStyles = `
  .customers-layout { display: grid; gap: 18px; padding: 18px 0 32px; }
  .customer-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
  .customer-summary > div, .customer-panel, .bulk-panel, .segment-panel { background: #fff; border: 1px solid #dfe3e8; border-radius: 8px; box-shadow: 0 1px 0 rgba(26, 26, 26, .04); }
  .customer-summary > div { display: grid; gap: 4px; min-height: 108px; padding: 18px 20px; position: relative; }
  .customer-summary > div::before { background: #008060; border-radius: 999px; content: ""; height: 32px; position: absolute; right: 18px; top: 18px; width: 4px; }
  .summary-label { color: #5c6670; font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
  .customer-summary strong { color: #202223; font-size: 28px; line-height: 34px; }
  .summary-note { color: #6d7175; font-size: 13px; line-height: 18px; }
  .bulk-panel { display: grid; gap: 18px; padding: 22px; }
  .segment-panel { display: grid; gap: 16px; padding: 22px; }
  .bulk-panel-header { align-items: start; display: flex; gap: 16px; justify-content: space-between; }
  .segment-panel-header { align-items: start; display: flex; gap: 16px; justify-content: space-between; }
  .bulk-panel-header h2, .segment-panel-header h2 { margin: 0; color: #202223; font-size: 17px; line-height: 24px; }
  .bulk-panel-header p, .segment-panel-header p { margin: 4px 0 0; color: #5f6b76; font-size: 13px; }
  .bulk-panel-header span, .customer-panel-header > span { background: #eef7ff; border: 1px solid #b8dcff; border-radius: 999px; color: #005bd3; font-size: 12px; font-weight: 750; line-height: 16px; padding: 4px 10px; white-space: nowrap; }
  .bulk-message { border-radius: 8px; font-size: 13px; line-height: 20px; padding: 10px 12px; }
  .bulk-message.success { background: #eaf8f1; border: 1px solid #aee9d1; color: #006c48; }
  .bulk-message.error { background: #fff4f4; border: 1px solid #fed3d1; color: #b42318; }
  .bulk-form, .csv-form { display: grid; gap: 14px; }
  .bulk-form { background: #f7f9fb; border: 1px solid #e3e8ef; border-radius: 8px; padding: 16px; }
  .bulk-form-grid { align-items: end; display: grid; gap: 12px; grid-template-columns: minmax(180px, 1fr) minmax(140px, .65fr) minmax(260px, 2fr); width: 100%; }
  .bulk-reason { min-width: 0; }
  .bulk-field { display: grid; gap: 6px; min-width: 0; }
  .bulk-field span { color: #303030; font-size: 12px; font-weight: 750; line-height: 18px; }
  .bulk-field input, .bulk-field select { background: #fff; border: 1px solid #c9cccf; border-radius: 8px; box-sizing: border-box; color: #202223; font: inherit; height: 52px; min-width: 0; padding: 9px 11px; width: 100%; }
  .bulk-field input:focus, .bulk-field select:focus { border-color: #008060; box-shadow: 0 0 0 2px rgba(0, 128, 96, .14); outline: none; }
  .csv-form { border-top: 1px solid #e3e8ef; padding-top: 18px; }
  .csv-card { background: #fbfcfd; border: 1px solid #e3e8ef; border-radius: 8px; display: grid; gap: 18px; grid-template-columns: minmax(220px, .58fr) minmax(0, 1fr); padding: 16px; }
  .csv-copy { align-content: start; display: grid; gap: 10px; }
  .csv-copy h3 { color: #202223; font-size: 15px; line-height: 22px; margin: 0; }
  .csv-copy p { color: #5f6b76; font-size: 13px; line-height: 20px; margin: 0; }
  .csv-upload-area { display: grid; gap: 12px; min-width: 0; }
  .csv-example { background: #202223; border: 1px solid #30363d; border-radius: 8px; color: #dff7ec; font-size: 12px; line-height: 18px; margin: 0; overflow-x: auto; padding: 12px 14px; white-space: pre; }
  .bulk-footer { align-items: center; display: flex; gap: 16px; justify-content: space-between; }
  .bulk-footer > div { display: grid; gap: 2px; min-width: 0; }
  .bulk-footer strong { color: #202223; font-size: 18px; line-height: 24px; }
  .bulk-footer span { color: #5f6b76; font-size: 13px; line-height: 20px; }
  .customer-panel { overflow: hidden; }
  .segment-rule-summary { display: flex; flex-wrap: wrap; gap: 8px; }
  .segment-rule-summary span { background: #f7f9fb; border: 1px solid #e3e8ef; border-radius: 999px; color: #303030; font-size: 12px; font-weight: 700; line-height: 16px; padding: 6px 10px; }
  .segment-filter-grid { display: grid; gap: 12px; grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .segment-filter-card { background: #f7f9fb; border: 1px solid #e3e8ef; border-radius: 8px; color: inherit; display: grid; gap: 6px; padding: 14px; text-decoration: none; }
  .segment-filter-card.active { background: #eaf8f1; border-color: #008060; }
  .segment-filter-card span { color: #5c6670; font-size: 12px; font-weight: 800; letter-spacing: .04em; line-height: 16px; text-transform: uppercase; }
  .segment-filter-card strong { color: #202223; font-size: 24px; line-height: 30px; }
  .customer-panel-header { align-items: center; border-bottom: 1px solid #e3e8ef; display: flex; gap: 16px; justify-content: space-between; padding: 18px 22px; }
  .customer-panel-header h2 { margin: 0; color: #202223; font-size: 17px; line-height: 24px; }
  .customer-panel-header p { margin: 3px 0 0; color: #5f6b76; font-size: 13px; }
  .customer-table-scroll { overflow-x: auto; }
  .customer-panel table { width: 100%; border-collapse: collapse; min-width: 1120px; }
  .customer-panel th { padding: 12px 16px; background: #f7f9fb; border-bottom: 1px solid #e3e8ef; color: #5c6670; font-size: 11px; font-weight: 800; letter-spacing: .04em; text-align: left; text-transform: uppercase; }
  .customer-panel td { padding: 16px; border-bottom: 1px solid #edf0f3; color: #202223; font-size: 13px; vertical-align: middle; }
  .customer-panel tbody tr:last-child td { border-bottom: 0; }
  .customer-panel tbody tr:hover { background: #f9fbfa; }
  .customer-panel input[type="checkbox"] { accent-color: #008060; height: 18px; width: 18px; }
  .select-column { text-align: center; width: 44px; }
  .customer-panel .numeric { text-align: right; }
  .customer-panel .secondary { color: #616a75; }
  .customer-name-cell { align-items: center; display: flex; gap: 10px; }
  .customer-name-cell span { align-items: center; background: #e3f8ef; border: 1px solid #aee9d1; border-radius: 999px; color: #006c48; display: inline-flex; flex: 0 0 auto; font-size: 12px; font-weight: 800; height: 30px; justify-content: center; width: 30px; }
  .segment-badges { display: flex; flex-wrap: wrap; gap: 6px; min-width: 170px; }
  .segment-badge { background: #eef7ff; border: 1px solid #b8dcff; border-radius: 999px; color: #005bd3; display: inline-flex; font-size: 11px; font-weight: 800; line-height: 14px; padding: 4px 8px; white-space: nowrap; }
  .segment-badge.muted { background: #f1f2f3; border-color: #d9dce0; color: #616a75; }
  .points-pill { display: inline-flex; min-width: 48px; justify-content: center; padding: 5px 12px; border-radius: 999px; background: #dff7ec; color: #006c48; font-weight: 800; }
  .birthday-admin-cell { align-items: start; display: grid; gap: 6px; min-width: 128px; }
  .birthday-reset-button { background: transparent; border: 0; color: #005bd3; cursor: pointer; font: inherit; padding: 0; text-align: left; text-decoration: underline; }
  .birthday-reset-button:disabled { cursor: wait; opacity: .6; }
  .customer-empty-state { display: grid; justify-items: center; padding: 52px 24px 58px; text-align: center; }
  .empty-icon { display: grid; place-items: center; width: 44px; height: 44px; margin-bottom: 14px; border-radius: 50%; background: #f1f2f3; color: #616a75; font-size: 0; }
  .empty-icon::before { content: ""; width: 14px; height: 14px; border: 2px solid currentColor; border-radius: 50%; }
  .customer-empty-state h3 { margin: 0; color: #202223; font-size: 16px; }
  .customer-empty-state p { margin: 6px 0 0; color: #616a75; font-size: 13px; }
  @media (max-width: 1000px) { .customer-summary, .segment-filter-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 900px) { .bulk-form-grid, .csv-card { grid-template-columns: 1fr; } .bulk-footer, .segment-panel-header { align-items: stretch; display: grid; } }
  @media (max-width: 700px) { .customer-summary, .segment-filter-grid { grid-template-columns: 1fr; } }
`;
