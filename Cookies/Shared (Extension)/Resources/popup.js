/* popup.js — settings toggles and the current tab's status. */
"use strict";

(() => {
  const FALLBACK = {
    status_rejected_rule: "Rejected via $1 rule",
    status_rejected_model: "Rejected via on-device model",
    status_none: "No banner found",
    status_off: "Turned off",
    status_paused: "Paused on this site",
    status_skipped_unavailable: "Skipped: model unavailable",
    status_skipped_uncertain: "Skipped: not confident enough to click",
    status_skipped_not_consent: "Skipped: not a cookie banner",
    status_skipped_none: "Skipped: no reject option found",
    status_skipped_no_reject: "Skipped: no reject option found",
    status_skipped_too_many: "Skipped: banner too complex",
    status_skipped_gate: "Skipped: failed safety check",
    status_skipped: "Skipped",
    status_error_steps: "Couldn’t finish rejecting via $1",
    status_error_verify: "Clicked reject, but the banner is still showing",
    status_error: "Something went wrong",
  };

  const t = (key, ...subs) => {
    let s = "";
    try {
      s = browser.i18n.getMessage(key, subs);
    } catch {
      s = "";
    }
    if (!s) s = (FALLBACK[key] || key).replace(/\$(\d)/g, (_, n) => subs[Number(n) - 1] ?? "");
    return s;
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    enabled: $("enabled"),
    paused: $("paused"),
    host: $("host"),
    siteRow: $("site-row"),
    noSiteRow: $("no-site-row"),
    status: $("status"),
    reason: $("reason"),
  };

  const ruleNames = new Map(((globalThis.__cookies && globalThis.__cookies.rules && globalThis.__cookies.rules.rules) || []).map((r) => [r.id, r.name]));

  const SKIP_KEYS = {
    unavailable: "status_skipped_unavailable",
    uncertain: "status_skipped_uncertain",
    "not-consent": "status_skipped_not_consent",
    none: "status_skipped_none",
    "no-reject-control": "status_skipped_no_reject",
    "only-dangerous-controls": "status_skipped_no_reject",
    "too-many-controls": "status_skipped_too_many",
    gate: "status_skipped_gate",
  };

  let state = { settings: { enabled: true, disabledHosts: [] }, host: "", status: null, tabId: null, url: "" };

  function hostPaused() {
    const h = state.host;
    return !!h && state.settings.disabledHosts.some((d) => h === d || h.endsWith(`.${d}`));
  }

  /** Map a status record to { text, tone, detail }. */
  function describe() {
    if (!state.settings.enabled) return { text: t("status_off"), tone: "muted" };
    if (hostPaused()) return { text: t("status_paused"), tone: "muted" };
    const s = state.status;
    if (!s || s.outcome === "none") return { text: t("status_none"), tone: "muted" };
    const cmpName = ruleNames.get(s.cmp) || s.reason || s.cmp || "";
    const detail = s.layer === "model" && s.reason ? s.reason : "";
    switch (s.outcome) {
      case "rejected":
        return s.layer === "rules" ? { text: t("status_rejected_rule", cmpName), tone: "ok" } : { text: t("status_rejected_model"), tone: "ok", detail };
      case "skipped":
        return { text: t(SKIP_KEYS[s.code] || "status_skipped"), tone: "warn", detail };
      default:
        if (s.code === "steps-failed") return { text: t("status_error_steps", cmpName), tone: "error" };
        if (s.code === "not-verified") return { text: t("status_error_verify"), tone: "error", detail };
        return { text: t("status_error"), tone: "error", detail };
    }
  }

  function render() {
    els.enabled.checked = state.settings.enabled;
    const hasSite = !!state.host;
    els.siteRow.hidden = !hasSite;
    els.noSiteRow.hidden = hasSite;
    els.host.textContent = state.host;
    els.paused.checked = hostPaused();
    els.paused.disabled = !state.settings.enabled;

    const d = describe();
    els.status.textContent = d.text;
    els.status.dataset.tone = d.tone;
    els.reason.hidden = !d.detail;
    els.reason.textContent = d.detail || "";
  }

  async function save(settings) {
    const reply = await browser.runtime.sendMessage({ type: "setSettings", settings });
    if (reply && reply.ok && reply.settings) state.settings = reply.settings;
    render();
  }

  async function load() {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      state.tabId = tab && typeof tab.id === "number" ? tab.id : null;
      state.url = (tab && tab.url) || "";
    } catch {
      /* no tab info; the popup still works for global settings */
    }
    const reply = await browser.runtime.sendMessage({ type: "getStatus", tabId: state.tabId, url: state.url });
    if (reply && reply.settings) state.settings = reply.settings;
    if (reply && reply.tab) {
      state.host = reply.tab.host || "";
      state.status = reply.tab.status || null;
    }
    render();
  }

  function localize() {
    for (const el of document.querySelectorAll("[data-i18n]")) {
      const s = t(el.dataset.i18n);
      if (s && s !== el.dataset.i18n) el.textContent = s;
    }
    document.documentElement.lang = (browser.i18n && browser.i18n.getUILanguage && browser.i18n.getUILanguage()) || "en";
  }

  els.enabled.addEventListener("change", () => {
    save({ ...state.settings, enabled: els.enabled.checked });
  });

  els.paused.addEventListener("change", () => {
    const h = state.host;
    if (!h) return;
    const others = state.settings.disabledHosts.filter((d) => !(h === d || h.endsWith(`.${d}`)));
    save({ ...state.settings, disabledHosts: els.paused.checked ? [...others, h] : others });
  });

  localize();
  render();
  load().catch(() => render());
})();
