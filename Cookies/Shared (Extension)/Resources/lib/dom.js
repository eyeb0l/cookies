/*
 * lib/dom.js — DOM helpers shared by the content-script modules.
 *
 * Everything here is read-only with respect to the page: no element is
 * created, mutated or styled. Functions accept an optional `env` object so
 * unit tests (jsdom, which has no layout engine) can override visibility and
 * geometry:
 *
 *   env.isVisible(el) -> boolean   replaces the whole visibility heuristic
 *   env.rect(el)      -> {left, top, right, bottom, width, height} | null
 */
"use strict";

(() => {
  const NS = (() => {
    if (globalThis.__cookies) return globalThis.__cookies;
    const ns = {};
    try {
      // Non-enumerable so it does not show up when something iterates globals.
      Object.defineProperty(globalThis, "__cookies", { value: ns, configurable: true, writable: false, enumerable: false });
    } catch {
      globalThis.__cookies = ns;
    }
    return ns;
  })();

  const ELEMENT_NODE = 1;
  const TEXT_NODE = 3;
  const DOCUMENT_FRAGMENT_NODE = 11;

  const SKIP_TEXT_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "OBJECT", "EMBED", "CANVAS", "VIDEO", "AUDIO", "HEAD", "META", "LINK"]);
  const MAX_TEXT_NODES_VISITED = 6000;

  /** Collapse whitespace, strip invisible characters, normalise quotes. */
  function normalizeText(value) {
    if (value == null) return "";
    return String(value)
      .normalize("NFKC")
      .replace(/[­​-‍⁠﻿]/g, "")
      .replace(/[‘’ʼ`´]/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Truncate by code points (never splits a surrogate pair). */
  function truncate(value, max) {
    const s = String(value ?? "");
    if (s.length <= max) return s;
    const chars = Array.from(s);
    return chars.length <= max ? s : chars.slice(0, max).join("");
  }

  function windowOf(node) {
    const doc = node && (node.nodeType === 9 ? node : node.ownerDocument);
    return (doc && doc.defaultView) || null;
  }

  function styleOf(el) {
    try {
      const win = windowOf(el);
      return win ? win.getComputedStyle(el) : null;
    } catch {
      return null;
    }
  }

  /** Parent element, crossing shadow-root boundaries to the host. */
  function parentOrHost(node) {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    const parent = node.parentNode;
    if (parent && parent.nodeType === DOCUMENT_FRAGMENT_NODE && parent.host) return parent.host;
    return null;
  }

  /** `ancestor.contains(node)` that also follows shadow hosts upwards. */
  function containsDeep(ancestor, node) {
    for (let n = node; n; n = parentOrHost(n)) {
      if (n === ancestor) return true;
    }
    return false;
  }

  // jsdom (and some detached documents) report all-zero rects. Detect that so
  // geometry checks degrade to "unknown" rather than "invisible".
  const layoutCache = new WeakMap();
  function hasLayout(doc) {
    if (!doc || !doc.documentElement) return false;
    if (layoutCache.has(doc)) return layoutCache.get(doc);
    let result = false;
    try {
      const r = doc.documentElement.getBoundingClientRect();
      result = r.width > 0 || r.height > 0;
    } catch {
      result = false;
    }
    // Only cache positive answers: a real document may be laid out later.
    if (result) layoutCache.set(doc, true);
    return result;
  }

  /** Element rect, or null when geometry is unavailable. */
  function rectOf(el, env) {
    if (env && typeof env.rect === "function") return env.rect(el) || null;
    if (!el || typeof el.getBoundingClientRect !== "function") return null;
    if (!hasLayout(el.ownerDocument)) return null;
    try {
      return el.getBoundingClientRect();
    } catch {
      return null;
    }
  }

  function isOffscreen(rect, win) {
    if (!rect || !win) return false;
    const scrollX = win.scrollX || 0;
    const scrollY = win.scrollY || 0;
    const doc = win.document;
    const docWidth = Math.max(win.innerWidth || 0, (doc && doc.documentElement && doc.documentElement.scrollWidth) || 0);
    // Left of / above the document origin is unreachable; far right is the
    // classic `left: -9999px` / `left: 9999px` hiding trick.
    if (rect.right + scrollX <= 0 || rect.bottom + scrollY <= 0) return true;
    if (docWidth > 0 && rect.left + scrollX >= docWidth) return true;
    return false;
  }

  /**
   * Is the element rendered and perceivable? Fails closed: aria-hidden,
   * opacity 0, zero size and off-screen positioning all count as hidden so we
   * never act on a control the user cannot see.
   */
  function isVisible(el, env) {
    if (env && typeof env.isVisible === "function") return !!env.isVisible(el);
    if (!el || el.nodeType !== ELEMENT_NODE || !el.isConnected) return false;
    for (let n = el; n; n = parentOrHost(n)) {
      if (n.hasAttribute("hidden")) return false;
      if (n.getAttribute("aria-hidden") === "true") return false;
      if (n.tagName === "DIALOG" && !n.hasAttribute("open")) return false;
      const cs = styleOf(n);
      if (!cs) continue;
      if (cs.display === "none") return false;
      if (n === el && (cs.visibility === "hidden" || cs.visibility === "collapse")) return false;
      const opacity = parseFloat(cs.opacity);
      if (!Number.isNaN(opacity) && opacity <= 0.01) return false;
    }
    const rect = rectOf(el, env);
    if (rect) {
      const cs = styleOf(el);
      if (!(cs && cs.display === "contents")) {
        if (rect.width <= 1 || rect.height <= 1) return false;
        if (isOffscreen(rect, windowOf(el))) return false;
      }
    }
    return true;
  }

  /**
   * Visible text of a subtree (including open shadow roots and slotted
   * content), whitespace-collapsed and capped at `max` characters.
   */
  function visibleText(root, options = {}) {
    const max = options.max ?? 2000;
    const env = options.env;
    if (!root) return "";
    const parts = [];
    let length = 0;
    let visited = 0;
    const withLayout = !!(env && env.rect) || hasLayout(root.ownerDocument || root);

    const push = (s) => {
      if (!s) return;
      parts.push(s);
      length += s.length + 1;
    };

    const elementHidden = (el) => {
      if (SKIP_TEXT_TAGS.has(el.tagName)) return true;
      if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return true;
      if (el.tagName === "DIALOG" && !el.hasAttribute("open")) return true;
      if (env && typeof env.isVisible === "function" && !env.isVisible(el)) return true;
      return false;
    };

    const walk = (node, inheritedHidden) => {
      if (length >= max || visited > MAX_TEXT_NODES_VISITED) return;
      visited++;
      if (node.nodeType === TEXT_NODE) {
        if (!inheritedHidden) push(node.nodeValue.replace(/\s+/g, " ").trim());
        return;
      }
      if (node.nodeType === DOCUMENT_FRAGMENT_NODE) {
        for (const child of node.childNodes) walk(child, inheritedHidden);
        return;
      }
      if (node.nodeType !== ELEMENT_NODE) return;
      const el = node;
      if (elementHidden(el)) return;
      const cs = styleOf(el);
      let hiddenHere = inheritedHidden;
      if (cs) {
        if (cs.display === "none") return;
        const opacity = parseFloat(cs.opacity);
        if (!Number.isNaN(opacity) && opacity <= 0.01) return;
        // visibility is inherited but can be re-enabled by a descendant.
        hiddenHere = cs.visibility === "hidden" || cs.visibility === "collapse";
        if (withLayout && (cs.position === "absolute" || cs.position === "fixed")) {
          const r = rectOf(el, env);
          if (r && ((r.width <= 1 && r.height <= 1) || isOffscreen(r, windowOf(el)))) return;
        }
      }
      if (el.tagName === "INPUT") {
        const type = (el.getAttribute("type") || "").toLowerCase();
        if (!hiddenHere && (type === "button" || type === "submit" || type === "reset")) push(normalizeText(el.value));
        return;
      }
      if (el.tagName === "SLOT" && typeof el.assignedNodes === "function") {
        const assigned = el.assignedNodes({ flatten: true });
        if (assigned.length) {
          for (const child of assigned) walk(child, hiddenHere);
          return;
        }
      }
      if (el.shadowRoot) {
        walk(el.shadowRoot, hiddenHere);
        return;
      }
      for (const child of el.childNodes) walk(child, hiddenHere);
    };

    walk(root, false);
    return truncate(normalizeText(parts.join(" ")), max);
  }

  /** The control's own label: visible text plus aria-label/title. */
  function labelOf(el, env) {
    if (!el) return { text: "", aria: "" };
    let text;
    if (el.tagName === "INPUT") text = normalizeText(el.value || "");
    else text = visibleText(el, { max: 200, env });
    const aria = normalizeText(el.getAttribute("aria-label") || el.getAttribute("title") || "");
    return { text, aria };
  }

  /**
   * querySelectorAll across `root` and every open shadow root beneath it,
   * returned in tree order (shadow content at its host's position).
   */
  function querySelectorAllDeep(root, selector, options = {}) {
    const limit = options.limit ?? 5000;
    const out = [];
    const seen = new Set();
    let budget = options.nodeBudget ?? 20000;
    const visit = (scope) => {
      let matches;
      try {
        matches = scope.querySelectorAll(selector);
      } catch {
        return;
      }
      for (const m of matches) {
        if (!seen.has(m)) {
          seen.add(m);
          out.push(m);
        }
      }
      // Find shadow hosts inside this scope.
      const all = scope.querySelectorAll("*");
      for (const el of all) {
        if (--budget <= 0 || out.length >= limit) return;
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    if (root && root.shadowRoot && root.nodeType === ELEMENT_NODE) {
      try {
        if (root.matches(selector)) {
          seen.add(root);
          out.push(root);
        }
      } catch {
        /* invalid selector */
      }
      visit(root);
      visit(root.shadowRoot);
    } else if (root) {
      visit(root);
    }
    // Restore document order when shadow results were appended after light ones.
    return sortInTreeOrder(out).slice(0, limit);
  }

  /** Stable tree-order sort that understands shadow trees. */
  function sortInTreeOrder(elements) {
    if (elements.length < 2) return elements;
    const path = (el) => {
      const chain = [];
      for (let n = el; n; n = parentOrHost(n)) chain.unshift(n);
      return chain;
    };
    const indexIn = (parentNode, child) => {
      const scope = parentNode.shadowRoot && child.getRootNode() === parentNode.shadowRoot ? parentNode.shadowRoot : parentNode;
      return { shadow: scope !== parentNode, index: Array.prototype.indexOf.call(scope.childNodes, child) };
    };
    const paths = new Map(elements.map((e) => [e, path(e)]));
    return elements.slice().sort((a, b) => {
      const pa = paths.get(a);
      const pb = paths.get(b);
      let i = 0;
      while (i < pa.length && i < pb.length && pa[i] === pb[i]) i++;
      if (i === pa.length) return -1; // a is an ancestor of b
      if (i === pb.length) return 1;
      const parentNode = pa[i - 1];
      if (!parentNode) return 0;
      const ia = indexIn(parentNode, pa[i]);
      const ib = indexIn(parentNode, pb[i]);
      // Shadow content renders in place of light children; order shadow first.
      if (ia.shadow !== ib.shadow) return ia.shadow ? -1 : 1;
      return ia.index - ib.index;
    });
  }

  function isDisabled(el) {
    if (!el) return true;
    if (el.disabled === true) return true;
    if (el.getAttribute("aria-disabled") === "true") return true;
    try {
      if (el.closest && el.closest("fieldset[disabled]")) return true;
    } catch {
      /* ignore */
    }
    return false;
  }

  /**
   * True when the anchor would not navigate away from this document: no href,
   * empty, a fragment, `javascript:`, or the same URL apart from the hash.
   */
  function isSameDocumentLink(a) {
    if (!a || a.tagName !== "A") return false;
    if (!a.hasAttribute("href")) return true;
    const raw = (a.getAttribute("href") || "").trim();
    if (raw === "" || raw.startsWith("#")) return true;
    if (/^javascript:/i.test(raw)) return true;
    try {
      const doc = a.ownerDocument;
      const target = new URL(raw, doc.baseURI);
      const here = new URL(doc.URL);
      return target.origin === here.origin && target.pathname === here.pathname && target.search === here.search;
    } catch {
      return false;
    }
  }

  const CLICKABLE_HINT = /btn|button|cta/i;

  /** Button-like controls per ARCHITECTURE ("Candidate controls"). */
  function isButtonLike(el) {
    if (!el || el.nodeType !== ELEMENT_NODE) return false;
    const tag = el.tagName;
    if (tag === "BUTTON") return true;
    if (tag === "INPUT") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      return type === "button" || type === "submit";
    }
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (role === "button") return true;
    if (tag === "A") return isSameDocumentLink(el);
    if (el.hasAttribute("onclick") || el.getAttribute("tabindex") === "0") {
      // Only count elements that look clickable, not every focusable region.
      const cs = styleOf(el);
      if (cs && cs.cursor === "pointer") return true;
      const hint = `${el.id || ""} ${typeof el.className === "string" ? el.className : ""}`;
      if (CLICKABLE_HINT.test(hint)) return true;
      const text = normalizeText(el.textContent || "");
      return text.length > 0 && text.length <= 40 && el.children.length <= 2;
    }
    return false;
  }

  /**
   * Visible button-like controls inside `container` in document order,
   * searching open shadow roots. Nested button-likes inside an already
   * collected control are skipped (the outer control is what gets clicked).
   */
  function collectButtonLike(container, env, options = {}) {
    const limit = options.limit ?? 200;
    const out = [];
    const walk = (node) => {
      if (out.length >= limit) return;
      if (node.nodeType === ELEMENT_NODE) {
        const el = node;
        if (SKIP_TEXT_TAGS.has(el.tagName)) return;
        if (el !== container && isButtonLike(el)) {
          if (isVisible(el, env)) out.push(el);
          return;
        }
        if (el.shadowRoot) walk(el.shadowRoot);
      }
      for (const child of node.childNodes) {
        if (child.nodeType === ELEMENT_NODE || child.nodeType === DOCUMENT_FRAGMENT_NODE) walk(child);
      }
    };
    walk(container);
    return out;
  }

  const api = Object.freeze({
    normalizeText,
    truncate,
    parentOrHost,
    containsDeep,
    hasLayout,
    rectOf,
    styleOf,
    isVisible,
    visibleText,
    labelOf,
    querySelectorAllDeep,
    sortInTreeOrder,
    isDisabled,
    isSameDocumentLink,
    isButtonLike,
    collectButtonLike,
  });

  NS.dom = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
