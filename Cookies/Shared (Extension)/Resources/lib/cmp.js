/*
 * lib/cmp.js — generic Layer 1 engine. Knows nothing about specific CMPs;
 * everything CMP-specific is data in lib/rules.js.
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
  const defaultRules = () => (node ? require("./rules.js") : NS.rules).rules;

  const POLL_MS = 100;
  const WAIT_MAX_MS = 2000; // ARCHITECTURE: steps poll for at most 2 s

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function entryOf(entry) {
    return typeof entry === "string" ? { selector: entry, text: null, host: null } : { selector: entry.selector, text: entry.text ?? null, host: entry.host ?? null };
  }

  function safeQueryAll(scope, selector) {
    try {
      return Array.from(scope.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  /** Roots to search for an entry: document (+ rule shadow roots), or one host's shadow root. */
  function rootsFor(doc, rule, entry) {
    const shadowRootsOf = (hostSelector) => safeQueryAll(doc, hostSelector).map((h) => h.shadowRoot).filter(Boolean);
    if (entry.host) return shadowRootsOf(entry.host);
    const roots = [doc];
    for (const host of rule.shadow || []) roots.push(...shadowRootsOf(host));
    return roots;
  }

  function queryEntry(doc, rule, raw) {
    const entry = entryOf(raw);
    const out = [];
    for (const root of rootsFor(doc, rule, entry)) out.push(...safeQueryAll(root, entry.selector));
    return { entry, elements: out };
  }

  function anyExists(doc, rule, entries) {
    return (entries || []).some((raw) => queryEntry(doc, rule, raw).elements.length > 0);
  }

  function anyVisible(doc, rule, entries, env) {
    return (entries || []).some((raw) => queryEntry(doc, rule, raw).elements.some((el) => dom.isVisible(el, env)));
  }

  function labelPasses(el, entry, role, env) {
    const { text, aria } = dom.labelOf(el, env);
    if (entry.text === "reject" && !gate.isRejectLabel(text, aria)) return false;
    if (entry.text instanceof RegExp && !entry.text.test(`${text} ${aria}`)) return false;
    const both = `${text} ${aria}`;
    // Defence in depth against a wrong or stale selector: never click a
    // control whose label reads as "accept", or anything on the danger list.
    if (gate.matchesDanger(both)) return false;
    if (role === "final" && gate.isAcceptOnlyLabel(text, aria)) return false;
    if (role === "intermediate" && gate.matchesAccept(both) && !gate.matchesReject(both)) return false;
    return true;
  }

  /** First visible, enabled element matching any entry (entries in priority order). */
  function firstClickable(doc, rule, entries, env, role = "final") {
    for (const raw of entries || []) {
      const { entry, elements } = queryEntry(doc, rule, raw);
      for (const el of elements) {
        if (!dom.isVisible(el, env) || dom.isDisabled(el)) continue;
        if (!labelPasses(el, entry, role, env)) continue;
        return el;
      }
    }
    return null;
  }

  function ruleAppliesToFrame(rule, isTop) {
    return (rule.frames || "any") === "any" || (rule.frames === "top" && isTop);
  }

  /** Index of the step whose click is the actual reject (last non-optional click). */
  function finalStepIndex(steps) {
    for (let i = steps.length - 1; i >= 0; i--) if (!steps[i].optional && steps[i].click) return i;
    return -1;
  }

  /**
   * Find what Layer 1 can do right now. Synchronous and cheap: a few
   * querySelector calls per rule.
   *
   * @returns {null | { rule, kind: "reject", element } | { rule, kind: "steps" } | { rule, kind: "detected" }}
   */
  function findAction(doc, options = {}) {
    const rules = options.rules || defaultRules();
    const isTop = options.isTop ?? true;
    const env = options.env;
    const attempted = options.attempted || new Set();
    let detected = null;
    for (const rule of rules) {
      if (!ruleAppliesToFrame(rule, isTop)) continue;
      if (!anyExists(doc, rule, rule.detect)) continue;
      const element = firstClickable(doc, rule, rule.reject, env, "final");
      if (element) return { rule, kind: "reject", element };
      if (rule.steps && rule.steps.length && !attempted.has(rule.id) && anyVisible(doc, rule, rule.banner || rule.detect, env)) {
        const last = rule.steps[finalStepIndex(rule.steps)];
        const probeOk = !rule.probe || (last && anyExists(doc, rule, last.click));
        const firstOk = !!firstClickable(doc, rule, rule.steps[0].click, env, finalStepIndex(rule.steps) === 0 ? "final" : "intermediate");
        if (probeOk && firstOk) return { rule, kind: "steps" };
      }
      if (!detected) detected = { rule, kind: "detected" };
    }
    return detected;
  }

  async function waitFor(fn, timeout = WAIT_MAX_MS, poll = POLL_MS) {
    const deadline = Date.now() + Math.min(timeout, WAIT_MAX_MS);
    for (;;) {
      const value = fn();
      if (value) return value;
      if (Date.now() >= deadline) return null;
      await sleep(poll);
    }
  }

  /**
   * Run a rule's multi-step flow. `beforeClick` (async, optional) is called
   * before every click and may veto it (e.g. the user just disabled us).
   *
   * @returns {Promise<{ ok: boolean, element?: Element, reason?: string }>}
   */
  async function runSteps(doc, rule, options = {}) {
    const env = options.env;
    const steps = rule.steps || [];
    const finalIdx = finalStepIndex(steps);
    const timeout = options.timeout ?? WAIT_MAX_MS;
    let finalElement = null;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const role = i === finalIdx ? "final" : "intermediate";
      if (step.click) {
        const el = await waitFor(() => firstClickable(doc, rule, step.click, env, role), i === 0 ? 0 : timeout, options.poll);
        if (!el) {
          if (step.optional) continue;
          return { ok: false, reason: `step ${i + 1} target not found`, element: finalElement };
        }
        if (options.beforeClick && !(await options.beforeClick(el))) return { ok: false, reason: "vetoed", element: finalElement };
        el.click();
        if (i === finalIdx) finalElement = el;
      }
      if (step.waitFor) {
        const found = await waitFor(() => anyVisible(doc, rule, step.waitFor, env), timeout, options.poll);
        if (!found && !step.optional) return { ok: false, reason: `step ${i + 1} did not appear`, element: finalElement };
      }
    }
    return finalElement ? { ok: true, element: finalElement } : { ok: false, reason: "no final click" };
  }

  /** The element whose disappearance shows the banner was dismissed. */
  function bannerElementFor(rule, element) {
    const selectors = [...(rule.banner || []), ...(rule.detect || [])].map((e) => entryOf(e).selector);
    for (let n = element; n; n = dom.parentOrHost(n)) {
      for (const sel of selectors) {
        try {
          if (n.matches && n.matches(sel)) return n;
        } catch {
          /* ignore invalid selectors */
        }
      }
    }
    // Shadow-hosted banners: the host itself.
    const rootHost = element && element.getRootNode && element.getRootNode().host;
    return rootHost || element;
  }

  const api = Object.freeze({
    POLL_MS,
    WAIT_MAX_MS,
    entryOf,
    queryEntry,
    anyExists,
    anyVisible,
    firstClickable,
    findAction,
    runSteps,
    waitFor,
    bannerElementFor,
    ruleAppliesToFrame,
    finalStepIndex,
  });

  NS.cmp = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
