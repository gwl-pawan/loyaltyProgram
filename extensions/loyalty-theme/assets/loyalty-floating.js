"use strict";

(() => {
  if (document.__loyaltyFloatingEmbedLoaded) return;
  document.__loyaltyFloatingEmbedLoaded = true;

  const WRAPPER_SELECTOR = '[data-loyalty-global-floating="true"]';
  const CLOSED_SIZE = {
    width: "min(220px, 100vw)",
    height: "92px",
  };
  const OPEN_SIZE = {
    width: "min(420px, 100vw)",
    height: "min(720px, 100vh)",
  };

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

  async function updateReferralCartAttribute(wrapper, visitorToken) {
    const endpoint = wrapper.dataset.cartUpdateUrl || "/cart/update.js";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        attributes: {
          __loyalty_referral_token: visitorToken || "",
        },
      }),
    });

    if (!response.ok) throw new Error("Could not persist referral on cart");
  }

  async function captureReferral(wrapper) {
    if (wrapper.dataset.loyaltyReferralCaptureStatus) return;
    wrapper.dataset.loyaltyReferralCaptureStatus = "loading";

    const dataset = wrapper.dataset;
    const shopDomain = dataset.shopDomain;
    if (!shopDomain) {
      wrapper.dataset.loyaltyReferralCaptureStatus = "unavailable";
      return;
    }

    const storageKey = `loyalty-referral:${shopDomain}`;
    const code = new URL(window.location.href).searchParams.get("ref");
    let visit;

    try {
      visit = JSON.parse(window.localStorage.getItem(storageKey) || "null");
    } catch {
      visit = null;
    }

    if (visit?.expiresAt && new Date(visit.expiresAt).getTime() <= Date.now()) {
      window.localStorage.removeItem(storageKey);
      visit = null;
    }

    if (code && (!visit || visit.code !== code)) {
      visit = {
        code,
        visitorToken:
          window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      };
      window.localStorage.setItem(storageKey, JSON.stringify(visit));
    }

    if (!visit?.visitorToken) {
      wrapper.dataset.loyaltyReferralCaptureStatus = "empty";
      return;
    }

    const endpoint = `${(dataset.apiBaseUrl || "/apps/loyalty-points").replace(/\/$/, "")}/api/referrals`;

    try {
      if (code) {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({
            action: "track",
            code: visit.code,
            visitorToken: visit.visitorToken,
            landingUrl: window.location.href,
          }),
        });
        const result = await readJsonResponse(
          response,
          "Could not track referral",
        );

        if (!result.tracked) {
          window.localStorage.removeItem(storageKey);
          wrapper.dataset.loyaltyReferralCaptureStatus = "rejected";
          return;
        }

        if (result.expiresAt) {
          visit.expiresAt = result.expiresAt;
          window.localStorage.setItem(storageKey, JSON.stringify(visit));
        }
      }

      await updateReferralCartAttribute(wrapper, visit.visitorToken);

      if (dataset.customerId) {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({
            action: "claim",
            visitorToken: visit.visitorToken,
          }),
        });
        const result = await readJsonResponse(
          response,
          "Could not claim referral",
        );

        if (result.claimed) {
          await updateReferralCartAttribute(wrapper, "");
          window.localStorage.removeItem(storageKey);
        }
      }

      wrapper.dataset.loyaltyReferralCaptureStatus = "complete";
    } catch (error) {
      wrapper.dataset.loyaltyReferralCaptureStatus = "failed";
      console.warn("[loyalty-referrals] Could not capture referral", error);
    }
  }

  function setImportantStyles(element, styles) {
    Object.entries(styles).forEach(([property, value]) => {
      element.style.setProperty(property, value, "important");
    });
  }

  function applyLayout(wrapper) {
    const isOpen = wrapper.classList.contains(
      "loyalty-points-widget--iframe-open",
    );

    setImportantStyles(wrapper, {
      position: "fixed",
      "z-index": "2147483000",
      right: "0",
      bottom: "0",
      left: "auto",
      margin: "0",
      transform: "none",
      "pointer-events": "none",
      ...(isOpen ? OPEN_SIZE : CLOSED_SIZE),
    });

    const iframe = wrapper.querySelector(
      ".loyalty-points-widget__floating-iframe",
    );
    if (!iframe) return;

    setImportantStyles(iframe, {
      display: "block",
      width: "100%",
      height: "100%",
      border: "0",
      background: "transparent",
      "pointer-events": "auto",
    });
  }

  function removeSectionFloatingWidgets(globalWrapper) {
    document
      .querySelectorAll(
        '[data-loyalty-points-widget][data-display-mode="floating"], [data-loyalty-floating-wrapper]:not([data-loyalty-global-floating="true"])',
      )
      .forEach((widget) => {
        if (widget !== globalWrapper) widget.remove();
      });
  }

  function initialize() {
    const wrappers = Array.from(document.querySelectorAll(WRAPPER_SELECTOR));
    const wrapper = wrappers.shift();
    if (!wrapper) return;

    wrappers.forEach((duplicate) => duplicate.remove());
    removeSectionFloatingWidgets(wrapper);

    if (wrapper.parentElement !== document.body) {
      document.body.appendChild(wrapper);
    }

    captureReferral(wrapper);
    applyLayout(wrapper);
  }

  window.addEventListener("message", (event) => {
    if (event.data?.type !== "loyalty-floating-iframe-state") return;

    document.querySelectorAll(WRAPPER_SELECTOR).forEach((wrapper) => {
      const iframe = wrapper.querySelector(
        ".loyalty-points-widget__floating-iframe",
      );
      if (!iframe || iframe.contentWindow !== event.source) return;

      wrapper.classList.toggle(
        "loyalty-points-widget--iframe-open",
        Boolean(event.data.open),
      );
      applyLayout(wrapper);
    });
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, {once: true});
  } else {
    initialize();
  }

  document.addEventListener("shopify:section:load", initialize);
  window.addEventListener("pageshow", initialize);

  new MutationObserver((mutations) => {
    if (mutations.some((mutation) => mutation.addedNodes.length > 0)) {
      initialize();
    }
  }).observe(document.documentElement, {childList: true, subtree: true});
})();
