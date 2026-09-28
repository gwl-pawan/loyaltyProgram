"use strict";

(() => {
  async function readJson(response, fallback) {
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) {
      throw new Error(data?.message || fallback);
    }
    return data;
  }

  function initialize(root) {
    if (root.dataset.initialized === "true") return;
    root.dataset.initialized = "true";

    const form = root.querySelector("[data-birthday-form]");
    if (!form) return;
    const endpoint = root.dataset.endpoint;
    const month = form.elements.namedItem("month");
    const day = form.elements.namedItem("day");
    const message = root.querySelector("[data-birthday-message]");
    const removeButton = root.querySelector("[data-birthday-remove]");
    const saveButton = root.querySelector("[data-birthday-save]");
    const fields = root.querySelector("[data-birthday-fields]");
    const savedBirthday = root.querySelector("[data-birthday-saved]");
    const lockedMessage = root.querySelector("[data-birthday-locked]");
    const buttons = form.querySelectorAll("button");

    const setBusy = (busy) => {
      buttons.forEach((button) => {
        button.disabled = busy;
      });
    };
    const setMessage = (text) => {
      message.textContent = text || "";
    };
    const applyProfile = (profile) => {
      const hasBirthday = Boolean(profile?.birthday);
      const canSetBirthday = profile?.canSetBirthday !== false;

      month.value = "";
      day.value = "";
      fields.hidden = !canSetBirthday;
      saveButton.hidden = !canSetBirthday;
      removeButton.hidden = !hasBirthday;
      savedBirthday.hidden = !hasBirthday;
      savedBirthday.textContent = hasBirthday
        ? (root.dataset.savedTemplate || "Saved birthday: __BIRTHDAY__").replace(
            "__BIRTHDAY__",
            profile.birthday.label,
          )
        : "";
      lockedMessage.hidden = canSetBirthday;
      form.hidden = profile?.enabled === false;
      const description = root.querySelector("[data-birthday-description]");
      if (description && profile?.enabled) {
        description.textContent = root.dataset.ruleTemplate
          .replace("__POINTS__", String(profile.points))
          .replace("__DAYS__", String(profile.minimumLeadDays));
      }
    };

    async function load() {
      setBusy(true);
      setMessage(root.dataset.loadingText);
      try {
        const data = await readJson(
          await fetch(endpoint, { headers: { Accept: "application/json" } }),
          root.dataset.errorText,
        );
        applyProfile(data.birthday);
        setMessage("");
      } catch (error) {
        setMessage(error.message || root.dataset.errorText);
      } finally {
        setBusy(false);
      }
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      setBusy(true);
      setMessage(root.dataset.loadingText);
      try {
        const data = await readJson(
          await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              birthday: { month: Number(month.value), day: Number(day.value) },
            }),
          }),
          root.dataset.errorText,
        );
        applyProfile(data.birthday);
        setMessage(root.dataset.savedText);
      } catch (error) {
        setMessage(error.message || root.dataset.errorText);
      } finally {
        setBusy(false);
      }
    });

    removeButton.addEventListener("click", async () => {
      setBusy(true);
      setMessage(root.dataset.loadingText);
      try {
        const data = await readJson(
          await fetch(endpoint, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "delete" }),
          }),
          root.dataset.errorText,
        );
        applyProfile(data.birthday);
        setMessage(root.dataset.removedText);
      } catch (error) {
        setMessage(error.message || root.dataset.errorText);
      } finally {
        setBusy(false);
      }
    });

    load();
  }

  function initializeAll() {
    document.querySelectorAll("[data-loyalty-birthday]").forEach(initialize);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeAll, {
      once: true,
    });
  } else {
    initializeAll();
  }
  document.addEventListener("shopify:section:load", initializeAll);
})();
