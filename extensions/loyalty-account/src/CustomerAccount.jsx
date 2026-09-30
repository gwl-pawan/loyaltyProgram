import "@shopify/ui-extensions/preact";
/* global globalThis */
import {
  useAuthenticatedAccountCustomer,
  useSettings,
} from "@shopify/ui-extensions/customer-account/preact";
import { render } from "preact";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "preact/hooks";
import { fetchApiJson } from "./api";
import { API_BASE_URL as FALLBACK_API_BASE_URL } from "./api-base-url";
import { API_BASE_URL } from "./api-base-url.generated";

const HISTORY_PAGE_SIZE = 8;
const APP_PROXY_PATH = "/apps/loyalty-points";

const ACTIVITY_APPEARANCE = {
  discount_created: { icon: "info", tone: "info" },
  discount_applied: { icon: "check-circle", tone: "success" },
  discount_expired: { icon: "clock", tone: "warning" },
  discount_failed: { icon: "x-circle", tone: "critical" },
  gift_card_created: { icon: "info", tone: "info" },
  gift_card_applied: { icon: "check-circle", tone: "success" },
  gift_card_failed: { icon: "x-circle", tone: "critical" },
  store_credit_created: { icon: "check-circle", tone: "success" },
  store_credit_failed: { icon: "x-circle", tone: "critical" },
  points_refunded: { icon: "return", tone: "success" },
  points_expired: { icon: "clock", tone: "warning" },
  birthday_rewarded: { icon: "gift-card", tone: "success" },
  special_date_rewarded: { icon: "gift-card", tone: "success" },
};

function getRewardTypeBadge(activityType) {
  if (activityType?.startsWith("gift_card")) {
    return { icon: "gift-card", label: "GIFT CARD", tone: "warning" };
  }

  if (activityType?.startsWith("store_credit")) {
    return { icon: "cash-dollar", label: "STORE CREDIT", tone: "success" };
  }

  if (activityType === "points_refunded") {
    return { icon: "return", label: "POINTS", tone: "success" };
  }

  if (activityType === "points_expired") {
    return { icon: "clock", label: "POINTS", tone: "warning" };
  }

  if (
    activityType === "birthday_rewarded" ||
    activityType === "special_date_rewarded"
  ) {
    return { icon: "gift-card", label: "POINTS", tone: "success" };
  }

  return { icon: "discount", label: "DISCOUNT", tone: "info" };
}

function getActivityStatusLabel(label) {
  const status = String(label || "Activity")
    .trim()
    .split(/\s+/)
    .pop();

  return status
    ? `${status.charAt(0).toUpperCase()}${status.slice(1).toLowerCase()}`
    : "Activity";
}

function getHistorySearchText(item) {
  const createdAt = item.createdAt ? new Date(item.createdAt) : null;

  return [
    item.label,
    item.activityType,
    item.rewardCode,
    item.pointsUsed,
    item.discountAmount,
    item.orderName,
    item.orderId,
    item.message,
    item.customerName,
    item.customerEmail,
    createdAt?.toISOString(),
    createdAt?.toLocaleString(),
  ]
    .filter((value) => value !== null && value !== undefined)
    .join(" ")
    .toLowerCase();
}

function getSettingValue(settings, key, fallback) {
  const value = settings?.[key];

  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function formatSettingText(value, replacements) {
  return Object.entries(replacements).reduce((text, [key, replacement]) => {
    return text
      .replaceAll(`{${key}}`, String(replacement))
      .replaceAll(`{{${key}}}`, String(replacement));
  }, value);
}

function formatCurrency(value, currencyCode = "USD") {
  const amount = Number(value || 0);

  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: currencyCode,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currencyCode} ${amount.toLocaleString("en")}`;
  }
}

function getStoreCreditTransactionLabel(type) {
  return (
    {
      credit: "Credit added",
      debit: "Used at checkout",
      debit_revert: "Credit returned",
      expiration: "Credit expired",
    }[type] || "Balance updated"
  );
}

function getStoreCreditTransactionTone(type) {
  if (type === "expiration") return "critical";
  if (type === "debit") return "warning";
  return "success";
}

function formatOrderReference(orderName) {
  const reference = String(orderName || "").trim();
  const orderNumber = reference.match(/^#?(\d+)$/)?.[1];

  if (orderNumber) return `#${orderNumber}`;
  return reference.startsWith("gid://") ? "-" : reference || "-";
}

/** @param {any} event */
function getFormControlValue(event) {
  const inputSource = event.composedPath?.()[0];
  return String(
    inputSource?.value ??
      event.detail?.value ??
      event.target?.value ??
      event.currentTarget?.value ??
      "",
  );
}

function normalizeStoreCreditReward(reward) {
  const points = Number(reward?.points);
  const amount = Number(reward?.amount);

  if (
    reward?.type !== "store_credit" ||
    !Number.isInteger(points) ||
    points < 1 ||
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    return null;
  }

  return {
    type: "store_credit",
    points,
    amount,
    title: reward?.title || "Store credit",
  };
}

function normalizeApiBaseUrl(value) {
  return typeof value === "string" ? value.trim().replace(/\/$/, "") : "";
}

function normalizeShopDomain(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }

  try {
    return new URL(value).hostname;
  } catch {
    return value
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
  }
}

function decodeJwtPayload(token) {
  try {
    const payload = token.split(".")[1];
    const normalizedPayload = payload
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(payload.length / 4) * 4, "=");

    return JSON.parse(globalThis.atob(normalizedPayload));
  } catch {
    return null;
  }
}

function getShopDomainFromSessionToken(token) {
  const payload = decodeJwtPayload(token);

  return normalizeShopDomain(payload?.dest || payload?.shop || payload?.iss);
}

async function getShopDomainFromStorefrontApi() {
  const response = await shopify.query(`
    query LoyaltyShopDomain {
      shop {
        primaryDomain {
          url
        }
      }
    }
  `);

  return normalizeShopDomain(response?.data?.shop?.primaryDomain?.url);
}

function isAppProxyBaseUrl(value) {
  try {
    return new URL(value).pathname.replace(/\/$/, "") === APP_PROXY_PATH;
  } catch {
    return false;
  }
}

function getApiBaseUrls() {
  const generatedUrl = normalizeApiBaseUrl(API_BASE_URL);
  const fallbackUrl = normalizeApiBaseUrl(FALLBACK_API_BASE_URL);

  return [...new Set([generatedUrl, fallbackUrl].filter(Boolean))];
}

function buildApiUrl(apiBaseUrl, endpoint, params) {
  const baseUrl = normalizeApiBaseUrl(apiBaseUrl);
  const path =
    isAppProxyBaseUrl(baseUrl) && endpoint === "loyalty-balance"
      ? baseUrl
      : `${baseUrl}/api/${endpoint}`;

  return params ? `${path}?${params}` : path;
}

function buildApiUrls(apiBaseUrls, endpoint, params) {
  return apiBaseUrls.map((apiBaseUrl) =>
    buildApiUrl(apiBaseUrl, endpoint, params),
  );
}

function buildCustomerAccountIframeUrl(
  apiBaseUrls,
  customerId,
  customerEmail,
  shopDomain,
) {
  const apiBaseUrl = normalizeApiBaseUrl(apiBaseUrls[0]);

  if (!apiBaseUrl || !customerId) {
    return "";
  }

  const params = new URLSearchParams({
    customerId,
    customerEmail: customerEmail || "",
    shop: shopDomain || "",
    redeemUrl: `${apiBaseUrl}/api/redeem-points`,
    surface: "account",
    heading: "Rewards wallet",
    eyebrow: "Loyalty",
    rewardsHeading: "Available store credit rewards",
    noRewardsMessage: "Store credit rewards are not configured yet.",
  });

  return `${apiBaseUrl}/api/loyalty-iframe?${params}`;
}

export function renderLoyaltyAccountExtension() {
  render(<CustomerAccountLoyaltyPoints />, document.body);
}

export default function extension() {
  renderLoyaltyAccountExtension();
}

export function CustomerAccountLoyaltyPoints() {
  const settings = useSettings();
  const customer = useAuthenticatedAccountCustomer();
  const [proxyShopDomain, setProxyShopDomain] = useState("");
  const [isResolvingProxyBaseUrl, setIsResolvingProxyBaseUrl] = useState(true);
  const apiBaseUrls = useMemo(() => getApiBaseUrls(), []);
  const apiBaseUrlsKey = apiBaseUrls.join("|");
  const accountRenderMode = getSettingValue(
    settings,
    "accountRenderMode",
    "native",
  );

  const [points, setPoints] = useState(0);
  const [customerId, setCustomerId] = useState(null);
  const [storeCreditReward, setStoreCreditReward] = useState(null);
  const [storeCreditBalance, setStoreCreditBalance] = useState(null);
  const [storeCreditAccounts, setStoreCreditAccounts] = useState([]);
  const [storeCreditHistory, setStoreCreditHistory] = useState([]);
  const [currencyCode, setCurrencyCode] = useState("USD");
  const [storeCreditPoints, setStoreCreditPoints] = useState("");
  const [isLoading, setIsLoading] = useState(Boolean(customer?.id));
  const [isRedeeming, setIsRedeeming] = useState(false);
  const [isRedemptionEnabled, setIsRedemptionEnabled] = useState(true);
  const [message, setMessage] = useState("");
  const [apiTextSettings, setApiTextSettings] = useState({});
  const [activeTab, setActiveTab] = useState("balance");
  const [history, setHistory] = useState([]);
  const [referral, setReferral] = useState(null);
  const [birthday, setBirthday] = useState(null);
  const [birthdayMonth, setBirthdayMonth] = useState("");
  const [birthdayDay, setBirthdayDay] = useState("");
  const [isSavingBirthday, setIsSavingBirthday] = useState(false);
  const [specialDates, setSpecialDates] = useState(null);
  const [specialDateValues, setSpecialDateValues] = useState({});
  const [savingSpecialDateSlot, setSavingSpecialDateSlot] = useState(null);
  const [historySearch, setHistorySearch] = useState("");
  const [historyPage, setHistoryPage] = useState(1);
  const [storeCreditHistoryPage, setStoreCreditHistoryPage] = useState(1);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const confirmationModalRef = useRef(null);
  const historyRequestIdRef = useRef(0);
  const pointsLabel = `${points.toLocaleString()} ${points === 1 ? "point" : "points"}`;

  // Extension editor values override API-managed defaults.
  const getTextSetting = (key, fallback) => {
    return getSettingValue(settings, key, apiTextSettings[key] ?? fallback);
  };

  const loginMessage = getTextSetting(
    "accountLoginMessage",
    "Sign in to view loyalty points.",
  );
  const balanceTitle = getTextSetting("accountBalanceTitle", "Loyalty balance");
  const availableLabel = getTextSetting(
    "accountAvailableLabel",
    "Available points",
  );
  const currentBalanceLabel = getTextSetting(
    "accountCurrentBalance",
    "Current balance",
  );
  const storeCreditTitle = getTextSetting(
    "accountStoreCreditTitle",
    "Store Credit Reward",
  );
  const conversionRateText = getTextSetting(
    "accountConversionRateText",
    "{points} points = {amount} store credit",
  );
  const loadingText = getTextSetting("accountLoadingText", "Loading...");
  const redeemingText = getTextSetting("accountRedeemingText", "Converting...");
  const convertButtonText = getTextSetting(
    "accountRedeemButtonText",
    "Convert to store credit",
  );
  const disabledMsg = getTextSetting(
    "accountDisabledMsg",
    "Store credit conversion is currently disabled.",
  );
  const notEnoughPtsMsg = getTextSetting(
    "accountNotEnoughPtsMsg",
    "Earn {remaining_points} more points to convert this amount.",
  );
  const storeCreditSuccessMsg = getTextSetting(
    "accountGiftCardMsg",
    "Store credit added: {amount}",
  );
  const errorMsg = getTextSetting(
    "accountErrorMsg",
    "Could not convert points to store credit",
  );
  const configErrorMsg = getTextSetting(
    "accountConfigErrorMsg",
    "Loyalty API URL is not configured.",
  );
  const iframeButtonText = getTextSetting(
    "accountIframeButtonText",
    "Open rewards wallet",
  );
  const iframeDescription = getTextSetting(
    "accountIframeDescription",
    "Open the iframe version of your loyalty wallet with your current points and rewards.",
  );
  const customerAccountIframeUrl = buildCustomerAccountIframeUrl(
    apiBaseUrls,
    customer?.id,
    customer?.emailAddress?.emailAddress,
    proxyShopDomain,
  );

  useEffect(() => {
    let isCurrent = true;

    async function loadProxyBaseUrl() {
      try {
        const token = await shopify.sessionToken.get();
        const shopDomain =
          getShopDomainFromSessionToken(token) ||
          (await getShopDomainFromStorefrontApi());

        if (isCurrent) {
          setProxyShopDomain(shopDomain);
        }
      } catch (error) {
        console.error("Could not resolve account app proxy URL", error);
      } finally {
        if (isCurrent) {
          setIsResolvingProxyBaseUrl(false);
        }
      }
    }

    loadProxyBaseUrl();

    return () => {
      isCurrent = false;
    };
  }, []);

  useEffect(() => {
    if (isResolvingProxyBaseUrl) {
      return;
    }

    if (apiBaseUrls.length === 0) {
      setIsLoading(false);
      setPoints(0);
      setCustomerId(null);
      setStoreCreditReward(null);
      setStoreCreditBalance(null);
      setStoreCreditAccounts([]);
      setStoreCreditHistory([]);
      setStoreCreditPoints("");
      setIsRedemptionEnabled(true);
      setMessage(configErrorMsg);
      return;
    }

    if (!customer?.id) {
      setIsLoading(false);
      setPoints(0);
      setCustomerId(null);
      setStoreCreditReward(null);
      setStoreCreditBalance(null);
      setStoreCreditAccounts([]);
      setStoreCreditHistory([]);
      setStoreCreditPoints("");
      setIsRedemptionEnabled(true);
      setMessage(loginMessage);
      return;
    }

    let isCurrent = true;

    async function loadPoints() {
      setIsLoading(true);
      setMessage("");

      try {
        const params = new URLSearchParams({
          customerId: customer.id,
          shop: proxyShopDomain,
        });

        const data = await fetchApiJson(
          buildApiUrls(apiBaseUrls, "loyalty-balance", params),
          undefined,
          "Could not load points. Please try again.",
        );

        if (!isCurrent) return;

        if (!data.success) {
          throw new Error(data.message || "Could not load points");
        }

        setCustomerId(data.customerId);
        setPoints(data.loyaltyPoints || 0);
        setCurrencyCode(data.currencyCode || "USD");
        setStoreCreditBalance(data.storeCreditBalance || null);
        setStoreCreditAccounts(data.storeCreditAccounts || []);
        setIsRedemptionEnabled(data.checkoutRedemptionEnabled !== false);
        const nextStoreCreditReward = normalizeStoreCreditReward(
          data.storeCreditReward,
        );
        setStoreCreditReward(nextStoreCreditReward);
        setStoreCreditPoints(
          nextStoreCreditReward ? String(nextStoreCreditReward.points) : "",
        );
        // Store API text settings
        setApiTextSettings(data);
      } catch (error) {
        console.error(error);

        if (isCurrent) {
          setPoints(0);
          setCustomerId(null);
          setStoreCreditReward(null);
          setStoreCreditBalance(null);
          setStoreCreditAccounts([]);
          setStoreCreditPoints("");
          setMessage(error.message || "Could not load points");
        }
      } finally {
        if (isCurrent) {
          setIsLoading(false);
        }
      }
    }

    loadPoints();

    return () => {
      isCurrent = false;
    };
  }, [
    apiBaseUrlsKey,
    apiBaseUrls,
    customer?.id,
    configErrorMsg,
    isResolvingProxyBaseUrl,
    loginMessage,
    proxyShopDomain,
  ]);

  useEffect(() => {
    if (isResolvingProxyBaseUrl || !customer?.id || apiBaseUrls.length === 0) {
      setReferral(null);
      return;
    }

    let isCurrent = true;

    async function loadReferral() {
      try {
        const token = await shopify.sessionToken.get();
        const data = await fetchApiJson(
          buildApiUrls(apiBaseUrls, "customer-account/referrals"),
          { headers: { Authorization: `Bearer ${token}` } },
          "Could not load referral details.",
        );

        if (isCurrent) setReferral(data.referral || null);
      } catch (error) {
        console.error("Could not load referral details", error);
        if (isCurrent) setReferral(null);
      }
    }

    loadReferral();
    return () => {
      isCurrent = false;
    };
  }, [apiBaseUrls, apiBaseUrlsKey, customer?.id, isResolvingProxyBaseUrl]);

  useEffect(() => {
    if (isResolvingProxyBaseUrl || !customer?.id || apiBaseUrls.length === 0) {
      setBirthday(null);
      return;
    }

    let isCurrent = true;
    async function loadBirthday() {
      try {
        const token = await shopify.sessionToken.get();
        const data = await fetchApiJson(
          buildApiUrls(apiBaseUrls, "customer-account/birthday"),
          { headers: { Authorization: `Bearer ${token}` } },
          "Could not load birthday details.",
        );
        if (!isCurrent) return;
        setBirthday(data.birthday || null);
        setBirthdayMonth(String(data.birthday?.birthday?.month || ""));
        setBirthdayDay(String(data.birthday?.birthday?.day || ""));
      } catch (error) {
        console.error("Could not load birthday details", error);
      }
    }

    loadBirthday();
    return () => {
      isCurrent = false;
    };
  }, [apiBaseUrls, apiBaseUrlsKey, customer?.id, isResolvingProxyBaseUrl]);

  const saveBirthday = async (action = "save") => {
    setIsSavingBirthday(true);
    setMessage("");
    try {
      const token = await shopify.sessionToken.get();
      const data = await fetchApiJson(
        buildApiUrls(apiBaseUrls, "customer-account/birthday"),
        {
          method: action === "delete" ? "DELETE" : "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(
            action === "delete"
              ? { action: "delete" }
              : {
                  birthday: {
                    month: Number(birthdayMonth),
                    day: Number(birthdayDay),
                  },
                },
          ),
        },
        "Could not save birthday.",
      );
      setBirthday(data.birthday || null);
      setBirthdayMonth(String(data.birthday?.birthday?.month || ""));
      setBirthdayDay(String(data.birthday?.birthday?.day || ""));
      setMessage(
        action === "delete"
          ? "Birthday removed."
          : "Birthday saved for annual rewards.",
      );
    } catch (error) {
      setMessage(error.message || "Could not save birthday.");
    } finally {
      setIsSavingBirthday(false);
    }
  };

  useEffect(() => {
    if (isResolvingProxyBaseUrl || !customer?.id || apiBaseUrls.length === 0) {
      setSpecialDates(null);
      return;
    }

    let isCurrent = true;
    async function loadSpecialDates() {
      try {
        const token = await shopify.sessionToken.get();
        const data = await fetchApiJson(
          buildApiUrls(apiBaseUrls, "customer-account/special-dates"),
          { headers: { Authorization: `Bearer ${token}` } },
          "Could not load special dates.",
        );
        if (!isCurrent) return;
        setSpecialDates(data.specialDates || null);
        setSpecialDateValues(
          Object.fromEntries(
            (data.specialDates?.rewards || []).map((reward) => [
              reward.slot,
              {
                month: String(reward.date?.month || ""),
                day: String(reward.date?.day || ""),
              },
            ]),
          ),
        );
      } catch (error) {
        console.error("Could not load special dates", error);
      }
    }

    loadSpecialDates();
    return () => {
      isCurrent = false;
    };
  }, [apiBaseUrls, apiBaseUrlsKey, customer?.id, isResolvingProxyBaseUrl]);

  const saveSpecialDate = async (slot, action = "save") => {
    setSavingSpecialDateSlot(slot);
    setMessage("");
    try {
      const token = await shopify.sessionToken.get();
      const value = specialDateValues[slot] || {};
      const data = await fetchApiJson(
        buildApiUrls(apiBaseUrls, "customer-account/special-dates"),
        {
          method: action === "delete" ? "DELETE" : "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(
            action === "delete"
              ? { action: "delete", slot }
              : {
                  slot,
                  date: {
                    month: Number(value.month),
                    day: Number(value.day),
                  },
                },
          ),
        },
        "Could not save special date.",
      );
      setSpecialDates(data.specialDates || null);
      setSpecialDateValues(
        Object.fromEntries(
          (data.specialDates?.rewards || []).map((reward) => [
            reward.slot,
            {
              month: String(reward.date?.month || ""),
              day: String(reward.date?.day || ""),
            },
          ]),
        ),
      );
      const reward = data.specialDates?.rewards?.find(
        (item) => item.slot === slot,
      );
      setMessage(
        action === "delete"
          ? `${reward?.heading || "Special date"} removed.`
          : `${reward?.heading || "Special date"} saved for annual rewards.`,
      );
    } catch (error) {
      setMessage(error.message || "Could not save special date.");
    } finally {
      setSavingSpecialDateSlot(null);
    }
  };

  const fetchHistory = useCallback(async () => {
    if (isResolvingProxyBaseUrl || !customer?.id) return;
    if (apiBaseUrls.length === 0) return;

    const requestId = ++historyRequestIdRef.current;
    setIsLoadingHistory(true);

    try {
      const params = new URLSearchParams({
        customerId: customer.id,
        shop: proxyShopDomain,
      });
      const data = await fetchApiJson(
        buildApiUrls(apiBaseUrls, "customer-reward-history", params),
        undefined,
        "Could not load reward history. Please try again.",
      );

      if (requestId !== historyRequestIdRef.current) return;

      if (data?.success) {
        setHistory(data.history || []);
        setStoreCreditAccounts(data.storeCreditAccounts || []);
        setStoreCreditHistory(data.storeCreditHistory || []);
        if (data.storeCreditBalance) {
          setStoreCreditBalance(data.storeCreditBalance);
        }
        setHistoryPage(1);
        setStoreCreditHistoryPage(1);
      } else {
        throw new Error(data?.message || "Could not load reward history");
      }
    } catch (error) {
      console.error("History error:", error);
      if (requestId === historyRequestIdRef.current) {
        setHistory([]);
        setMessage(error.message || "Could not load reward history");
      }
    } finally {
      if (requestId === historyRequestIdRef.current) {
        setIsLoadingHistory(false);
      }
    }
  }, [apiBaseUrls, customer?.id, isResolvingProxyBaseUrl, proxyShopDomain]);

  useEffect(() => {
    fetchHistory();

    return () => {
      historyRequestIdRef.current += 1;
    };
  }, [fetchHistory]);

  const filteredHistory = useMemo(() => {
    const query = historySearch.trim().toLowerCase();

    if (!query) {
      return history;
    }

    return history.filter((item) => getHistorySearchText(item).includes(query));
  }, [history, historySearch]);
  const historyPageCount = Math.max(
    1,
    Math.ceil(filteredHistory.length / HISTORY_PAGE_SIZE),
  );
  const paginatedHistory = filteredHistory.slice(
    (historyPage - 1) * HISTORY_PAGE_SIZE,
    historyPage * HISTORY_PAGE_SIZE,
  );
  const storeCreditHistoryPageCount = Math.max(
    1,
    Math.ceil(storeCreditHistory.length / HISTORY_PAGE_SIZE),
  );
  const paginatedStoreCreditHistory = storeCreditHistory.slice(
    (storeCreditHistoryPage - 1) * HISTORY_PAGE_SIZE,
    storeCreditHistoryPage * HISTORY_PAGE_SIZE,
  );

  const handleHistorySearch = (event) => {
    const inputSource = event.composedPath?.()[0];
    const nextValue =
      inputSource?.value ??
      event.detail?.value ??
      event.target?.value ??
      event.currentTarget?.value ??
      "";

    setHistorySearch(String(nextValue));
    setHistoryPage(1);
  };

  const redeemStoreCredit = async () => {
    const pointsToRedeem = Number(storeCreditPoints);

    if (!customerId || !storeCreditReward) {
      setMessage(errorMsg);
      return;
    }

    if (!isRedemptionEnabled) {
      setMessage(disabledMsg);
      return;
    }

    if (
      !Number.isInteger(pointsToRedeem) ||
      pointsToRedeem < storeCreditReward.points ||
      pointsToRedeem % storeCreditReward.points !== 0
    ) {
      setMessage(
        `Choose points in increments of ${storeCreditReward.points.toLocaleString()}.`,
      );
      return;
    }

    if (points < pointsToRedeem) {
      setMessage(
        formatSettingText(notEnoughPtsMsg, {
          remaining_points: pointsToRedeem - points,
        }),
      );
      return;
    }

    setIsRedeeming(true);
    setMessage("");

    try {
      const data = await fetchApiJson(
        buildApiUrls(apiBaseUrls, "redeem-points"),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            customerId,
            shop: proxyShopDomain,
            pointsToRedeem,
            rewardType: "store_credit",
          }),
        },
        errorMsg,
      );

      if (!data.success || !data.reward) {
        throw new Error(data.message || errorMsg);
      }

      setPoints((prev) => prev - pointsToRedeem);
      setStoreCreditBalance((previousBalance) => ({
        amount: Number.isFinite(Number(data.reward.balanceAfterTransaction))
          ? Number(data.reward.balanceAfterTransaction)
          : Number(previousBalance?.amount || 0) +
            Number(data.reward.amount || 0),
        currencyCode:
          data.reward.currencyCode ||
          previousBalance?.currencyCode ||
          currencyCode,
      }));
      setStoreCreditHistory((currentHistory) => [
        {
          id: data.reward.rewardCode,
          accountId: data.reward.storeCreditAccountId,
          type: "credit",
          amount: Number(data.reward.amount || 0),
          currencyCode: data.reward.currencyCode || currencyCode,
          balanceAfterTransaction: Number(
            data.reward.balanceAfterTransaction || 0,
          ),
          createdAt:
            data.reward.transactionCreatedAt || new Date().toISOString(),
        },
        ...currentHistory.filter((item) => item.id !== data.reward.rewardCode),
      ]);
      setStoreCreditHistoryPage(1);
      setStoreCreditPoints(String(storeCreditReward.points));
      setMessage(
        formatSettingText(storeCreditSuccessMsg, {
          amount: formatCurrency(data.reward.amount, currencyCode),
        }),
      );
      confirmationModalRef.current?.hideOverlay();
      // Refresh the host account page so Shopify's store-credit balance updates.
      // eslint-disable-next-line no-undef
      if (
        typeof shopify !== "undefined" &&
        typeof shopify.reload === "function"
      ) {
        // eslint-disable-next-line no-undef
        shopify.reload();
      }
    } catch (error) {
      console.error(error);
      setMessage(error.message || errorMsg);
    } finally {
      setIsRedeeming(false);
    }
  };

  const selectedStoreCreditPoints = Number(storeCreditPoints);
  const storeCreditPointStep = storeCreditReward?.points ?? 100;
  const maxStoreCreditPoints = storeCreditReward
    ? Math.max(
        storeCreditPointStep,
        Math.floor(points / storeCreditPointStep) * storeCreditPointStep,
      )
    : 0;
  const isValidStoreCreditAmount =
    Boolean(storeCreditReward) &&
    Number.isInteger(selectedStoreCreditPoints) &&
    selectedStoreCreditPoints >= storeCreditPointStep &&
    selectedStoreCreditPoints % storeCreditPointStep === 0 &&
    selectedStoreCreditPoints <= points;
  const selectedStoreCreditAmount =
    storeCreditReward && Number.isFinite(selectedStoreCreditPoints)
      ? formatCurrency(
          storeCreditReward.amount *
            (selectedStoreCreditPoints / storeCreditReward.points),
          currencyCode,
        )
      : formatCurrency(0, currencyCode);
  const formattedConversionRate = storeCreditReward
    ? formatSettingText(conversionRateText, {
        points: storeCreditReward.points.toLocaleString(),
        amount: formatCurrency(storeCreditReward.amount, currencyCode),
      })
    : "";
  const handleStoreCreditPointsInput = (event) => {
    const inputSource = event.composedPath?.()[0];
    const nextValue =
      inputSource?.value ??
      event.detail?.value ??
      event.target?.value ??
      event.currentTarget?.value ??
      "";

    setStoreCreditPoints(String(nextValue));
  };

  if (accountRenderMode === "iframe_link") {
    return (
      <s-box border="base" padding="large" borderRadius="base">
        <s-stack gap="base">
          <s-stack gap="none">
            <s-text>LOYALTY</s-text>
            <s-heading>Rewards wallet</s-heading>
          </s-stack>

          {message ? (
            <s-banner>
              <s-text>{message}</s-text>
            </s-banner>
          ) : null}

          <s-box border="base" padding="large" borderRadius="base">
            <s-stack gap="base">
              <s-heading>{balanceTitle}</s-heading>
              <s-text>{iframeDescription}</s-text>
              <s-stack gap="small">
                <s-text>{availableLabel}</s-text>
                <s-heading>{isLoading ? loadingText : pointsLabel}</s-heading>
              </s-stack>

              {customerAccountIframeUrl ? (
                <s-link href={customerAccountIframeUrl} target="_blank">
                  {iframeButtonText}
                </s-link>
              ) : (
                <s-text>{configErrorMsg}</s-text>
              )}
            </s-stack>
          </s-box>
        </s-stack>
      </s-box>
    );
  }

  return (
    <s-box border="base" padding="large" borderRadius="large">
      <s-stack gap="large">
        <s-stack direction="inline" gap="small">
          <s-button
            variant={activeTab === "balance" ? "primary" : "secondary"}
            onClick={() => setActiveTab("balance")}
          >
            Store credit
          </s-button>
          <s-button
            variant={activeTab === "referrals" ? "primary" : "secondary"}
            onClick={() => setActiveTab("referrals")}
          >
            Refer a friend
          </s-button>
          <s-button
            variant={activeTab === "birthday" ? "primary" : "secondary"}
            onClick={() => setActiveTab("birthday")}
          >
            Birthday reward
          </s-button>
          <s-button
            variant={activeTab === "special-dates" ? "primary" : "secondary"}
            onClick={() => setActiveTab("special-dates")}
          >
            Special dates
          </s-button>
          <s-button
            variant={
              activeTab === "store-credit-history" || activeTab === "history"
                ? "primary"
                : "secondary"
            }
            commandFor="loyalty-history-menu"
          >
            History
          </s-button>
          <s-menu
            id="loyalty-history-menu"
            accessibilityLabel="History options"
          >
            <s-button onClick={() => setActiveTab("store-credit-history")}>
              Credit history
            </s-button>
            <s-button onClick={() => setActiveTab("history")}>
              Reward history
            </s-button>
          </s-menu>
        </s-stack>

        {message ? (
          <s-banner>
            <s-text>{message}</s-text>
          </s-banner>
        ) : null}

        {activeTab === "balance" ? (
          <s-stack gap="large">
            <s-grid
              gridTemplateColumns="1fr auto"
              gap="base"
              alignItems="center"
            >
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-icon type="star" tone="success" />
                <s-stack gap="none">
                  <s-heading>{balanceTitle}</s-heading>
                  <s-text color="subdued">{availableLabel}</s-text>
                </s-stack>
              </s-stack>
              <s-badge icon="cash-dollar" color="subdued">
                Store credit
              </s-badge>
            </s-grid>

            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-box background="subdued" padding="large" borderRadius="large">
                <s-stack gap="small">
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-icon type="star-filled" tone="success" />
                    <s-text color="subdued">{currentBalanceLabel}</s-text>
                  </s-stack>
                  <s-heading>{isLoading ? loadingText : pointsLabel}</s-heading>
                </s-stack>
              </s-box>
              <s-box background="subdued" padding="large" borderRadius="large">
                <s-stack gap="small">
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-icon type="cash-dollar" tone="success" />
                    <s-text color="subdued">Available store credit</s-text>
                  </s-stack>
                  <s-heading>
                    {isLoading
                      ? loadingText
                      : formatCurrency(
                          storeCreditBalance?.amount,
                          storeCreditBalance?.currencyCode || currencyCode,
                        )}
                  </s-heading>
                </s-stack>
              </s-box>
            </s-grid>

            {storeCreditReward ? (
              <s-section heading={storeCreditTitle}>
                <s-stack gap="large">
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-icon type="savings" tone="success" />
                    <s-text color="subdued">{formattedConversionRate}</s-text>
                  </s-stack>

                  <s-number-field
                    label="Points to convert"
                    details={`Choose a multiple of ${storeCreditPointStep.toLocaleString()} points.`}
                    value={storeCreditPoints}
                    min={storeCreditPointStep}
                    max={maxStoreCreditPoints}
                    step={storeCreditPointStep}
                    controls="stepper"
                    disabled={
                      isLoading ||
                      isRedeeming ||
                      !isRedemptionEnabled ||
                      points < storeCreditReward.points
                    }
                    onInput={handleStoreCreditPointsInput}
                    onChange={handleStoreCreditPointsInput}
                  />

                  <s-box
                    background="subdued"
                    padding="base"
                    borderRadius="base"
                  >
                    <s-grid
                      gridTemplateColumns="1fr auto"
                      gap="base"
                      alignItems="center"
                    >
                      <s-stack gap="none">
                        <s-text color="subdued">You will receive</s-text>
                        <s-text type="small">Shopify store credit</s-text>
                      </s-stack>
                      <s-heading>{selectedStoreCreditAmount}</s-heading>
                    </s-grid>
                  </s-box>

                  <s-button
                    variant="primary"
                    loading={isRedeeming}
                    command="--show"
                    commandFor="store-credit-confirmation"
                    disabled={
                      isLoading ||
                      isRedeeming ||
                      !isRedemptionEnabled ||
                      !customerId ||
                      !isValidStoreCreditAmount
                    }
                  >
                    {isRedeeming ? redeemingText : convertButtonText}
                  </s-button>
                  <s-modal
                    ref={confirmationModalRef}
                    id="store-credit-confirmation"
                    heading="Confirm store credit conversion"
                    size="small"
                  >
                    <s-stack gap="base">
                      <s-text>
                        Convert {selectedStoreCreditPoints.toLocaleString()}{" "}
                        points into ${selectedStoreCreditAmount} store credit?
                      </s-text>
                      <s-text>
                        Your loyalty balance will be reduced after confirmation.
                      </s-text>
                    </s-stack>
                    <s-button
                      slot="secondary-actions"
                      variant="secondary"
                      command="--hide"
                      commandFor="store-credit-confirmation"
                      disabled={isRedeeming}
                    >
                      Cancel
                    </s-button>
                    <s-button
                      slot="primary-action"
                      variant="primary"
                      disabled={isRedeeming}
                      onClick={redeemStoreCredit}
                    >
                      {isRedeeming ? redeemingText : "Confirm"}
                    </s-button>
                  </s-modal>
                  {!isRedemptionEnabled ? (
                    <s-banner tone="warning">
                      <s-text>{disabledMsg}</s-text>
                    </s-banner>
                  ) : null}
                </s-stack>
              </s-section>
            ) : null}
          </s-stack>
        ) : activeTab === "store-credit-history" ? (
          <s-stack gap="large">
            <s-grid
              gridTemplateColumns="1fr auto"
              gap="base"
              alignItems="center"
            >
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-icon type="cash-dollar" tone="success" />
                <s-stack gap="none">
                  <s-heading>Store credit history</s-heading>
                  <s-text color="subdued">
                    Credits, checkout usage, returns, and expirations
                  </s-text>
                </s-stack>
              </s-stack>
              <s-button
                variant="secondary"
                loading={isLoadingHistory}
                disabled={isLoadingHistory}
                onClick={fetchHistory}
              >
                Refresh
              </s-button>
            </s-grid>

            {storeCreditAccounts.length > 0 ? (
              <s-grid
                gridTemplateColumns={`repeat(${Math.min(storeCreditAccounts.length, 3)}, 1fr)`}
                gap="base"
              >
                {storeCreditAccounts.map((account) => (
                  <s-box
                    key={account.id}
                    background="subdued"
                    padding="base"
                    borderRadius="large"
                  >
                    <s-stack gap="none">
                      <s-text color="subdued" type="small">
                        {account.currencyCode} balance
                      </s-text>
                      <s-heading>
                        {formatCurrency(account.amount, account.currencyCode)}
                      </s-heading>
                    </s-stack>
                  </s-box>
                ))}
              </s-grid>
            ) : null}

            {isLoadingHistory ? (
              <s-box background="subdued" padding="large" borderRadius="large">
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-spinner size="small" />
                  <s-text>{loadingText}</s-text>
                </s-stack>
              </s-box>
            ) : storeCreditHistory.length === 0 ? (
              <s-box background="subdued" padding="large" borderRadius="large">
                <s-stack gap="base" alignItems="center">
                  <s-icon type="clock" size="large" tone="neutral" />
                  <s-heading>No store credit history yet</s-heading>
                  <s-text color="subdued">
                    Store credit changes will appear after credit is added or
                    used.
                  </s-text>
                </s-stack>
              </s-box>
            ) : (
              <s-stack gap="base">
                {paginatedStoreCreditHistory.map((item) => (
                  <s-box
                    key={`${item.accountId}-${item.id}-${item.createdAt}`}
                    border="base"
                    borderRadius="large"
                    padding="base"
                  >
                    <s-grid
                      gridTemplateColumns="1fr auto"
                      gap="base"
                      alignItems="center"
                    >
                      <s-stack
                        direction="inline"
                        gap="small"
                        alignItems="center"
                      >
                        <s-icon
                          type="cash-dollar"
                          tone={getStoreCreditTransactionTone(item.type)}
                        />
                        <s-stack gap="none">
                          <s-text type="strong">
                            {getStoreCreditTransactionLabel(item.type)}
                          </s-text>
                          <s-text color="subdued" type="small">
                            {item.createdAt
                              ? new Date(item.createdAt).toLocaleString()
                              : "-"}
                          </s-text>
                          {item.type === "debit" && item.orderName ? (
                            <s-text color="subdued" type="small">
                              Order {formatOrderReference(item.orderName)}
                            </s-text>
                          ) : null}
                        </s-stack>
                      </s-stack>
                      <s-stack gap="none" alignItems="end">
                        <s-heading>
                          {item.amount > 0 ? "+" : ""}
                          {formatCurrency(item.amount, item.currencyCode)}
                        </s-heading>
                        <s-text color="subdued" type="small">
                          Balance{" "}
                          {formatCurrency(
                            item.balanceAfterTransaction,
                            item.currencyCode,
                          )}
                        </s-text>
                      </s-stack>
                    </s-grid>
                  </s-box>
                ))}

                {storeCreditHistoryPageCount > 1 ? (
                  <s-grid
                    gridTemplateColumns="1fr auto"
                    gap="base"
                    alignItems="center"
                  >
                    <s-text color="subdued">
                      Page {storeCreditHistoryPage} of{" "}
                      {storeCreditHistoryPageCount}
                    </s-text>
                    <s-button-group>
                      <s-button
                        slot="secondary-actions"
                        variant="secondary"
                        disabled={storeCreditHistoryPage === 1}
                        onClick={() =>
                          setStoreCreditHistoryPage((page) => page - 1)
                        }
                      >
                        Previous
                      </s-button>
                      <s-button
                        slot="primary-action"
                        variant="primary"
                        disabled={
                          storeCreditHistoryPage === storeCreditHistoryPageCount
                        }
                        onClick={() =>
                          setStoreCreditHistoryPage((page) => page + 1)
                        }
                      >
                        Next
                      </s-button>
                    </s-button-group>
                  </s-grid>
                ) : null}
              </s-stack>
            )}
          </s-stack>
        ) : activeTab === "birthday" ? (
          <s-stack gap="large">
            <s-stack gap="none">
              <s-heading>Birthday reward</s-heading>
              <s-text color="subdued">
                Add your birth month and day to receive an annual points gift.
              </s-text>
            </s-stack>
            {birthday?.enabled ? (
              <s-box background="subdued" padding="large" borderRadius="large">
                <s-stack gap="base">
                  <s-text>
                    Earn {birthday.points} points once a year. Enter your
                    birthday at least {birthday.minimumLeadDays} days in advance
                    to qualify.
                  </s-text>
                  <s-text color="subdued">{birthday.privacy}</s-text>
                  {birthday.birthday ? (
                    <s-stack gap="base">
                      <s-text type="strong">
                        Saved birthday: {birthday.birthday.label}
                        {birthday.lastIssuedYear
                          ? ` · Last rewarded ${birthday.lastIssuedYear}`
                          : ""}
                      </s-text>
                      <s-text color="subdued">
                        {birthday.correctionMessage}
                      </s-text>
                      <s-button
                        variant="secondary"
                        tone="critical"
                        disabled={isSavingBirthday}
                        onClick={() => saveBirthday("delete")}
                      >
                        Remove birthday
                      </s-button>
                    </s-stack>
                  ) : birthday.canSetBirthday ? (
                    <s-stack gap="base">
                      <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                        <s-select
                          label="Birth month"
                          value={birthdayMonth}
                          onChange={(event) =>
                            setBirthdayMonth(getFormControlValue(event))
                          }
                        >
                          <s-option value="">Select month</s-option>
                          {[
                            "January",
                            "February",
                            "March",
                            "April",
                            "May",
                            "June",
                            "July",
                            "August",
                            "September",
                            "October",
                            "November",
                            "December",
                          ].map((month, index) => (
                            <s-option key={month} value={String(index + 1)}>
                              {month}
                            </s-option>
                          ))}
                        </s-select>
                        <s-select
                          label="Birth day"
                          value={birthdayDay}
                          onChange={(event) =>
                            setBirthdayDay(getFormControlValue(event))
                          }
                        >
                          <s-option value="">Select day</s-option>
                          {Array.from(
                            { length: 31 },
                            (_, index) => index + 1,
                          ).map((day) => (
                            <s-option key={day} value={String(day)}>
                              {day}
                            </s-option>
                          ))}
                        </s-select>
                      </s-grid>
                      <s-button
                        variant="primary"
                        loading={isSavingBirthday}
                        disabled={
                          isSavingBirthday || !birthdayMonth || !birthdayDay
                        }
                        onClick={() => saveBirthday("save")}
                      >
                        Save birthday once
                      </s-button>
                    </s-stack>
                  ) : (
                    <s-stack gap="small">
                      <s-text>Your saved birthday has been removed.</s-text>
                      <s-text color="subdued">
                        {birthday.correctionMessage}
                      </s-text>
                    </s-stack>
                  )}
                </s-stack>
              </s-box>
            ) : (
              <s-banner tone="info">
                <s-text>Birthday rewards are currently unavailable.</s-text>
              </s-banner>
            )}
          </s-stack>
        ) : activeTab === "special-dates" ? (
          <s-stack gap="large">
            <s-stack gap="none">
              <s-heading>Special date rewards</s-heading>
              <s-text color="subdued">
                Save personal dates such as your anniversary and receive an
                annual points gift.
              </s-text>
            </s-stack>
            {(specialDates?.rewards || []).filter((reward) => reward.enabled)
              .length ? (
              <s-stack gap="base">
                <s-text color="subdued">{specialDates.privacy}</s-text>
                {(specialDates.rewards || [])
                  .filter((reward) => reward.enabled)
                  .map((reward) => {
                    const value = specialDateValues[reward.slot] || {};
                    const isSaving = savingSpecialDateSlot === reward.slot;
                    return (
                      <s-box
                        key={reward.slot}
                        background="subdued"
                        padding="large"
                        borderRadius="large"
                      >
                        <s-stack gap="base">
                          <s-stack gap="none">
                            <s-heading>{reward.heading}</s-heading>
                            <s-text>
                              Earn {reward.points} points once a year. Save the
                              date at least {specialDates.minimumLeadDays} days
                              in advance to qualify.
                            </s-text>
                          </s-stack>
                          {reward.date ? (
                            <s-text type="strong">
                              Saved date: {reward.date.label}
                              {reward.lastIssuedYear
                                ? ` · Last rewarded ${reward.lastIssuedYear}`
                                : ""}
                            </s-text>
                          ) : null}
                          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                            <s-select
                              label={`${reward.heading} month`}
                              value={value.month || ""}
                              onChange={(event) =>
                                setSpecialDateValues((current) => ({
                                  ...current,
                                  [reward.slot]: {
                                    ...current[reward.slot],
                                    month: getFormControlValue(event),
                                  },
                                }))
                              }
                            >
                              <s-option value="">Select month</s-option>
                              {[
                                "January",
                                "February",
                                "March",
                                "April",
                                "May",
                                "June",
                                "July",
                                "August",
                                "September",
                                "October",
                                "November",
                                "December",
                              ].map((month, index) => (
                                <s-option key={month} value={String(index + 1)}>
                                  {month}
                                </s-option>
                              ))}
                            </s-select>
                            <s-select
                              label={`${reward.heading} day`}
                              value={value.day || ""}
                              onChange={(event) =>
                                setSpecialDateValues((current) => ({
                                  ...current,
                                  [reward.slot]: {
                                    ...current[reward.slot],
                                    day: getFormControlValue(event),
                                  },
                                }))
                              }
                            >
                              <s-option value="">Select day</s-option>
                              {Array.from(
                                { length: 31 },
                                (_, index) => index + 1,
                              ).map((day) => (
                                <s-option key={day} value={String(day)}>
                                  {day}
                                </s-option>
                              ))}
                            </s-select>
                          </s-grid>
                          <s-stack direction="inline" gap="small">
                            <s-button
                              variant="primary"
                              loading={isSaving}
                              disabled={
                                Boolean(savingSpecialDateSlot) ||
                                !value.month ||
                                !value.day
                              }
                              onClick={() =>
                                saveSpecialDate(reward.slot, "save")
                              }
                            >
                              {reward.date ? "Update date" : "Save date"}
                            </s-button>
                            {reward.date ? (
                              <s-button
                                variant="secondary"
                                tone="critical"
                                disabled={Boolean(savingSpecialDateSlot)}
                                onClick={() =>
                                  saveSpecialDate(reward.slot, "delete")
                                }
                              >
                                Remove date
                              </s-button>
                            ) : null}
                          </s-stack>
                        </s-stack>
                      </s-box>
                    );
                  })}
              </s-stack>
            ) : (
              <s-banner tone="info">
                <s-text>Special date rewards are currently unavailable.</s-text>
              </s-banner>
            )}
          </s-stack>
        ) : activeTab === "referrals" ? (
          <s-stack gap="large">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-stack gap="none">
                <s-heading>Refer a friend</s-heading>
                <s-text color="subdued">
                  Share your personal link and earn points together.
                </s-text>
              </s-stack>
            </s-stack>

            {referral?.enabled ? (
              <s-box background="subdued" padding="large" borderRadius="large">
                <s-stack gap="base">
                  <s-text>
                    You earn {referral.advocatePoints} points and your friend
                    earns {referral.friendPoints} points after their first paid
                    order.
                  </s-text>
                  <s-stack gap="small">
                    <s-text>Your referral link</s-text>
                    <s-stack direction="inline" gap="small" alignItems="center">
                      <s-link href={referral.link}>{referral.link}</s-link>
                      <s-button
                        variant="secondary"
                        commandFor="loyalty-referral-link"
                      >
                        Copy link
                      </s-button>
                    </s-stack>
                  </s-stack>
                  <s-clipboard-item
                    id="loyalty-referral-link"
                    text={referral.link}
                  />
                  <s-text color="subdued">
                    {referral.successfulReferrals} successful referral
                    {referral.successfulReferrals === 1 ? "" : "s"}
                  </s-text>
                </s-stack>
              </s-box>
            ) : (
              <s-banner tone="info">
                <s-text>The referral program is currently unavailable.</s-text>
              </s-banner>
            )}
          </s-stack>
        ) : (
          <s-stack gap="large">
            <s-grid
              gridTemplateColumns="1fr auto"
              gap="base"
              alignItems="center"
            >
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-icon type="clock" tone="neutral" />
                <s-stack gap="none">
                  <s-heading>Reward history</s-heading>
                  <s-text color="subdued">
                    {historySearch
                      ? `${filteredHistory.length} of ${history.length} activities`
                      : `${history.length} activit${history.length === 1 ? "y" : "ies"}`}
                  </s-text>
                </s-stack>
              </s-stack>
              <s-button
                variant="secondary"
                loading={isLoadingHistory}
                disabled={isLoadingHistory}
                onClick={fetchHistory}
              >
                Refresh
              </s-button>
            </s-grid>

            <s-text-field
              label="Search reward history"
              labelAccessibilityVisibility="exclusive"
              icon="search"
              placeholder="Search code, status, order or message"
              value={historySearch}
              onInput={handleHistorySearch}
              onChange={handleHistorySearch}
            />

            {isLoadingHistory ? (
              <s-box background="subdued" padding="large" borderRadius="large">
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-spinner size="small" />
                  <s-text>{loadingText}</s-text>
                </s-stack>
              </s-box>
            ) : filteredHistory.length === 0 ? (
              <s-box background="subdued" padding="large" borderRadius="large">
                <s-stack gap="base" alignItems="center">
                  <s-icon
                    type={historySearch ? "search" : "clock"}
                    size="large"
                    tone="neutral"
                  />
                  <s-heading>
                    {historySearch
                      ? "No matching activity"
                      : "No reward history yet"}
                  </s-heading>
                  <s-text color="subdued">
                    {historySearch
                      ? `No reward activity matches “${historySearch}”.`
                      : "Reward activity will appear here after your first redemption."}
                  </s-text>
                  {historySearch ? (
                    <s-button
                      variant="secondary"
                      onClick={() => {
                        setHistorySearch("");
                        setHistoryPage(1);
                      }}
                    >
                      Clear search
                    </s-button>
                  ) : (
                    <s-button variant="secondary" onClick={fetchHistory}>
                      Check again
                    </s-button>
                  )}
                </s-stack>
              </s-box>
            ) : (
              <s-stack gap="base">
                {paginatedHistory.map((item) => {
                  const activityAppearance = ACTIVITY_APPEARANCE[
                    item.activityType
                  ] || {
                    icon: "info",
                    tone: "neutral",
                  };
                  const rewardTypeBadge = getRewardTypeBadge(item.activityType);
                  const rewardCode = item.activityType?.startsWith(
                    "store_credit",
                  )
                    ? "Store credit"
                    : item.activityType === "points_expired"
                      ? "Points expiry"
                      : item.rewardCode || "Reward activity";
                  const hasOrder = Boolean(item.orderName);

                  return (
                    <s-box
                      key={item.id}
                      border="base"
                      borderRadius="large"
                      padding="base"
                    >
                      <s-stack gap="base">
                        <s-grid
                          gridTemplateColumns="1fr auto"
                          gap="base"
                          alignItems="center"
                        >
                          <s-stack
                            direction="inline"
                            gap="small"
                            alignItems="center"
                          >
                            <s-icon
                              type={activityAppearance.icon}
                              tone={activityAppearance.tone}
                            />
                            <s-stack gap="none">
                              <s-text type="strong">{rewardCode}</s-text>
                              <s-text color="subdued" type="small">
                                {item.createdAt
                                  ? new Date(item.createdAt).toLocaleString()
                                  : "-"}
                              </s-text>
                            </s-stack>
                          </s-stack>
                          <s-stack direction="inline" gap="small">
                            <s-badge
                              tone={
                                activityAppearance.tone === "critical"
                                  ? "critical"
                                  : "neutral"
                              }
                            >
                              {getActivityStatusLabel(item.label)}
                            </s-badge>
                            <s-badge
                              icon={rewardTypeBadge.icon}
                              color="subdued"
                            >
                              {rewardTypeBadge.label}
                            </s-badge>
                          </s-stack>
                        </s-grid>

                        <s-grid
                          gridTemplateColumns={
                            hasOrder ? "1fr 1fr 1fr" : "1fr 1fr"
                          }
                          gap="small"
                        >
                          <s-box
                            background="subdued"
                            padding="small"
                            borderRadius="base"
                          >
                            <s-stack gap="none">
                              <s-text color="subdued" type="small">
                                Points
                              </s-text>
                              <s-text type="strong">
                                {item.pointsUsed ?? "-"}
                              </s-text>
                            </s-stack>
                          </s-box>
                          <s-box
                            background="subdued"
                            padding="small"
                            borderRadius="base"
                          >
                            <s-stack gap="none">
                              <s-text color="subdued" type="small">
                                Amount
                              </s-text>
                              <s-text type="strong">
                                {item.discountAmount
                                  ? formatCurrency(
                                      item.discountAmount,
                                      currencyCode,
                                    )
                                  : "-"}
                              </s-text>
                            </s-stack>
                          </s-box>
                          {hasOrder ? (
                            <s-box
                              background="subdued"
                              padding="small"
                              borderRadius="base"
                            >
                              <s-stack gap="none">
                                <s-text color="subdued" type="small">
                                  Order
                                </s-text>
                                <s-text type="strong">
                                  {formatOrderReference(item.orderName)}
                                </s-text>
                              </s-stack>
                            </s-box>
                          ) : null}
                        </s-grid>

                        <s-text color="subdued">
                          {item.message || "Reward activity updated."}
                        </s-text>
                      </s-stack>
                    </s-box>
                  );
                })}

                {historyPageCount > 1 ? (
                  <s-grid
                    gridTemplateColumns="1fr auto"
                    gap="base"
                    alignItems="center"
                  >
                    <s-text color="subdued">
                      Page {historyPage} of {historyPageCount}
                    </s-text>
                    <s-button-group>
                      <s-button
                        slot="secondary-actions"
                        variant="secondary"
                        disabled={historyPage === 1}
                        onClick={() => setHistoryPage((page) => page - 1)}
                      >
                        Previous
                      </s-button>
                      <s-button
                        slot="primary-action"
                        variant="primary"
                        disabled={historyPage === historyPageCount}
                        onClick={() => setHistoryPage((page) => page + 1)}
                      >
                        Next
                      </s-button>
                    </s-button-group>
                  </s-grid>
                ) : null}
              </s-stack>
            )}
          </s-stack>
        )}
      </s-stack>
    </s-box>
  );
}
