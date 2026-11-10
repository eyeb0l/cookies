/*
 * lib/candidates.js - build the minimal `identifyRejectControl` payload for
 * the native handler (ARCHITECTURE, "Candidate controls" and "Message:
 * extension -> native"). Only short labels and a whitelisted handful of
 * attributes leave the page; element references stay in a Map that lives for
 * this one request.
 */
"use strict";

(() => {
  const NS = (() => {
    if (globalThis.__cookies) return globalThis.__cookies;
    const ns = {};
    try {
      Object.defineProperty(globalThis, "__cookies", { value: ns, configurable: true, writable: false, enumerable: false });
    } catch {
      globalThis.__cookies = ns;
    }
    return ns;
  })();
  const node = typeof require === "function";
  const dom = node ? require("./dom.js") : NS.dom;
  const gate = node ? require("./gate.js") : NS.gate;

  const LIMITS = Object.freeze({
    candidates: 12,
    text: 80,
    aria: 80,
    attrValue: 60,
    attrCount: 6,
    containerText: 600,
    host: 253,
    lang: 35,
  });

  /** id, class, name and data-* only; values <= 60 chars; at most 6. */
  function pickAttrs(el) {
    const attrs = {};
    let count = 0;
    const put = (key, value) => {
      if (count >= LIMITS.attrCount || value == null) return;
      const v = dom.truncate(dom.normalizeText(value), LIMITS.attrValue);
      if (!v) return;
      attrs[key] = v;
      count++;
    };
    put("id", el.getAttribute("id"));
    put("class", el.getAttribute("class"));
    put("name", el.getAttribute("name"));
    for (const attr of Array.from(el.attributes)) {
      if (count >= LIMITS.attrCount) break;
      const key = attr.name.toLowerCase();
      if (!key.startsWith("data-") || key.length > LIMITS.attrValue || key in attrs) continue;
      put(key, attr.value);
    }
    return attrs;
  }

  function sanitizeLang(value) {
    const s = String(value || "").trim();
    return /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(s) ? s.slice(0, LIMITS.lang) : "";
  }

  /**
   * @param container consent container element (from lib/detect.js)
   * @param options   { env, host, lang, frame: "top" | "sub" }
   * @returns {{ request, map: Map<string, Element>, snapshot: Map<string, {text, aria}> }
   *         | { request: null, map: null, snapshot: null, reason: string }}
   */
  function buildRequest(container, options = {}) {
    const env = options.env;
    const abort = (reason) => ({ request: null, map: null, snapshot: null, reason });
    if (!container || container.nodeType !== 1) return abort("no-container");

    const controls = dom.collectButtonLike(container, env, { limit: LIMITS.candidates + 1 });
    if (!controls.length) return abort("no-controls");
    // Fail closed: a container with more than 12 controls is not a simple
    // notice (or is trying to dilute the choice); skip Layer 2 entirely.
    if (controls.length > LIMITS.candidates) return abort("too-many-controls");

    const kept = [];
    for (const el of controls) {
      const label = dom.labelOf(el, env);
      // Dangerous controls are never even shown to the model.
      if (gate.matchesDanger(label.text) || gate.matchesDanger(label.aria)) continue;
      kept.push({ el, label });
    }
    if (!kept.length) return abort("only-dangerous-controls");
    // The gate only ever clicks a reject-labelled control; if there is none,
    // asking the model can't lead to a click, so don't send page text at all.
    if (!kept.some(({ label }) => gate.isRejectLabel(label.text, label.aria))) return abort("no-reject-control");

    const map = new Map();
    const snapshot = new Map();
    const candidates = kept.map(({ el, label }, i) => {
      const id = `c${i + 1}`;
      map.set(id, el);
      snapshot.set(id, { text: label.text, aria: label.aria });
      return {
        id,
        tag: el.tagName.toLowerCase(),
        text: dom.truncate(label.text, LIMITS.text),
        aria: dom.truncate(label.aria, LIMITS.aria),
        attrs: pickAttrs(el),
        role: dom.truncate((el.getAttribute("role") || "").toLowerCase(), 20),
        disabled: dom.isDisabled(el),
      };
    });

    const doc = container.ownerDocument;
    const request = {
      type: "identifyRejectControl",
      version: 1,
      page: {
        host: dom.truncate(String(options.host ?? (doc.location && doc.location.hostname) ?? "").toLowerCase(), LIMITS.host),
        lang: sanitizeLang(options.lang ?? (doc.documentElement && doc.documentElement.getAttribute("lang"))),
        frame: options.frame === "sub" ? "sub" : "top",
      },
      container: {
        tag: container.tagName.toLowerCase(),
        role: dom.truncate((container.getAttribute("role") || "").toLowerCase(), 20),
        text: dom.visibleText(container, { max: LIMITS.containerText, env }),
        attrs: pickAttrs(container),
      },
      candidates,
    };
    return { request, map, snapshot };
  }

  const api = Object.freeze({ LIMITS, pickAttrs, sanitizeLang, buildRequest });
  NS.candidates = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
