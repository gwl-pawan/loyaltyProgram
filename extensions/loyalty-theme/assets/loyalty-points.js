"use strict";

(() => {
  if (document.__loyaltyPointsNativeScriptLoaded) {
    window.__loyaltyPointsController?.scheduleInitializeWidgets();
    return;
  }

  document.__loyaltyPointsNativeScriptLoaded = true;
  window.__loyaltyPointsNativeScriptLoaded = true;

  if (window.__loyaltyPointsFallbackClickHandler) {
    document.removeEventListener(
      "click",
      window.__loyaltyPointsFallbackClickHandler,
      true,
    );
    delete window.__loyaltyPointsFallbackClickHandler;
    window.__loyaltyPointsFallbackBound = false;
  }

  function formatCurrency(value, currencyCode) {
    const amount = Number(value || 0);

    try {
      return new Intl.NumberFormat("en", {
        style: "currency",
        currency: currencyCode || "USD",
        currencyDisplay: "narrowSymbol",
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      }).format(amount);
    } catch {
      return `${currencyCode || "USD"} ${amount.toLocaleString("en")}`;
    }
  }

  function formatRewardTitle(reward, currencyCode) {
    if (reward.type === "gift_card") {
      return `${formatCurrency(reward.amount, currencyCode)} Gift Card`;
    }

    if (reward.type === "store_credit") {
      return `${formatCurrency(reward.amount, currencyCode)} Store Credit`;
    }

    return `Discount ${formatCurrency(reward.discount, currencyCode)} for ${reward.points} points`;
  }

  function formatRewardDescription(reward, currencyCode) {
    if (reward.description && reward.type === "discount")
      return reward.description;

    if (reward.type === "gift_card") {
      return `Redeem ${reward.points} points for a ${formatCurrency(reward.amount, currencyCode)} gift card.`;
    }

    if (reward.type === "store_credit") {
      return `Redeem ${reward.points} points for ${formatCurrency(reward.amount, currencyCode)} store credit.`;
    }

    return `Redeem ${reward.points} points for a discount.`;
  }

  function appendText(parent, tagName, className, text) {
    const element = document.createElement(tagName);
    element.className = className;
    element.textContent = text;
    parent.appendChild(element);
    return element;
  }

  function setRewardMessage(container, message, isError) {
    let messageElement = container.querySelector(
      "[data-loyalty-reward-message]",
    );

    if (!messageElement) {
      messageElement = document.createElement("p");
      messageElement.className = "loyalty-points-widget__reward-message";
      messageElement.dataset.loyaltyRewardMessage = "";
      container.prepend(messageElement);
    }

    messageElement.textContent = message;
    messageElement.classList.toggle(
      "loyalty-points-widget__reward-message--error",
      Boolean(isError),
    );
  }

  async function readJsonResponse(response, fallbackMessage) {
    const text = await response.text();
    let data;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(fallbackMessage);
    }

    if (!response.ok || !data || typeof data !== "object") {
      throw new Error(data?.message || fallbackMessage);
    }

    return data;
  }

  async function captureReferral(widget) {
    const dataset = widget.dataset;
    const storageKey = `loyalty-referral:${dataset.shopDomain}`;
    const code = new URL(window.location.href).searchParams.get("ref");
    let visit;

    try {
      visit = JSON.parse(window.localStorage.getItem(storageKey) || "null");
    } catch {
      visit = null;
    }

    if (code && !visit) {
      visit = {
        code,
        visitorToken: window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      };
      window.localStorage.setItem(storageKey, JSON.stringify(visit));
    }

    if (!visit?.visitorToken) return;
    const endpoint = `${(dataset.apiBaseUrl || "/apps/loyalty-points").replace(/\/$/, "")}/api/referrals`;

    try {
      if (code) {
        await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "track", shop: dataset.shopDomain, code: visit.code, visitorToken: visit.visitorToken, landingUrl: window.location.href }),
        });
      }

      if (dataset.customerId) {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "claim", shop: dataset.shopDomain, customerId: dataset.customerId, visitorToken: visit.visitorToken }),
        });
        const result = await readJsonResponse(response, "Could not claim referral");
        if (result.claimed) window.localStorage.removeItem(storageKey);
      }
    } catch (error) {
      console.warn("[loyalty-points] Could not capture referral", error);
    }
  }

  async function loadReferralProfile(widget) {
    const dataset = widget.dataset;
    const container = widget.querySelector("[data-loyalty-referral-profile]");
    if (!container || !dataset.customerId || container.dataset.loaded === "true") return;

    try {
      const params = new URLSearchParams({ shop: dataset.shopDomain, customerId: dataset.customerId });
      const endpoint = `${(dataset.apiBaseUrl || "/apps/loyalty-points").replace(/\/$/, "")}/api/referrals?${params}`;
      const response = await fetch(endpoint);
      const data = await readJsonResponse(response, "Could not load referral link");
      if (!data.referral?.enabled) return;

      const link = container.querySelector("[data-loyalty-referral-link]");
      const copy = container.querySelector("[data-loyalty-referral-copy]");
      const stats = container.querySelector("[data-loyalty-referral-stats]");
      link.value = data.referral.link;
      copy.textContent = `Share your link. You earn ${data.referral.advocatePoints} points and your friend earns ${data.referral.friendPoints} points after their first order.`;
      stats.textContent = `${data.referral.successfulReferrals} successful referrals`;
      container.hidden = false;
      container.dataset.loaded = "true";
    } catch (error) {
      console.warn("[loyalty-points] Could not load referral profile", error);
    }
  }

  function applyCustomCss(css) {
    const customCss = String(css || "").trim();
    let style = document.getElementById("loyalty-points-widget-custom-css");

    if (!customCss) {
      style?.remove();
      scheduleInitializeWidgets();
      return;
    }

    if (!style) {
      style = document.createElement("style");
      style.id = "loyalty-points-widget-custom-css";
      document.head.appendChild(style);
    }

    style.textContent = customCss.replace(/<\/style/gi, "<\\/style");
    scheduleInitializeWidgets();
  }

  function setImportantStyles(element, styles) {
    Object.entries(styles).forEach(([property, value]) => {
      element.style.setProperty(property, value, "important");
    });
  }

  async function loadCustomCss(widget) {
    const dataset = widget.dataset;

    if (!dataset.shopDomain) return;

    const params = new URLSearchParams({
      shop: dataset.shopDomain || "",
      customerId: dataset.customerId || "",
      customerEmail: "",
      surface: "theme",
      customCssOnly: "true",
    });

    try {
      const response = await fetch(
        `${(dataset.apiBaseUrl || "/apps/loyalty-points").replace(/\/$/, "")}/iframe?${params}`,
        {
          headers: {
            Accept: "text/css",
          },
        },
      );

      if (!response.ok) return;

      applyCustomCss(await response.text());
    } catch (error) {
      console.warn("[loyalty-points] Could not load custom CSS", error);
    }
  }

  async function redeemReward(widget, container, reward, button) {
    const dataset = widget.dataset;

    if (!dataset.apiBaseUrl || !dataset.customerId) {
      setRewardMessage(container, dataset.errorMessage, true);
      return;
    }

    const cta = button.querySelector(".loyalty-points-widget__reward-cta");
    const originalText = cta.textContent;

    button.disabled = true;
    button.classList.add("loyalty-points-widget__reward--loading");
    cta.textContent = "Redeeming...";
    setRewardMessage(container, "Creating your reward...", false);

    try {
      const ruleContext = await getCartRuleContext();

      if (!ruleContext || ruleContext.cartLines.length < 1) {
        throw new Error("Please add product to cart");
      }

      const response = await fetch(
        `${dataset.apiBaseUrl.replace(/\/$/, "")}/api/redeem-points`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            customerId: dataset.loyaltyCustomerId || dataset.customerId,
            shop: dataset.shopDomain || "",
            pointsToRedeem: Number(reward.points),
            rewardType: reward.type || "discount",
            allowPendingRewardCheckout: true,
            ...ruleContext,
          }),
        },
      );
      const data = await readJsonResponse(response, dataset.errorMessage);

      if (!data.success || !data.reward) {
        throw new Error(data.message || dataset.errorMessage);
      }

      setRewardMessage(
        container,
        data.reward.rewardType === "discount"
          ? "Discount code created. It will be applied when you open checkout."
          : data.reward.rewardType === "store_credit"
            ? "Store credit created. Open checkout to use it."
            : "Reward created. Open checkout to use it.",
        false,
      );
      button.classList.remove("loyalty-points-widget__reward--loading");
      cta.textContent = "Created";
    } catch (error) {
      console.error("[loyalty-points] Could not redeem reward", error);
      setRewardMessage(container, error.message || dataset.errorMessage, true);
      button.disabled = false;
      button.classList.remove("loyalty-points-widget__reward--loading");
      cta.textContent = originalText;
    }
  }

  function normalizePendingReward(pendingReward) {
    if (!pendingReward) return null;

    return {
      rewardCode: pendingReward.rewardCode,
      rewardType: (pendingReward.rewardType || pendingReward.type || "discount")
        .toString()
        .toLowerCase(),
      pointsUsed: Number(
        pendingReward.pointsUsed ?? pendingReward.points ?? pendingReward.pointsToRedeem ?? 0,
      ),
      discountAmount:
        pendingReward.discountAmount ?? pendingReward.amount ?? null,
    };
  }

  function isPendingReward(reward, pendingReward) {
    const normalizedPending = normalizePendingReward(pendingReward);
    if (!normalizedPending?.rewardCode) return false;

    const rewardType = (reward.type || "discount").toString().toLowerCase();
    const rewardPoints = Number(reward.points);
    const rewardAmount = Number(reward.discount ?? reward.amount ?? 0);

    if (rewardType !== normalizedPending.rewardType) return false;
    if (Number.isNaN(rewardPoints) || rewardPoints !== normalizedPending.pointsUsed)
      return false;

    if (rewardType === "discount") {
      return (
        normalizedPending.discountAmount == null ||
        Number(normalizedPending.discountAmount) === rewardAmount
      );
    }

    return true;
  }

  async function cancelPendingReward(widget, container, pendingReward, button) {
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "Removing...";

    try {
      const response = await fetch(
        `${widget.dataset.apiBaseUrl.replace(/\/$/, "")}/api/redeem-points`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operation: "releasePendingReward",
            customerId:
              widget.dataset.loyaltyCustomerId || widget.dataset.customerId,
            shop: widget.dataset.shopDomain || "",
            rewardCode: pendingReward.rewardCode,
          }),
        },
      );
      const data = await readJsonResponse(
        response,
        widget.dataset.errorMessage,
      );

      if (!data.success) {
        throw new Error(data.message || widget.dataset.errorMessage);
      }

      widget.dataset.hasPendingCheckoutRedemption = "false";
      setRewardMessage(
        container,
        "Reward removed. You can redeem another reward.",
        false,
      );
      await loadWidgetData(widget);
    } catch (error) {
      console.error("[loyalty-points] Could not remove reward", error);
      button.disabled = false;
      button.textContent = originalText;
      setRewardMessage(
        container,
        error.message || widget.dataset.errorMessage,
        true,
      );
    }
  }

  function createRewardItem(
    widget,
    container,
    reward,
    isAvailable,
    pendingReward,
  ) {
    const item = document.createElement("li");
    item.className = "loyalty-points-widget__reward";

    const button = document.createElement("button");
    button.className = "loyalty-points-widget__reward-button";
    button.type = "button";
    const hasPendingReward = Boolean(pendingReward?.rewardCode);
    const isApplied = isPendingReward(reward, pendingReward);
    item.classList.toggle("loyalty-points-widget__reward--applied", isApplied);
    const canRedeem = isAvailable && !hasPendingReward;
    button.disabled = !canRedeem;
    button.setAttribute(
      "aria-label",
      `Redeem ${formatRewardTitle(reward, widget.dataset.currencyCode)}`,
    );

    appendText(
      button,
      "p",
      "loyalty-points-widget__reward-title",
      formatRewardTitle(reward, widget.dataset.currencyCode),
    );
    appendText(
      button,
      "p",
      "loyalty-points-widget__reward-description",
      formatRewardDescription(reward, widget.dataset.currencyCode),
    );
    const cta = appendText(
      button,
      "span",
      "loyalty-points-widget__reward-cta",
      isApplied
        ? "Applied"
        : isAvailable
          ? "Redeem"
          : `${reward.points} points required`,
    );

    if (canRedeem) {
      button.addEventListener("click", () =>
        redeemReward(widget, container, reward, button),
      );
    }

    item.appendChild(button);
    if (isApplied) {
      const rewardActions = document.createElement("div");
      rewardActions.className = "loyalty-points-widget__reward-actions";
      const removeButton = document.createElement("button");
      removeButton.className = "loyalty-points-widget__reward-remove";
      removeButton.type = "button";
      removeButton.textContent = "Remove reward";
      removeButton.addEventListener("click", () =>
        cancelPendingReward(widget, container, pendingReward, removeButton),
      );
      rewardActions.append(cta, removeButton);
      item.appendChild(rewardActions);
    }
    return item;
  }

  function renderRewardList(widget, container, rewards, points, pendingReward) {
    container.replaceChildren();

    const list = document.createElement("ul");
    list.className = "loyalty-points-widget__reward-list";

    rewards.forEach((reward) => {
      list.appendChild(
        createRewardItem(
          widget,
          container,
          reward,
          Number(reward.points) <= points,
          pendingReward,
        ),
      );
    });

    container.appendChild(list);
  }

  function renderAvailableRewards(
    widget,
    container,
    dataset,
    rewards,
    points,
    pendingReward,
  ) {
    if (dataset.showRewards !== "true") return;

    container.replaceChildren();

    const availableRewards = rewards.filter(
      (reward) => Number(reward.points) <= points,
    );
    appendText(
      container,
      "p",
      "loyalty-points-widget__rewards-title",
      dataset.rewardsHeading,
    );

    if (availableRewards.length === 0) {
      appendText(
        container,
        "p",
        "loyalty-points-widget__message",
        dataset.noRewardsMessage,
      );
      container.hidden = false;
      return;
    }

    renderRewardList(
      widget,
      container,
      availableRewards,
      points,
      pendingReward,
    );
    container.hidden = false;
  }

  async function loadWidgetData(widget) {
    if (widget.dataset.loyaltyDataLoading === "true") return;

    widget.dataset.loyaltyDataLoading = "true";
    const dataset = widget.dataset;
    const status = widget.querySelector("[data-loyalty-status]");
    const balance = widget.querySelector("[data-loyalty-balance]");
    const balanceValue = widget.querySelector("[data-loyalty-balance-value]");
    const viewPoints = widget.querySelectorAll("[data-loyalty-view-points]");
    const rewardsContainer = widget.querySelector("[data-loyalty-rewards]");
    const allRewardsContainer = widget.querySelector(
      "[data-loyalty-all-rewards]",
    );
    const availableCount = widget.querySelector(
      "[data-loyalty-available-count]",
    );

    try {
      const params = new URLSearchParams({
        customerId: dataset.customerId || "",
        shop: dataset.shopDomain || "",
        surface: "theme",
      });
      const ruleContext = await getCartRuleContext();

      if (ruleContext) {
        params.set("cartSubtotal", String(ruleContext.cartSubtotal));
        params.set("productIds", JSON.stringify(ruleContext.productIds));
        params.set("cartLines", JSON.stringify(ruleContext.cartLines));
      }

      const response = await fetch(`${dataset.balanceUrl}?${params}`);
      const data = await readJsonResponse(response, dataset.errorMessage);

      if (!data.success) {
        throw new Error(data.message || dataset.errorMessage);
      }

      applyCustomCss(data.iframeCustomCss);
      widget.dataset.currencyCode =
        dataset.currencyCode || data.currencyCode || "USD";
      loadCustomCss(widget);

      if (dataset.loggedIn !== "true") return;

      const points = Number(data.loyaltyPoints || 0);
      const rewards = Array.isArray(data.rewardOptions)
        ? data.rewardOptions.filter(
            (reward) =>
              reward &&
              Number.isFinite(Number(reward.points)) &&
              Number(reward.points) > 0,
          )
        : [];
      const availableRewards = rewards.filter(
        (reward) => Number(reward.points) <= points,
      );
      const pendingCheckoutRedemption = normalizePendingReward(
        data.pendingCheckoutRedemption || null,
      );
      const hasPendingCheckoutRedemption = Boolean(
        data.hasPendingCheckoutRedemption || pendingCheckoutRedemption,
      );

      if (data.customerId) {
        widget.dataset.loyaltyCustomerId = String(data.customerId);
      }

      widget.dataset.hasPendingCheckoutRedemption = String(
        hasPendingCheckoutRedemption,
      );

      if (availableCount) {
        availableCount.textContent =
          availableRewards.length === 1
            ? "You have 1 reward available"
            : `You have ${availableRewards.length} rewards available`;
      }

      if (status) status.hidden = true;
      if (balance) balance.hidden = false;
      if (balanceValue) balanceValue.textContent = points.toLocaleString();
      viewPoints.forEach((element) => {
        element.textContent = points.toLocaleString();
      });

      if (
        rewardsContainer &&
        rewards.length > 0 &&
        data.checkoutRedemptionEnabled !== false
      ) {
        renderAvailableRewards(
          widget,
          rewardsContainer,
          dataset,
          rewards,
          points,
          pendingCheckoutRedemption,
        );
      } else if (rewardsContainer) {
        rewardsContainer.hidden = true;
      }

      if (allRewardsContainer) {
        renderRewardList(
          widget,
          allRewardsContainer,
          rewards,
          points,
          pendingCheckoutRedemption,
        );
      }
    } catch (error) {
      console.error("[loyalty-points] Could not load balance", error);

      if (status) {
        status.hidden = false;
        status.textContent = dataset.errorMessage;
      }
      if (balance) balance.hidden = false;
      if (balanceValue) balanceValue.textContent = "--";
      if (rewardsContainer) rewardsContainer.hidden = true;
    } finally {
      delete widget.dataset.loyaltyDataLoading;
    }
  }

  async function getCartRuleContext() {
    try {
      const response = await fetch("/cart.js", {
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        return null;
      }

      const cart = await response.json();
      const cartLines = Array.isArray(cart.items)
        ? cart.items.map((item) => ({
            productId: item.product_id ? String(item.product_id) : "",
            variantId: item.variant_id ? String(item.variant_id) : "",
            quantity: item.quantity || 0,
          }))
        : [];

      return {
        cartSubtotal: Number(cart.items_subtotal_price || 0) / 100,
        cartLines,
        productIds: [
          ...new Set(cartLines.map((line) => line.productId).filter(Boolean)),
        ],
      };
    } catch {
      return null;
    }
  }

  function setWidgetOpen(widget, open, restoreFocus = false) {
    const launcher = widget.querySelector("[data-loyalty-toggle]");
    const panel = widget.querySelector("[data-loyalty-panel]");
    const closeButton = widget.querySelector("[data-loyalty-close]");

    if (!launcher || !panel) return;

    panel.hidden = !open;
    launcher.setAttribute("aria-expanded", String(open));
    widget.classList.toggle("loyalty-points-widget--open", open);

    if (open) closeButton?.focus();
    if (!open && restoreFocus) launcher.focus();
  }

  function ensureCriticalStyles() {
    if (document.getElementById("loyalty-points-widget-critical-styles"))
      return;

    const style = document.createElement("style");
    style.id = "loyalty-points-widget-critical-styles";
    style.textContent = `
      .loyalty-points-widget--floating {
        position: fixed;
        z-index: 9999;
        right: 16px;
        bottom: 16px;
        left: auto;
        width: min(380px, calc(100vw - 32px));
        margin: 0;
        font-family: inherit;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__launcher {
        display: flex;
        align-items: center;
        gap: 9px;
        min-height: 52px;
        margin-right: 0;
        margin-left: auto;
        border: 0;
        border-radius: 8px;
        padding: 0 20px;
        background: var(--loyalty-accent-color, #008060);
        color: #fff;
        box-shadow: 0 6px 20px rgba(32, 34, 35, 0.18);
        cursor: pointer;
        font: inherit;
        font-weight: 700;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__inner {
        max-height: min(640px, calc(100vh - 96px));
        margin-bottom: 12px;
        overflow-y: auto;
        border: 1px solid rgba(32, 34, 35, 0.12);
        border-radius: 8px;
        padding: 20px;
        background: #fff;
        box-shadow: 0 12px 36px rgba(32, 34, 35, 0.22);
      }

      .loyalty-points-widget--floating [hidden] {
        display: none !important;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__header {
        margin-bottom: 14px;
        text-align: center;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__eyebrow {
        margin: 0 0 4px;
        color: var(--loyalty-accent-color, #008060);
        font-size: 0.78em;
        font-weight: 700;
        letter-spacing: 0;
        text-transform: uppercase;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__title {
        margin: 0;
        font-size: 1.35em;
        line-height: 1.25;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__message,
      .loyalty-points-widget--floating .loyalty-points-widget__balance {
        margin: 0;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__balance {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin-top: 14px;
        border: 1px solid rgba(0, 128, 96, 0.22);
        border-radius: 8px;
        padding: 14px;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__balance-label {
        color: #616a75;
        font-size: 0.9em;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__balance-value {
        color: var(--loyalty-accent-color, #008060);
        font-size: 1.5em;
        font-weight: 700;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__panel-top {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin: -4px -4px 12px;
        color: var(--loyalty-accent-color, #008060);
      }

      .loyalty-points-widget--floating .loyalty-points-widget__launcher-icon,
      .loyalty-points-widget--floating .loyalty-points-widget__brand-icon {
        font-size: 1.2em;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__close {
        width: 34px;
        height: 34px;
        border: 0;
        border-radius: 50%;
        background: #f1f2f3;
        color: #202223;
        cursor: pointer;
        font-size: 24px;
        line-height: 1;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__guest-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
        margin-top: 18px;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__button {
        border: 1px solid var(--loyalty-accent-color, #008060);
        border-radius: 6px;
        padding: 11px 14px;
        color: var(--loyalty-accent-color, #008060);
        text-align: center;
        text-decoration: none;
        font-weight: 700;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__button--primary {
        background: var(--loyalty-accent-color, #008060);
        color: #fff;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__actions {
        display: grid;
        gap: 10px;
        margin-top: 22px;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__action,
      .loyalty-points-widget--floating .loyalty-points-widget__action-link {
        width: 100%;
        border: 1px solid rgba(0, 128, 96, 0.22);
        border-radius: 8px;
        background: #fff;
        color: #202223;
        font: inherit;
        text-align: left;
        text-decoration: none;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__action summary,
      .loyalty-points-widget--floating .loyalty-points-widget__action-link {
        display: grid;
        grid-template-columns: 24px 1fr 18px;
        align-items: center;
        gap: 8px;
        padding: 14px;
        cursor: pointer;
        color: #202223;
        list-style: none;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__action summary::-webkit-details-marker {
        display: none;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__action summary span,
      .loyalty-points-widget--floating .loyalty-points-widget__action-link span {
        color: var(--loyalty-accent-color, #008060);
        font-size: 1.2em;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__action-link--rewards strong,
      .loyalty-points-widget--floating .loyalty-points-widget__action-link--rewards small {
        display: block;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__action-link--rewards small {
        margin-top: 3px;
        color: #616a75;
        font-size: 0.86em;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__rewards {
        margin-top: 18px;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__reward-list {
        display: grid;
        gap: 10px;
        margin: 0;
        padding: 0;
        list-style: none;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__reward {
        border: 1px solid rgba(32, 34, 35, 0.12);
        border-radius: 8px;
        overflow: hidden;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__reward-button {
        display: block;
        width: 100%;
        border: 0;
        padding: 14px;
        background: transparent;
        color: inherit;
        cursor: pointer;
        font: inherit;
        text-align: left;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__reward-button:hover,
      .loyalty-points-widget--floating .loyalty-points-widget__reward-button:focus-visible {
        background: rgba(0, 128, 96, 0.05);
        outline: 2px solid var(--loyalty-accent-color, #008060);
        outline-offset: -2px;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__reward-button:disabled {
        cursor: wait;
        opacity: 0.7;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__reward-title,
      .loyalty-points-widget--floating .loyalty-points-widget__reward-description {
        margin: 0;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__reward-title {
        font-weight: 700;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__reward-description {
        margin-top: 4px;
        opacity: 0.75;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__reward-cta {
        display: block;
        margin-top: 10px;
        color: var(--loyalty-accent-color, #008060);
        font-size: 0.86em;
        font-weight: 700;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__reward-message {
        margin: 0 0 10px;
        border-radius: 6px;
        padding: 10px 12px;
        background: #f6faf8;
        color: #0c5132;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__reward-message--error {
        background: #fff4f4;
        color: #8e1f0b;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__see-more {
        width: 100%;
        margin-top: 12px;
        border: 1px solid var(--loyalty-accent-color, #008060);
        border-radius: 6px;
        padding: 11px 14px;
        background: transparent;
        color: var(--loyalty-accent-color, #008060);
        cursor: pointer;
        font: inherit;
        font-weight: 700;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__view {
        margin: 0;
        min-height: 0;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__view-header {
        position: sticky;
        z-index: 2;
        top: 0;
        display: grid;
        grid-template-columns: 36px 1fr 36px;
        align-items: center;
        gap: 10px;
        padding: 14px 16px;
        background: #e3e5e7;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__back {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 36px;
        height: 36px;
        margin: 0;
        border: 0;
        padding: 0;
        background: transparent;
        color: #202223;
        cursor: pointer;
        font: inherit;
        font-size: 1.6em;
        font-weight: 700;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__view-header strong,
      .loyalty-points-widget--floating .loyalty-points-widget__view-header small {
        display: block;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__view-header small {
        margin-top: 2px;
        color: #616a75;
        font-size: 0.75em;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__view-close {
        width: 36px;
        height: 36px;
        border: 0;
        background: transparent;
        color: #202223;
        cursor: pointer;
        font-size: 1.5em;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__view-content {
        padding: 22px 0 0;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__view-content h3 {
        margin: 0 0 14px;
        font-size: 1.05em;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__method-list {
        display: grid;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__method {
        display: grid;
        grid-template-columns: 30px 1fr;
        gap: 12px;
        padding: 16px 4px;
        border-bottom: 1px solid #e3e5e7;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__method > span {
        color: var(--loyalty-accent-color, #008060);
        font-size: 1.25em;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__method strong,
      .loyalty-points-widget--floating .loyalty-points-widget__method p {
        margin: 0;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__method p {
        margin-top: 4px;
        color: #616a75;
        font-size: 0.9em;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__view .loyalty-points-widget__reward-list {
        gap: 0;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__view .loyalty-points-widget__reward {
        border-width: 0 0 1px;
        border-radius: 0;
      }

      .loyalty-points-widget--floating .loyalty-points-widget__view .loyalty-points-widget__reward-button {
        padding: 16px 4px;
      }

      @media (max-width: 480px) {
        .loyalty-points-widget--floating {
          right: 12px;
          bottom: 12px;
          width: min(380px, calc(100vw - 24px));
        }

        .loyalty-points-widget--floating .loyalty-points-widget__inner {
          max-height: calc(100vh - 84px);
        }
      }

      .loyalty-points-widget--floating-iframe {
        position: fixed;
        z-index: 9999;
        right: 0;
        bottom: 0;
        width: min(220px, 100vw);
        height: 92px;
        margin: 0;
        pointer-events: none;
      }

      .loyalty-points-widget--floating-iframe.loyalty-points-widget--iframe-open {
        width: min(420px, 100vw);
        height: min(720px, 100vh);
      }

      .loyalty-points-widget__floating-iframe {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        background: transparent;
        pointer-events: auto;
      }
    `;

    document.head.appendChild(style);
  }

  function applyFloatingLayoutStyles(widget) {
    if (widget.dataset.displayMode !== "floating") return;

    setImportantStyles(widget, {
      position: "fixed",
      "z-index": "2147483000",
      right: "16px",
      bottom: "16px",
      left: "auto",
      width: "min(380px, calc(100vw - 32px))",
      margin: "0",
      transform: "none",
      "font-family": "inherit",
    });

    const launcher = widget.querySelector("[data-loyalty-toggle]");
    if (launcher) {
      setImportantStyles(launcher, {
        display: "flex",
        "align-items": "center",
        gap: "9px",
        "min-height": "52px",
        "margin-right": "0",
        "margin-left": "auto",
        "pointer-events": "auto",
      });
    }
  }

  function applyFloatingIframeLayoutStyles(widget) {
    if (widget.dataset.displayMode !== "floating_iframe") return;

    setImportantStyles(widget, {
      position: "fixed",
      "z-index": "2147483000",
      right: "0",
      bottom: "0",
      left: "auto",
      margin: "0",
      transform: "none",
      "pointer-events": "none",
    });

    if (widget.classList.contains("loyalty-points-widget--iframe-open")) {
      setImportantStyles(widget, {
        width: "min(420px, 100vw)",
        height: "min(720px, 100vh)",
      });
    } else {
      setImportantStyles(widget, {
        width: "min(220px, 100vw)",
        height: "92px",
      });
    }

    const iframe = widget.querySelector(
      ".loyalty-points-widget__floating-iframe",
    );
    if (iframe) {
      setImportantStyles(iframe, {
        display: "block",
        width: "100%",
        height: "100%",
        border: "0",
        "pointer-events": "auto",
      });
    }
  }

  function getFloatingWidgets() {
    return Array.from(
      document.querySelectorAll(
        '[data-loyalty-floating-wrapper], [data-loyalty-points-widget][data-display-mode="floating"]',
      ),
    ).filter((widget) =>
      ["floating", "floating_iframe"].includes(widget.dataset.displayMode),
    );
  }

  function removeDuplicateFloatingWidgets(widget) {
    const globalWidget = getFloatingWidgets().find(
      (floatingWidget) =>
        floatingWidget.dataset.loyaltyGlobalFloating === "true",
    );

    if (globalWidget && globalWidget !== widget) {
      widget.remove();
      return false;
    }

    getFloatingWidgets().forEach((floatingWidget) => {
      if (floatingWidget !== widget) floatingWidget.remove();
    });

    return true;
  }

  function mountFloatingElement(widget) {
    if (!["floating", "floating_iframe"].includes(widget.dataset.displayMode))
      return;
    if (!widget.isConnected) return;

    ensureCriticalStyles();
    applyFloatingLayoutStyles(widget);
    applyFloatingIframeLayoutStyles(widget);

    if (!removeDuplicateFloatingWidgets(widget)) return;

    if (widget.parentElement === document.body) return;

    widget.dataset.loyaltyBodyMounted = "true";
    document.body.appendChild(widget);
    applyFloatingLayoutStyles(widget);
    applyFloatingIframeLayoutStyles(widget);
  }

  function initializeWidget(widget) {
    captureReferral(widget);
    loadReferralProfile(widget);
    mountFloatingElement(widget);

    if (widget.dataset.loyaltyReady === "true") return;

    widget.dataset.loyaltyReady = "true";

    widget.querySelectorAll("[data-loyalty-view-target]").forEach((button) => {
      button.addEventListener("click", () => {
        const target = button.dataset.loyaltyViewTarget;
        const isOverview = target === "overview";
        const header = widget.querySelector(".loyalty-points-widget__header");
        const panelTop = widget.querySelector(
          ".loyalty-points-widget__panel-top",
        );
        const balance = widget.querySelector("[data-loyalty-balance]");
        const actions = widget.querySelector(".loyalty-points-widget__actions");
        const panel = widget.querySelector("[data-loyalty-panel]");

        if (header) header.hidden = !isOverview;
        if (panelTop) panelTop.hidden = !isOverview;
        if (balance) balance.hidden = !isOverview;
        if (actions) actions.hidden = !isOverview;
        if (panel) panel.scrollTop = 0;

        widget.querySelectorAll("[data-loyalty-view]").forEach((view) => {
          view.hidden = view.dataset.loyaltyView !== target;
        });
      });
    });
  }

  function initializeWidgets() {
    document
      .querySelectorAll("[data-loyalty-floating-wrapper]")
      .forEach((widget) => {
        mountFloatingElement(widget);
      });

    document
      .querySelectorAll("[data-loyalty-points-widget]")
      .forEach((widget) => {
        initializeWidget(widget);
        if (widget.dataset.loyaltyDataLoaded !== "true") {
          widget.dataset.loyaltyDataLoaded = "true";
          loadWidgetData(widget);
        }
      });
  }

  window.addEventListener("message", (event) => {
    if (event.data?.type === "loyalty-floating-iframe-state") {
      document
        .querySelectorAll(".loyalty-points-widget__floating-iframe")
        .forEach((iframe) => {
          if (iframe.contentWindow !== event.source) return;

          const wrapper = iframe.closest(
            ".loyalty-points-widget--floating-iframe",
          );
          wrapper?.classList.toggle(
            "loyalty-points-widget--iframe-open",
            Boolean(event.data.open),
          );
          if (wrapper) applyFloatingIframeLayoutStyles(wrapper);
        });
      return;
    }

    if (event.data?.type !== "loyalty-iframe-height") return;

    const height = Number(event.data.height);
    if (!Number.isFinite(height) || height < 120) return;

    document
      .querySelectorAll(".loyalty-points-widget__iframe")
      .forEach((iframe) => {
        if (iframe.contentWindow !== event.source) return;

        iframe.style.height = `${Math.min(Math.ceil(height), 1200)}px`;
      });
  });

  let initializeScheduled = false;

  function scheduleInitializeWidgets() {
    if (initializeScheduled) return;

    initializeScheduled = true;
    window.requestAnimationFrame(() => {
      initializeScheduled = false;
      initializeWidgets();
    });
  }

  window.__loyaltyPointsController = {
    initializeWidgets,
    scheduleInitializeWidgets,
  };

  function bindNavigationEvents() {
    if (window.__loyaltyPointsNavigationBound) return;
    window.__loyaltyPointsNavigationBound = true;

    const scheduleFromNavigation = () => scheduleInitializeWidgets();
    const originalPushState = window.history.pushState;
    const originalReplaceState = window.history.replaceState;

    window.history.pushState = function pushStateWithLoyaltyRefresh(...args) {
      const result = originalPushState.apply(this, args);
      scheduleFromNavigation();
      return result;
    };

    window.history.replaceState = function replaceStateWithLoyaltyRefresh(
      ...args
    ) {
      const result = originalReplaceState.apply(this, args);
      scheduleFromNavigation();
      return result;
    };

    window.addEventListener("popstate", scheduleFromNavigation);
    window.addEventListener("hashchange", scheduleFromNavigation);
    document.addEventListener("turbo:load", scheduleFromNavigation);
    document.addEventListener("turbo:render", scheduleFromNavigation);
    document.addEventListener("page:load", scheduleFromNavigation);
    document.addEventListener("swup:contentReplaced", scheduleFromNavigation);
  }

  function nodeHasLoyaltyWidget(node) {
    if (!(node instanceof Element)) return false;

    return (
      node.matches("[data-loyalty-points-widget]") ||
      node.matches("[data-loyalty-floating-wrapper]") ||
      Boolean(
        node.querySelector(
          "[data-loyalty-points-widget], [data-loyalty-floating-wrapper]",
        ),
      )
    );
  }

  document.addEventListener(
    "click",
    (event) => {
      const copyReferral = event.target.closest("[data-loyalty-copy-referral]");
      if (copyReferral) {
        const input = copyReferral.parentElement?.querySelector("[data-loyalty-referral-link]");
        if (input?.value) {
          navigator.clipboard?.writeText(input.value);
          copyReferral.textContent = "Copied";
        }
        return;
      }
      const toggle = event.target.closest("[data-loyalty-toggle]");
      const closeButton = event.target.closest("[data-loyalty-close]");
      const control = toggle || closeButton;

      if (!control) return;

      const widget = control.closest("[data-loyalty-points-widget]");
      if (!widget) return;

      if (toggle) {
        event.preventDefault();
        event.stopPropagation();
        const shouldOpen = toggle.getAttribute("aria-expanded") !== "true";
        setWidgetOpen(widget, shouldOpen);
        if (shouldOpen) loadWidgetData(widget);
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setWidgetOpen(widget, false, true);
    },
    true,
  );

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;

    document
      .querySelectorAll('[data-loyalty-toggle][aria-expanded="true"]')
      .forEach((toggle) => {
        const widget = toggle.closest("[data-loyalty-points-widget]");
        if (widget) setWidgetOpen(widget, false, true);
      });
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeWidgets);
  } else {
    initializeWidgets();
  }

  document.addEventListener("shopify:section:load", initializeWidgets);
  document.addEventListener(
    "shopify:section:reorder",
    scheduleInitializeWidgets,
  );
  document.addEventListener(
    "shopify:section:select",
    scheduleInitializeWidgets,
  );
  window.addEventListener("pageshow", scheduleInitializeWidgets);
  bindNavigationEvents();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scheduleInitializeWidgets();
  });

  new MutationObserver((mutations) => {
    if (
      mutations.some((mutation) =>
        Array.from(mutation.addedNodes).some(nodeHasLoyaltyWidget),
      )
    ) {
      scheduleInitializeWidgets();
    }
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
