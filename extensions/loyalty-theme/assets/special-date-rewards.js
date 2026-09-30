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
    const forms = Array.from(root.querySelectorAll("[data-special-date-form]"));
    if (!forms.length) return;
    const endpoint = root.dataset.endpoint;
    const empty = root.querySelector("[data-special-date-empty]");
    let profile = null;

    const setBusy = (form, busy) => {
      form.querySelectorAll("button, input").forEach((control) => {
        control.disabled = busy;
      });
    };

    const applyProfile = (nextProfile) => {
      profile = nextProfile;
      let enabledCount = 0;
      forms.forEach((form) => {
        const slot = Number(form.dataset.slot);
        const reward = profile?.rewards?.find((item) => item.slot === slot);
        form.hidden = !reward?.enabled;
        if (!reward?.enabled) return;
        enabledCount += 1;
        const month = form.elements.namedItem("month");
        const day = form.elements.namedItem("day");
        const saved = form.querySelector("[data-special-date-saved]");
        form.querySelector("[data-special-date-heading]").textContent =
          reward.heading;
        form.querySelector("[data-special-date-rule]").textContent =
          root.dataset.ruleTemplate
            .replace("__POINTS__", String(reward.points))
            .replace("__DAYS__", String(profile.minimumLeadDays));
        month.value = reward.date?.month || "";
        day.value = reward.date?.day || "";
        saved.hidden = !reward.date;
        saved.textContent = reward.date
          ? root.dataset.savedTemplate.replace("__DATE__", reward.date.label)
          : "";
        form.querySelector("[data-special-date-save]").textContent = reward.date
          ? root.dataset.updateText
          : root.dataset.saveText;
        form.querySelector("[data-special-date-remove]").hidden = !reward.date;
      });
      empty.hidden = enabledCount > 0;
    };

    forms.forEach((form) => {
      const slot = Number(form.dataset.slot);
      const message = form.querySelector("[data-special-date-message]");
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        setBusy(form, true);
        message.textContent = root.dataset.loadingText;
        try {
          const data = await readJson(
            await fetch(endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                slot,
                date: {
                  month: Number(form.elements.namedItem("month").value),
                  day: Number(form.elements.namedItem("day").value),
                },
              }),
            }),
            root.dataset.errorText,
          );
          applyProfile(data.specialDates);
          message.textContent = root.dataset.savedText;
        } catch (error) {
          message.textContent = error.message || root.dataset.errorText;
        } finally {
          setBusy(form, false);
        }
      });

      form
        .querySelector("[data-special-date-remove]")
        .addEventListener("click", async () => {
          setBusy(form, true);
          message.textContent = root.dataset.loadingText;
          try {
            const data = await readJson(
              await fetch(endpoint, {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "delete", slot }),
              }),
              root.dataset.errorText,
            );
            applyProfile(data.specialDates);
            message.textContent = root.dataset.removedText;
          } catch (error) {
            message.textContent = error.message || root.dataset.errorText;
          } finally {
            setBusy(form, false);
          }
        });
    });

    forms.forEach((form) => setBusy(form, true));
    Promise.resolve()
      .then(async () => {
        const data = await readJson(
          await fetch(endpoint, { headers: { Accept: "application/json" } }),
          root.dataset.errorText,
        );
        applyProfile(data.specialDates);
      })
      .catch((error) => {
        empty.hidden = false;
        empty.textContent = error.message || root.dataset.errorText;
      })
      .finally(() => forms.forEach((form) => setBusy(form, false)));
  }

  function initializeAll() {
    document
      .querySelectorAll("[data-loyalty-special-dates]")
      .forEach(initialize);
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
