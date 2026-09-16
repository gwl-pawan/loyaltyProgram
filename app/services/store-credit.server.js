import { unauthenticated } from "../shopify.server";
import { logError, runShopifyGraphql } from "./errors.server";

const STORE_CREDIT_TRANSACTION_TYPES = {
  StoreCreditAccountCreditTransaction: "credit",
  StoreCreditAccountDebitTransaction: "debit",
  StoreCreditAccountDebitRevertTransaction: "debit_revert",
  StoreCreditAccountExpirationTransaction: "expiration",
};

function normalizeCustomerId(customerId) {
  const value = String(customerId || "").trim();

  if (!value) return null;
  if (value.startsWith("gid://shopify/Customer/")) return value;

  return `gid://shopify/Customer/${value.split("/").pop()}`;
}

function normalizeMoney(money) {
  const amount = Number(money?.amount);

  return {
    amount: Number.isFinite(amount) ? amount : 0,
    currencyCode: money?.currencyCode || null,
  };
}

function getTransactionId(transaction) {
  return (
    transaction?.id ||
    transaction?.creditTransaction?.id ||
    transaction?.debitTransaction?.id ||
    null
  );
}

export function normalizeStoreCreditTransaction(transaction, accountId) {
  const type =
    STORE_CREDIT_TRANSACTION_TYPES[transaction?.__typename] || "unknown";
  const money = normalizeMoney(transaction?.amount);
  const signedAmount = ["debit", "expiration"].includes(type)
    ? -Math.abs(money.amount)
    : Math.abs(money.amount);
  const orderTransaction =
    transaction?.origin?.__typename === "OrderTransaction"
      ? transaction.origin
      : null;

  return {
    id: getTransactionId(transaction),
    accountId,
    type,
    amount: signedAmount,
    currencyCode: money.currencyCode,
    balanceAfterTransaction: normalizeMoney(
      transaction?.balanceAfterTransaction,
    ).amount,
    createdAt: transaction?.createdAt || null,
    event: transaction?.event || null,
    expiresAt: transaction?.expiresAt || null,
    remainingAmount:
      transaction?.remainingAmount == null
        ? null
        : normalizeMoney(transaction.remainingAmount).amount,
    relatedTransactionId:
      transaction?.debitTransaction?.id ||
      transaction?.creditTransaction?.id ||
      null,
    orderId: orderTransaction?.order?.id || null,
    orderName: orderTransaction?.order?.name || null,
    orderTransactionId: orderTransaction?.id || null,
  };
}

export async function getCustomerStoreCreditSnapshot({
  shopDomain,
  customerId,
  preferredCurrencyCode,
  includeTransactions = false,
  transactionLimit = 50,
  operation = "Load Shopify store credit",
}) {
  const shopifyCustomerId = normalizeCustomerId(customerId);

  if (!shopDomain || !shopifyCustomerId) {
    return null;
  }

  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    const query = includeTransactions
      ? `
        #graphql
        query CustomerStoreCreditHistory($id: ID!, $transactionLimit: Int!) {
          customer(id: $id) {
            storeCreditAccounts(first: 10) {
              nodes {
                id
                balance { amount currencyCode }
                transactions(
                  first: $transactionLimit
                  sortKey: CREATED_AT
                  reverse: true
                ) {
                  nodes {
                    __typename
                    amount { amount currencyCode }
                    balanceAfterTransaction { amount currencyCode }
                    createdAt
                    event
                    origin {
                      __typename
                      ... on OrderTransaction {
                        id
                        order {
                          id
                          name
                        }
                      }
                    }
                    ... on StoreCreditAccountCreditTransaction {
                      id
                      expiresAt
                      remainingAmount { amount currencyCode }
                    }
                    ... on StoreCreditAccountDebitTransaction { id }
                    ... on StoreCreditAccountDebitRevertTransaction {
                      id
                      debitTransaction { id }
                    }
                    ... on StoreCreditAccountExpirationTransaction {
                      creditTransaction { id }
                    }
                  }
                }
              }
            }
          }
        }
      `
      : `
        #graphql
        query CustomerStoreCreditBalance($id: ID!) {
          customer(id: $id) {
            storeCreditAccounts(first: 10) {
              nodes {
                id
                balance { amount currencyCode }
              }
            }
          }
        }
      `;
    const data = await runShopifyGraphql(admin, query, {
      variables: {
        id: shopifyCustomerId,
        ...(includeTransactions ? { transactionLimit } : {}),
      },
      operation,
    });

    const accounts = (data.customer?.storeCreditAccounts?.nodes || []).map(
      (account) => ({
        id: account.id,
        ...normalizeMoney(account.balance),
      }),
    );
    const preferredAccount =
      accounts.find(
        (account) => account.currencyCode === preferredCurrencyCode,
      ) || accounts[0];
    const transactions = includeTransactions
      ? (data.customer?.storeCreditAccounts?.nodes || [])
          .flatMap((account) =>
            (account.transactions?.nodes || []).map((transaction) =>
              normalizeStoreCreditTransaction(transaction, account.id),
            ),
          )
          .sort(
            (left, right) =>
              new Date(right.createdAt || 0) - new Date(left.createdAt || 0),
          )
      : [];

    return {
      balance: preferredAccount
        ? {
            amount: preferredAccount.amount,
            currencyCode: preferredAccount.currencyCode,
          }
        : {
            amount: 0,
            currencyCode: preferredCurrencyCode || null,
          },
      accounts,
      transactions,
    };
  } catch (error) {
    logError("store-credit:snapshot", error, {
      shopDomain,
      customerId: shopifyCustomerId,
      includeTransactions,
    });
    return null;
  }
}
