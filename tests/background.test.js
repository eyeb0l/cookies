"use strict";
const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { RESOURCES, lib, load } = require("./helpers.js");

// Minimal promise-based `browser` mock installed before background.js loads.
function makeBrowser() {
  const local = new Map();
  const session = new Map();
  const area = (m) => ({
    get: async (key) => (m.has(key) ? { [key]: structuredClone(m.get(key)) } : {}),
    set: async (obj) => {
      for (const [k, v] of Object.entries(obj)) m.set(k, structuredClone(v));
    },
  });
  const listeners = { message: [], updated: [], removed: [] };
  const b = {
    _local: local,
    _session: session,
    _listeners: listeners,
    _native: [],
    _nativeReply: null,
    _badges: [],
    runtime: {
      id: "ext-id",
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      sendNativeMessage: async (appId, msg) => {
        b._native.push({ appId, msg });
        if (typeof b._nativeReply === "function") return b._nativeReply(msg);
        return b._nativeReply;
      },
    },
    storage: { local: area(local), session: area(session) },
    action: {
      setBadgeText: async (o) => b._badges.push(o),
      setBadgeBackgroundColor: async () => {},
    },
    tabs: {
      onUpdated: { addListener: (fn) => listeners.updated.push(fn) },
      onRemoved: { addListener: (fn) => listeners.removed.push(fn) },
    },
  };
  return b;
}

const mock = makeBrowser();
globalThis.browser = mock;
const bg = require(path.join(RESOURCES, "background.js"));
const candidates = lib("candidates.js");

const contentSender = (tabId = 7, frameId = 0, url = "https://www.example.com/page", tabUrl = "https://www.example.com/page") => ({
  id: "ext-id",
  tab: { id: tabId, url: tabUrl },
  frameId,
  url,
});
const popupSender = { id: "ext-id", url: "safari-web-extension://x/popup.html" };

function validRequest() {
  const doc = load("banner-fixed.html");
  return candidates.buildRequest(doc.querySelector(".notice-bar"), { frame: "top" }).request;
}

const okReply = { type: "identifyRejectControlResult", version: 1, status: "ok", candidateId: "c2", confidence: "high", reason: "Reject all", engine: "foundation-models" };

beforeEach(() => {
  bg._reset();
  mock._local.clear();
  mock._session.clear();
  mock._native.length = 0;
  mock._badges.length = 0;
  mock._nativeReply = okReply;
});

describe("native reply validation", () => {
  const req = { candidates: [{ id: "c1" }, { id: "c2" }] };

  test("well-formed ok passes through", () => {
    assert.deepEqual(bg.normalizeResult(okReply, req), okReply);
  });

  const malformed = {
    "not an object": "ok",
    "null": null,
    "wrong type": { ...okReply, type: "x" },
    "wrong version": { ...okReply, version: 2 },
    "unknown status": { ...okReply, status: "maybe" },
    "ok without id": { ...okReply, candidateId: null },
    "ok with unknown id": { ...okReply, candidateId: "c5" },
    "ok with malformed id": { ...okReply, candidateId: "c123" },
    "ok without confidence": { ...okReply, confidence: null },
    "bad confidence": { ...okReply, confidence: "very" },
    "non-ok with candidate id": { ...okReply, status: "uncertain" },
  };
  for (const [name, raw] of Object.entries(malformed)) {
    test(`coerces to error: ${name}`, () => {
      const r = bg.normalizeResult(raw, req);
      assert.equal(r.status, "error");
      assert.equal(r.candidateId, null);
      assert.equal(r.type, "identifyRejectControlResult");
    });
  }

  test("non-ok statuses keep their status; reason truncated; engine defaulted", () => {
    const r = bg.normalizeResult({ type: "identifyRejectControlResult", version: 1, status: "unavailable", candidateId: null, confidence: null, reason: "x".repeat(500), engine: "gpt" }, req);
    assert.equal(r.status, "unavailable");
    assert.equal(r.reason.length, 200);
    assert.equal(r.engine, "none");
  });
});

describe("request validation", () => {
  test("accepts a request built by candidates.js", () => assert.ok(bg.validateRequest(validRequest())));
  const bad = {
    "wrong type": (r) => (r.type = "x"),
    "13 candidates": (r) => (r.candidates = Array.from({ length: 13 }, (_, i) => ({ ...r.candidates[0], id: `c${i + 1}` }))),
    "no candidates": (r) => (r.candidates = []),
    "bad id": (r) => (r.candidates[0].id = "x1"),
    "duplicate id": (r) => (r.candidates[1].id = r.candidates[0].id),
    "long text": (r) => (r.candidates[0].text = "x".repeat(81)),
    "non-whitelisted attr": (r) => (r.candidates[0].attrs = { href: "/secret" }),
    "too many attrs": (r) => (r.candidates[0].attrs = { id: "a", class: "b", name: "c", "data-a": "1", "data-b": "2", "data-c": "3", "data-d": "4" }),
    "long container text": (r) => (r.container.text = "x".repeat(601)),
    "bad frame": (r) => (r.page.frame = "iframe"),
  };
  for (const [name, mutate] of Object.entries(bad)) {
    test(`rejects: ${name}`, () => {
      const r = validRequest();
      mutate(r);
      assert.equal(bg.validateRequest(r), false);
    });
  }
});

describe("message router", () => {
  test("classify forwards to native with the app id and returns the validated reply", async () => {
    const reply = await bg.handleMessage({ type: "classify", request: validRequest() }, contentSender());
    assert.deepEqual(reply, okReply);
    assert.equal(mock._native.length, 1);
    assert.equal(mock._native[0].appId, "dev.eyeb0l.cookies.Extension");
    assert.equal(mock._native[0].msg.type, "identifyRejectControl");
  });

  test("classify: malformed native reply becomes error", async () => {
    mock._nativeReply = { echo: "hello" };
    const reply = await bg.handleMessage({ type: "classify", request: validRequest() }, contentSender());
    assert.equal(reply.status, "error");
  });

  test("classify: native failure becomes error", async () => {
    mock._nativeReply = () => Promise.reject(new Error("no handler"));
    const reply = await bg.handleMessage({ type: "classify", request: validRequest() }, contentSender());
    assert.equal(reply.status, "error");
  });

  test("classify: invalid request never reaches native", async () => {
    const reply = await bg.handleMessage({ type: "classify", request: { type: "identifyRejectControl" } }, contentSender());
    assert.equal(reply.status, "error");
    assert.equal(mock._native.length, 0);
  });

  test("classify: refused when disabled globally or for the host", async () => {
    await bg.handleMessage({ type: "setSettings", settings: { enabled: false, disabledHosts: [] } }, popupSender);
    assert.equal((await bg.handleMessage({ type: "classify", request: validRequest() }, contentSender())).status, "error");
    await bg.handleMessage({ type: "setSettings", settings: { enabled: true, disabledHosts: ["example.com"] } }, popupSender);
    assert.equal((await bg.handleMessage({ type: "classify", request: validRequest() }, contentSender())).status, "error");
    assert.equal(mock._native.length, 0);
  });

  test("classify: only from content scripts", async () => {
    const reply = await bg.handleMessage({ type: "classify", request: validRequest() }, popupSender);
    assert.equal(reply.status, "error");
    assert.equal(mock._native.length, 0);
  });

  test("classify: per-tab request cap", async () => {
    for (let i = 0; i < 8; i++) await bg.handleMessage({ type: "classify", request: validRequest() }, contentSender(7, i));
    const reply = await bg.handleMessage({ type: "classify", request: validRequest() }, contentSender(7, 99));
    assert.equal(reply.status, "error");
    assert.equal(mock._native.length, 8);
  });

  test("getSettings: defaults, and pause covers subdomains and iframes", async () => {
    let r = await bg.handleMessage({ type: "getSettings" }, contentSender());
    assert.deepEqual(r.settings, { enabled: true, disabledHosts: [] });
    assert.equal(r.active, true);
    await bg.handleMessage({ type: "setSettings", settings: { enabled: true, disabledHosts: ["example.com"] } }, popupSender);
    r = await bg.handleMessage({ type: "getSettings" }, contentSender(7, 3, "https://cmp.thirdparty.example/frame"));
    assert.equal(r.host, "example.com");
    assert.equal(r.active, false);
  });

  test("setSettings: sanitised; refused from content scripts", async () => {
    const r = await bg.handleMessage({ type: "setSettings", settings: { enabled: "yes", disabledHosts: ["WWW.Example.com", "example.com", 42, "bad host!"] } }, popupSender);
    assert.deepEqual(r.settings, { enabled: true, disabledHosts: ["example.com"] });
    const denied = await bg.handleMessage({ type: "setSettings", settings: { enabled: false } }, contentSender());
    assert.equal(denied.ok, false);
    assert.equal((await bg.handleMessage({ type: "getSettings" }, contentSender())).settings.enabled, true);
  });

  test("status → badge ✓, getStatus aggregates frames, navigation clears", async () => {
    await bg.handleMessage({ type: "getSettings" }, contentSender(7, 0));
    await bg.handleMessage({ type: "status", status: { outcome: "none", layer: null, cmp: null, reason: "" } }, contentSender(7, 0));
    await bg.handleMessage({ type: "status", status: { outcome: "rejected", layer: "rules", cmp: "sourcepoint", reason: "Sourcepoint" } }, contentSender(7, 4));
    assert.deepEqual(mock._badges.at(-1), { tabId: 7, text: "✓" });

    const s = await bg.handleMessage({ type: "getStatus", tabId: 7 }, popupSender);
    assert.equal(s.tab.host, "example.com");
    assert.equal(s.tab.status.outcome, "rejected");
    assert.equal(s.tab.status.cmp, "sourcepoint");

    // Same-host reload (sites often reload after consent is saved): the
    // rejection is carried so the popup doesn't say "No banner found".
    for (const fn of mock._listeners.updated) fn(7, { status: "loading" }, { url: "https://www.example.com/next" });
    await new Promise((r) => setTimeout(r, 10));
    const after = await bg.handleMessage({ type: "getStatus", tabId: 7, url: "https://www.example.com/next" }, popupSender);
    assert.equal(after.tab.status.outcome, "rejected");
    assert.equal(after.tab.status.carried, true);
    assert.equal(after.tab.host, "example.com");
    assert.deepEqual(mock._badges.at(-1), { tabId: 7, text: "✓" });

    // The new document reports "none": the carried rejection still wins …
    await bg.handleMessage({ type: "getSettings" }, contentSender(7, 0, "https://www.example.com/next", "https://www.example.com/next"));
    await bg.handleMessage({ type: "status", status: { outcome: "none", layer: null, cmp: null, reason: "" } }, contentSender(7, 0, "https://www.example.com/next", "https://www.example.com/next"));
    assert.equal((await bg.handleMessage({ type: "getStatus", tabId: 7 }, popupSender)).tab.status.carried, true);
    // … but a fresh real outcome replaces it.
    await bg.handleMessage({ type: "status", status: { outcome: "skipped", layer: "model", cmp: null, reason: "", code: "gate" } }, contentSender(7, 0, "https://www.example.com/next", "https://www.example.com/next"));
    assert.equal((await bg.handleMessage({ type: "getStatus", tabId: 7 }, popupSender)).tab.status.outcome, "skipped");

    // Navigating to another host drops everything.
    await bg.handleMessage({ type: "status", status: { outcome: "rejected", layer: "rules", cmp: "onetrust", reason: "OneTrust" } }, contentSender(7, 0, "https://www.example.com/next", "https://www.example.com/next"));
    for (const fn of mock._listeners.updated) fn(7, { status: "loading" }, { url: "https://other.example/" });
    await new Promise((r) => setTimeout(r, 10));
    const elsewhere = await bg.handleMessage({ type: "getStatus", tabId: 7, url: "https://other.example/" }, popupSender);
    assert.equal(elsewhere.tab.status, null);
    assert.deepEqual(mock._badges.at(-1), { tabId: 7, text: "" });
  });

  test("siteOf approximates the registrable domain", () => {
    assert.equal(bg.siteOf("abonnement.lefigaro.fr"), "lefigaro.fr");
    assert.equal(bg.siteOf("www.lefigaro.fr"), "lefigaro.fr");
    assert.equal(bg.siteOf("news.bbc.co.uk"), "bbc.co.uk");
    assert.equal(bg.siteOf("edition.cnn.com"), "cnn.com");
    assert.equal(bg.siteOf("gov.uk"), "gov.uk");
    assert.equal(bg.siteOf("127.0.0.1"), "127.0.0.1");
    assert.equal(bg.sameSite("abonnement.lefigaro.fr", "www.lefigaro.fr"), true);
    assert.equal(bg.sameSite("lefigaro.fr", "lemonde.fr"), false);
    assert.equal(bg.sameSite("", "lemonde.fr"), false);
  });

  test("a cookie wall that redirects to a subscription subdomain keeps the rejection", async () => {
    await bg.handleMessage({ type: "getSettings" }, contentSender(9, 0, "https://www.lefigaro.fr/", "https://www.lefigaro.fr/"));
    await bg.handleMessage({ type: "status", status: { outcome: "rejected", layer: "rules", cmp: "appconsent", reason: "AppConsent" } }, contentSender(9, 0, "https://www.lefigaro.fr/", "https://www.lefigaro.fr/"));
    for (const fn of mock._listeners.updated) fn(9, { status: "loading" }, { url: "https://abonnement.lefigaro.fr/lefigaro?source=cmp-cookie-wall" });
    await new Promise((r) => setTimeout(r, 10));
    await bg.handleMessage({ type: "getSettings" }, contentSender(9, 0, "https://abonnement.lefigaro.fr/x", "https://abonnement.lefigaro.fr/x"));
    await bg.handleMessage({ type: "status", status: { outcome: "none", layer: null, cmp: null, reason: "" } }, contentSender(9, 0, "https://abonnement.lefigaro.fr/x", "https://abonnement.lefigaro.fr/x"));
    const s = await bg.handleMessage({ type: "getStatus", tabId: 9 }, popupSender);
    assert.equal(s.tab.status.outcome, "rejected");
    assert.equal(s.tab.status.carried, true);
  });

  test("navigation with an unknown destination carries the rejection until a different host reports in", async () => {
    await bg.handleMessage({ type: "getSettings" }, contentSender(8, 0));
    await bg.handleMessage({ type: "status", status: { outcome: "rejected", layer: "model", cmp: null, reason: "Reject all" } }, contentSender(8, 0));
    for (const fn of mock._listeners.updated) fn(8, { status: "loading" }, {});
    await new Promise((r) => setTimeout(r, 10));
    assert.equal((await bg.handleMessage({ type: "getStatus", tabId: 8 }, popupSender)).tab.status.carried, true);
    await bg.handleMessage({ type: "getSettings" }, contentSender(8, 0, "https://other.example/", "https://other.example/"));
    assert.equal((await bg.handleMessage({ type: "getStatus", tabId: 8 }, popupSender)).tab.status, null);
    // Closing the tab never carries.
    await bg.handleMessage({ type: "status", status: { outcome: "rejected", layer: "model", cmp: null, reason: "" } }, contentSender(8, 0, "https://other.example/", "https://other.example/"));
    for (const fn of mock._listeners.removed) fn(8);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal((await bg.handleMessage({ type: "getStatus", tabId: 8 }, popupSender)).tab.status, null);
  });

  test("status: malformed records are ignored", async () => {
    const r = await bg.handleMessage({ type: "status", status: { outcome: "pwned" } }, contentSender());
    assert.equal(r.ok, false);
    const st = bg.sanitizeStatus({ outcome: "skipped", layer: "model", cmp: "<b>", reason: "x".repeat(300), code: "gate" });
    assert.equal(st.cmp, null);
    assert.equal(st.reason.length, 200);
  });

  test("messages from another extension are ignored", async () => {
    const r = await bg.handleMessage({ type: "getSettings" }, { id: "evil", tab: { id: 1, url: "https://x.example/" } });
    assert.equal(r, undefined);
  });

  test("unknown messages are ignored", async () => {
    assert.equal(await bg.handleMessage({ type: "nope" }, contentSender()), undefined);
    assert.equal(await bg.handleMessage("string", contentSender()), undefined);
  });

  test("registered onMessage listener returns a promise", async () => {
    const reply = await mock._listeners.message[0]({ type: "getSettings" }, contentSender());
    assert.equal(reply.active, true);
  });
});
