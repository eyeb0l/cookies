/*
 * background.js — settings, per-tab status for the popup, and the bridge to
 * the native handler (browser.runtime.sendNativeMessage). Non-persistent:
 * state that must survive suspension lives in storage.
 */
"use strict";

const DEBUG = false;
const log = (...args) => {
  if (DEBUG) console.debug("[cookies:bg]", ...args);
};

// Safari ignores the application id, but the argument is still required.
const NATIVE_APP_ID = "dev.eyeb0l.cookies.Extension";
const NATIVE_TIMEOUT_MS = 15000;
const MAX_CLASSIFY_PER_TAB = 8; // per navigation; bounds iframe spam
const SETTINGS_KEY = "settings";
const TAB_STATE_KEY = "tabStatus";
const DEFAULT_SETTINGS = Object.freeze({ enabled: true, disabledHosts: Object.freeze([]) });

const RESULT_STATUSES = new Set(["ok", "none", "not-consent", "uncertain", "unavailable", "error"]);
const CONFIDENCES = new Set(["high", "medium", "low"]);
const ENGINES = new Set(["foundation-models", "none"]);
const OUTCOMES = new Set(["rejected", "skipped", "none", "error"]);
const LAYERS = new Set(["rules", "model"]);
const CANDIDATE_ID = /^c\d{1,2}$/;
const OUTCOME_RANK = { rejected: 4, error: 3, skipped: 2, none: 1 };

const api = typeof browser !== "undefined" ? browser : globalThis.browser;

// ---------------------------------------------------------------------------
// Helpers

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

function normalizeHost(value) {
  if (typeof value !== "string") return "";
  let host = value.trim().toLowerCase().replace(/\.$/, "");
  if (host.startsWith("www.")) host = host.slice(4);
  return /^[a-z0-9.-]{1,253}$/.test(host) || /^\[[0-9a-f:.]+\]$/.test(host) ? host : "";
}

function hostFromUrl(url) {
  if (typeof url !== "string") return "";
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return normalizeHost(u.hostname);
  } catch {
    return "";
  }
}

function sanitizeSettings(raw) {
  const s = isPlainObject(raw) ? raw : {};
  const hosts = Array.isArray(s.disabledHosts) ? s.disabledHosts : [];
  const disabledHosts = [...new Set(hosts.map(normalizeHost).filter(Boolean))].slice(0, 1000);
  return { enabled: typeof s.enabled === "boolean" ? s.enabled : DEFAULT_SETTINGS.enabled, disabledHosts };
}

/** A host is paused if it, or a parent domain, is in disabledHosts. */
function isHostDisabled(settings, host) {
  const h = normalizeHost(host);
  if (!h) return false;
  return settings.disabledHosts.some((d) => h === d || h.endsWith(`.${d}`));
}

// ---------------------------------------------------------------------------
// Validation of the wire format (docs/ARCHITECTURE.md)

/** Validate an identifyRejectControl request before it reaches native code. */
function validateRequest(req) {
  if (!isPlainObject(req)) return false;
  if (req.type !== "identifyRejectControl" || req.version !== 1) return false;
  const { page, container, candidates } = req;
  if (!isPlainObject(page) || typeof page.host !== "string" || page.host.length > 253) return false;
  if (typeof page.lang !== "string" || page.lang.length > 35) return false;
  if (page.frame !== "top" && page.frame !== "sub") return false;
  if (!isPlainObject(container) || typeof container.tag !== "string" || container.tag.length > 32) return false;
  if (typeof container.role !== "string" || container.role.length > 20) return false;
  if (typeof container.text !== "string" || container.text.length > 600) return false;
  if (!validAttrs(container.attrs)) return false;
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 12) return false;
  const ids = new Set();
  for (const c of candidates) {
    if (!isPlainObject(c)) return false;
    if (typeof c.id !== "string" || !CANDIDATE_ID.test(c.id) || ids.has(c.id)) return false;
    ids.add(c.id);
    if (typeof c.tag !== "string" || c.tag.length > 32) return false;
    if (typeof c.text !== "string" || c.text.length > 80) return false;
    if (typeof c.aria !== "string" || c.aria.length > 80) return false;
    if (typeof c.role !== "string" || c.role.length > 20) return false;
    if (typeof c.disabled !== "boolean") return false;
    if (!validAttrs(c.attrs)) return false;
  }
  return true;
}

function validAttrs(attrs) {
  if (!isPlainObject(attrs)) return false;
  const entries = Object.entries(attrs);
  if (entries.length > 6) return false;
  return entries.every(([k, v]) => (k === "id" || k === "class" || k === "name" || /^data-[a-z0-9_.:-]{1,55}$/.test(k)) && typeof v === "string" && v.length <= 60);
}

function errorResult(reason) {
  return {
    type: "identifyRejectControlResult",
    version: 1,
    status: "error",
    candidateId: null,
    confidence: null,
    reason: str(reason, 200),
    engine: "none",
  };
}

/**
 * Coerce whatever native code returned into a well-formed result. Anything
 * malformed becomes { status: "error" } — never "ok".
 */
function normalizeResult(raw, request) {
  if (!isPlainObject(raw)) return errorResult("Malformed reply from the app.");
  if (raw.type !== "identifyRejectControlResult" || raw.version !== 1) return errorResult("Malformed reply from the app.");
  if (!RESULT_STATUSES.has(raw.status)) return errorResult("Malformed reply from the app.");
  const reason = typeof raw.reason === "string" ? raw.reason.slice(0, 200) : "";
  const engine = ENGINES.has(raw.engine) ? raw.engine : "none";
  const confidence = raw.confidence == null ? null : CONFIDENCES.has(raw.confidence) ? raw.confidence : undefined;
  if (confidence === undefined) return errorResult("Malformed reply from the app.");

  if (raw.status === "ok") {
    const id = raw.candidateId;
    const known = request && Array.isArray(request.candidates) && request.candidates.some((c) => c.id === id);
    if (typeof id !== "string" || !CANDIDATE_ID.test(id) || !known) return errorResult("Reply named an unknown control.");
    if (confidence === null) return errorResult("Malformed reply from the app.");
    return { type: raw.type, version: 1, status: "ok", candidateId: id, confidence, reason, engine };
  }
  // candidateId is non-null only when status is "ok".
  if (raw.candidateId != null) return errorResult("Malformed reply from the app.");
  return { type: raw.type, version: 1, status: raw.status, candidateId: null, confidence, reason, engine };
}

function sanitizeStatus(raw) {
  if (!isPlainObject(raw) || !OUTCOMES.has(raw.outcome)) return null;
  const layer = LAYERS.has(raw.layer) ? raw.layer : null;
  const cmp = typeof raw.cmp === "string" && /^[a-z0-9-]{1,40}$/.test(raw.cmp) ? raw.cmp : null;
  const code = typeof raw.code === "string" && /^[a-z0-9-]{1,40}$/.test(raw.code) ? raw.code : null;
  return { outcome: raw.outcome, layer, cmp, reason: str(raw.reason, 200), code, at: Date.now() };
}

// ---------------------------------------------------------------------------
// State

/** tabId -> { host, frames: { [frameId]: status }, classify: number } */
let tabs = new Map();
let stateLoaded = null;

function sessionStore() {
  return api && api.storage && api.storage.session ? api.storage.session : null;
}

function loadState() {
  if (!stateLoaded) {
    stateLoaded = (async () => {
      const store = sessionStore();
      if (!store) return;
      try {
        const saved = (await store.get(TAB_STATE_KEY))[TAB_STATE_KEY];
        if (isPlainObject(saved)) {
          for (const [id, entry] of Object.entries(saved)) {
            if (isPlainObject(entry) && !tabs.has(Number(id))) tabs.set(Number(id), entry);
          }
        }
      } catch (e) {
        log("loadState", e);
      }
    })();
  }
  return stateLoaded;
}

async function persistState() {
  const store = sessionStore();
  if (!store) return;
  try {
    await store.set({ [TAB_STATE_KEY]: Object.fromEntries(tabs) });
  } catch (e) {
    log("persistState", e);
  }
}

function tabEntry(tabId) {
  let entry = tabs.get(tabId);
  if (!entry) {
    entry = { host: "", frames: {}, classify: 0 };
    tabs.set(tabId, entry);
  }
  return entry;
}

/** Most significant status across a tab's frames (a rejection anywhere wins). */
function aggregateStatus(entry) {
  if (!entry) return null;
  let best = null;
  for (const [frameId, s] of Object.entries(entry.frames || {})) {
    if (!s) continue;
    // Only the top frame may say "none" (iframes stay quiet when idle).
    if (s.outcome === "none" && frameId !== "0") continue;
    if (!best || OUTCOME_RANK[s.outcome] > OUTCOME_RANK[best.outcome] || (OUTCOME_RANK[s.outcome] === OUTCOME_RANK[best.outcome] && s.at > best.at)) best = s;
  }
  return best;
}

async function updateBadge(tabId) {
  if (!api || !api.action || typeof tabId !== "number" || tabId < 0) return;
  const status = aggregateStatus(tabs.get(tabId));
  const text = status && status.outcome === "rejected" ? "✓" : "";
  try {
    await api.action.setBadgeText({ tabId, text });
    if (text && api.action.setBadgeBackgroundColor) await api.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" });
  } catch (e) {
    log("badge", e);
  }
}

async function clearTab(tabId) {
  await loadState();
  tabs.delete(tabId);
  await persistState();
  await updateBadge(tabId);
}

async function getSettings() {
  try {
    const stored = await api.storage.local.get(SETTINGS_KEY);
    return sanitizeSettings(stored ? stored[SETTINGS_KEY] : undefined);
  } catch {
    return sanitizeSettings(undefined);
  }
}

async function setSettings(raw) {
  const settings = sanitizeSettings(raw);
  await api.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

// ---------------------------------------------------------------------------
// Native bridge

let nativeQueue = Promise.resolve();

/** Serialise native requests: the on-device model is a shared resource. */
function sendNative(request) {
  const run = async () => {
    let timer;
    try {
      const reply = await Promise.race([
        api.runtime.sendNativeMessage(NATIVE_APP_ID, request),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), NATIVE_TIMEOUT_MS);
        }),
      ]);
      return normalizeResult(reply, request);
    } catch (e) {
      log("native", e);
      return errorResult(e && e.message === "timeout" ? "The app took too long to answer." : "Could not reach the app.");
    } finally {
      clearTimeout(timer);
    }
  };
  const result = nativeQueue.then(run, run);
  nativeQueue = result.catch(() => {});
  return result;
}

// ---------------------------------------------------------------------------
// Message router

const fromContentScript = (sender) => !!(sender && sender.tab && typeof sender.tab.id === "number");
const fromOwnExtension = (sender) => !sender || !api.runtime.id || !sender.id || sender.id === api.runtime.id;

async function handleMessage(message, sender) {
  if (!isPlainObject(message) || typeof message.type !== "string") return undefined;
  if (!fromOwnExtension(sender)) return undefined;
  await loadState();

  switch (message.type) {
    case "getSettings": {
      // Content scripts ask before doing anything. The pause decision uses the
      // top-level page host so a paused site also covers its iframes.
      const settings = await getSettings();
      let host = "";
      if (fromContentScript(sender)) {
        const tabId = sender.tab.id;
        host = hostFromUrl(sender.tab.url) || (sender.frameId === 0 ? hostFromUrl(sender.url) : "") || tabEntry(tabId).host;
        if (host && (sender.frameId === 0 || !tabEntry(tabId).host)) tabEntry(tabId).host = host;
        await persistState();
      }
      const hostDisabled = isHostDisabled(settings, host);
      return { settings, host, hostDisabled, active: settings.enabled && !hostDisabled };
    }

    case "classify": {
      if (!fromContentScript(sender)) return errorResult("Not allowed.");
      const settings = await getSettings();
      const entry = tabEntry(sender.tab.id);
      if (!settings.enabled || isHostDisabled(settings, entry.host || hostFromUrl(sender.tab.url))) return errorResult("Disabled.");
      if (!validateRequest(message.request)) return errorResult("Invalid request.");
      if (entry.classify >= MAX_CLASSIFY_PER_TAB) return errorResult("Too many requests on this page.");
      entry.classify++;
      await persistState();
      return sendNative(message.request);
    }

    case "status": {
      if (!fromContentScript(sender)) return { ok: false };
      const status = sanitizeStatus(message.status);
      if (!status) return { ok: false };
      const tabId = sender.tab.id;
      const entry = tabEntry(tabId);
      entry.frames[String(sender.frameId ?? 0)] = status;
      await persistState();
      await updateBadge(tabId);
      return { ok: true };
    }

    case "getStatus": {
      // From the popup (no sender.tab); it passes the active tab's id.
      const settings = await getSettings();
      const tabId = typeof message.tabId === "number" ? message.tabId : fromContentScript(sender) ? sender.tab.id : null;
      const entry = tabId == null ? null : tabs.get(tabId);
      const host = (entry && entry.host) || hostFromUrl(message.url);
      return { settings, tab: { host, status: aggregateStatus(entry) } };
    }

    case "setSettings": {
      // Only extension pages (the popup) may change settings.
      if (fromContentScript(sender)) return { ok: false };
      const settings = await setSettings(message.settings);
      return { ok: true, settings };
    }

    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Wiring

if (api && api.runtime && api.runtime.onMessage) {
  api.runtime.onMessage.addListener((message, sender) => {
    const reply = handleMessage(message, sender).catch((e) => {
      log("handler", e);
      return message && message.type === "classify" ? errorResult("Internal error.") : undefined;
    });
    return reply;
  });
}

if (api && api.tabs) {
  if (api.tabs.onUpdated) {
    api.tabs.onUpdated.addListener((tabId, changeInfo) => {
      // A new document is loading: the previous page's status no longer applies.
      if (changeInfo && changeInfo.status === "loading") clearTab(tabId);
    });
  }
  if (api.tabs.onRemoved) api.tabs.onRemoved.addListener((tabId) => clearTab(tabId));
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    NATIVE_APP_ID,
    DEFAULT_SETTINGS,
    normalizeHost,
    hostFromUrl,
    sanitizeSettings,
    isHostDisabled,
    validateRequest,
    normalizeResult,
    errorResult,
    sanitizeStatus,
    aggregateStatus,
    handleMessage,
    sendNative,
    _tabs: () => tabs,
    _reset: () => {
      tabs = new Map();
      stateLoaded = null;
      nativeQueue = Promise.resolve();
    },
  };
}
