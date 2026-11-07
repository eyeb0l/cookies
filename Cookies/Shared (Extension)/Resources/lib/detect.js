/*
 * lib/detect.js — Layer 2: find and score a plausible consent container for
 * banners no CMP rule knows about (ARCHITECTURE, "Finding the consent
 * container"). Pure functions over a Document/Element; `options.env` lets
 * tests override visibility and geometry (see lib/dom.js).
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

  const TEXT_MAX = 2000; // visible text considered per container
  const MIN_BUTTONS = 1;
  const MAX_BUTTONS = 12;
  const MIN_Z_INDEX = 10;
  const MIN_WIDTH = 100;
  const MIN_HEIGHT = 30;
  const SCORE_THRESHOLD = 5;
  const SCAN_LIMIT = 3000; // elements examined by the fallback position scan

  // Strong signals: words that essentially only appear in consent notices.
  const STRONG_KEYWORDS = [
    "cookie*", "consent*", "consentement*", "einwilligung*", "consentimiento*", "consenso*", "toestemming*",
    "samtycke*", "samtykke*", "suostumus*", "zgod*", "souhlas*", "gdpr", "dsgvo", "rgpd", "lgpd", "ccpa",
    "we value your privacy", "your privacy choices", "privacy choices", "privacy preferences", "privacy settings",
    "tracking technologies", "similar technologies", "legitimate interest*", "berechtigtes interesse",
    "intérêt légitime", "interés legítimo", "interesse legittimo", "kakor", "informasjonskapsler", "eväste*",
    "süti*", "çerez*", "куки", "файлы cookie", "クッキー", "쿠키", "datenschutzeinstellungen", "privatsphäre-einstellungen",
  ];
  // Weak signals: common in consent notices but also elsewhere.
  const WEAK_KEYWORDS = [
    "privacy", "privacy policy", "datenschutz*", "privacidad", "privacidade", "confidentialité", "vie privée",
    "riservatezza", "privacybeleid", "tracking", "your choices", "personal data", "personenbezogene*",
    "données personnelles", "datos personales", "dati personali", "partners", "partner", "vendors",
    "personalised", "personalized", "personalisierte*", "analytics", "advertising", "werbung", "publicité",
    "publicidad", "pubblicità", "zustimmung", "zustimmen",
  ];
  const STRONG_RE = gate.compileTerms(STRONG_KEYWORDS);
  const WEAK_RE = gate.compileTerms(WEAK_KEYWORDS);

  const HINT_RE = /cookie|consent|gdpr|dsgvo|rgpd|cmp|privacy|tracking/i;
  const SEMANTIC_SELECTOR = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
  const HINT_SELECTOR = [
    '[id*="cookie" i]', '[class*="cookie" i]', '[id*="consent" i]', '[class*="consent" i]', '[id*="gdpr" i]',
    '[class*="gdpr" i]', '[id*="cmp" i]', '[class*="cmp" i]', '[id*="privacy" i]', '[class*="privacy" i]',
    '[aria-label*="cookie" i]', '[aria-label*="consent" i]', '[aria-label*="privacy" i]',
  ].join(",");

  const keywordHits = (text, re) => {
    const global = new RegExp(re.source, "giu");
    const hits = new Set();
    for (const m of text.toLowerCase().matchAll(global)) {
      hits.add(m[0]);
      if (hits.size >= 8) break;
    }
    return hits;
  };

  /** Quick page-level pre-check: does any consent vocabulary appear at all? */
  function pageMayHaveBanner(doc) {
    const body = doc && doc.body;
    if (!body) return false;
    // textContent is a single native call with no layout; cap the scan.
    const text = (body.textContent || "").slice(0, 400000);
    if (STRONG_RE.test(text) || WEAK_RE.test(text)) return true;
    // Banners rendered into a shadow root don't appear in textContent.
    for (const el of body.children) if (el.shadowRoot) return true;
    return false;
  }

  function isPositioned(el) {
    if (el.tagName === "DIALOG") return true;
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (role === "dialog" || role === "alertdialog") return true;
    if (el.getAttribute("aria-modal") === "true") return true;
    const cs = dom.styleOf(el);
    return !!cs && (cs.position === "fixed" || cs.position === "sticky");
  }

  function isTopLevelChild(el) {
    const doc = el.ownerDocument;
    let parent = dom.parentOrHost(el);
    // A top-level element of a shadow root counts as a child of its host's parent.
    if (parent && el.parentNode && el.parentNode.host === parent) parent = dom.parentOrHost(parent);
    if (!parent) return true;
    return parent === doc.body || parent === doc.documentElement;
  }

  /** z-index ≥ 10 on the element or an ancestor, a top-level child, or a modal <dialog>. */
  function hasHighStacking(el) {
    if (el.tagName === "DIALOG" && el.hasAttribute("open")) return true;
    if (isTopLevelChild(el)) return true;
    const doc = el.ownerDocument;
    for (let n = el; n && n !== doc.body && n !== doc.documentElement; n = dom.parentOrHost(n)) {
      const cs = dom.styleOf(n);
      const z = cs ? parseInt(cs.zIndex, 10) : NaN;
      if (!Number.isNaN(z) && z >= MIN_Z_INDEX) return true;
    }
    return false;
  }

  const qs = (root, selector) => {
    try {
      return dom.querySelectorAllDeep(root, selector, { limit: 50 });
    } catch {
      return [];
    }
  };

  /**
   * Structural exclusions: anything that looks like login, payment, sign-up,
   * a real form or an upload is never a consent banner we will touch.
   */
  function exclusionReason(el) {
    if (qs(el, 'input[type="password" i]').length) return "password-field";
    if (qs(el, '[autocomplete^="cc-" i]').length) return "payment-field";
    if (qs(el, 'input[type="file" i]').length) return "file-input";
    if (qs(el, 'input[type="email" i]').length) {
      const submit = qs(el, 'button:not([type]), button[type="submit" i], input[type="submit" i], form');
      if (submit.length) return "email-with-submit";
    }
    const textInputs =
      'input:not([type]), input[type="text" i], input[type="email" i], input[type="tel" i], input[type="search" i], input[type="url" i], input[type="number" i], textarea';
    for (const form of qs(el, "form")) {
      if ((form.getAttribute("method") || "").toLowerCase() === "post" && qs(form, textInputs).length) return "post-form";
    }
    // The container itself may sit inside a POST form.
    const outerForm = el.closest && el.closest('form[method="post" i]');
    if (outerForm && qs(el, textInputs).length) return "post-form";
    return null;
  }

  function hintOf(el) {
    const cls = typeof el.className === "string" ? el.className : el.getAttribute("class") || "";
    return `${el.id || ""} ${cls} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("aria-labelledby") || ""}`;
  }

  /**
   * Evaluate one element as a consent container.
   * @returns {{ eligible: boolean, score: number, reason?: string, text?: string, buttons?: Element[] }}
   */
  function evaluateContainer(el, options = {}) {
    const env = options.env;
    const fail = (reason) => ({ eligible: false, score: 0, reason });
    if (!el || el.nodeType !== 1) return fail("not-element");
    const doc = el.ownerDocument;
    if (el === doc.body || el === doc.documentElement) return fail("root");
    if (!isPositioned(el)) return fail("not-positioned");
    if (!dom.isVisible(el, env)) return fail("hidden");
    const rect = dom.rectOf(el, env);
    if (rect && (rect.width < MIN_WIDTH || rect.height < MIN_HEIGHT)) return fail("too-small");
    if (!hasHighStacking(el)) return fail("low-stacking");

    const text = dom.visibleText(el, { max: TEXT_MAX, env });
    const strong = keywordHits(text, STRONG_RE);
    const weak = keywordHits(text, WEAK_RE);
    if (!strong.size && !weak.size) return fail("no-keyword");

    const excluded = exclusionReason(el);
    if (excluded) return fail(excluded);

    const buttons = dom.collectButtonLike(el, env, { limit: MAX_BUTTONS + 1 });
    if (buttons.length < MIN_BUTTONS) return fail("no-buttons");
    if (buttons.length > MAX_BUTTONS) return fail("too-many-buttons");

    let score = Math.min(strong.size, 2) * 3 + Math.min(weak.size, 3);
    let hasReject = false;
    let hasAccept = false;
    for (const b of buttons) {
      const { text: t, aria } = dom.labelOf(b, env);
      if (gate.isRejectLabel(t, aria)) hasReject = true;
      else if (gate.matchesAccept(`${t} ${aria}`)) hasAccept = true;
    }
    if (hasReject) score += 2;
    if (hasAccept) score += 1;
    if (HINT_RE.test(hintOf(el))) score += 2;
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (el.tagName === "DIALOG" || role === "dialog" || role === "alertdialog" || el.getAttribute("aria-modal") === "true") score += 1;
    if (text.length >= TEXT_MAX) score -= 2; // likely a whole page/app shell, not a notice

    return { eligible: true, score, text, buttons, hasReject, hasAccept };
  }

  /** Nearest positioned ancestor (inclusive), crossing shadow boundaries. */
  function positionedAncestor(el, maxDepth = 15) {
    const doc = el.ownerDocument;
    let depth = 0;
    for (let n = el; n && depth < maxDepth; n = dom.parentOrHost(n), depth++) {
      if (n === doc.body || n === doc.documentElement) return null;
      if (isPositioned(n)) return n;
    }
    return null;
  }

  /** Gather elements worth evaluating, cheapest sources first. */
  function candidatePool(doc, { scan = true } = {}) {
    const pool = new Set();
    const add = (el) => {
      const p = el && positionedAncestor(el);
      if (p) pool.add(p);
    };
    const body = doc.body;
    if (!body) return [];
    const roots = [doc];
    for (const child of body.children) if (child.shadowRoot) roots.push(child.shadowRoot);
    for (const root of roots) {
      for (const el of root.querySelectorAll(SEMANTIC_SELECTOR)) pool.add(el);
      for (const el of root.querySelectorAll(HINT_SELECTOR)) add(el);
    }
    for (const child of body.children) {
      add(child);
      for (const grandchild of child.children) add(grandchild);
    }
    if (scan) {
      // Bounded fallback for fixed/sticky banners with no semantic or naming hints.
      const all = body.getElementsByTagName("*");
      const n = Math.min(all.length, SCAN_LIMIT);
      for (let i = 0; i < n; i++) {
        const el = all[i];
        const cs = dom.styleOf(el);
        if (cs && (cs.position === "fixed" || cs.position === "sticky")) pool.add(el);
      }
    }
    return Array.from(pool);
  }

  /** All eligible containers, best first. */
  function findConsentContainers(doc, options = {}) {
    const evaluate = (pool) => {
      const out = [];
      for (const el of pool) {
        const r = evaluateContainer(el, options);
        if (r.eligible && r.score >= SCORE_THRESHOLD) out.push({ element: el, ...r });
      }
      return out;
    };
    let results = evaluate(candidatePool(doc, { scan: false }));
    // Only pay for the full position scan when the cheap sources found nothing.
    if (!results.length && options.scan !== false) results = evaluate(candidatePool(doc, { scan: true }));
    // Prefer higher scores; on ties prefer the innermost (most specific) element.
    results.sort((a, b) => b.score - a.score || (dom.containsDeep(a.element, b.element) ? 1 : dom.containsDeep(b.element, a.element) ? -1 : 0));
    return results;
  }

  /** Best container or null when nothing clears the threshold. */
  function findBestContainer(doc, options = {}) {
    if (!options.skipPrecheck && !pageMayHaveBanner(doc)) return null;
    return findConsentContainers(doc, options)[0] || null;
  }

  const api = Object.freeze({
    TEXT_MAX,
    MAX_BUTTONS,
    SCORE_THRESHOLD,
    STRONG_KEYWORDS: Object.freeze(STRONG_KEYWORDS.slice()),
    WEAK_KEYWORDS: Object.freeze(WEAK_KEYWORDS.slice()),
    pageMayHaveBanner,
    isPositioned,
    hasHighStacking,
    exclusionReason,
    evaluateContainer,
    candidatePool,
    findConsentContainers,
    findBestContainer,
  });

  NS.detect = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
