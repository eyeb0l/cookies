/*
 * lib/dom.js - DOM helpers shared by the content-script modules.
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
      .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, "")
      .replace(/[\u2018\u2019\u02bc`\u00b4]/g, "'")
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

  /**
   * Same-origin frame with no document of its own (`srcdoc`, or `about:blank`
   * drawn by the parent's scripts). Content scripts may not be injected into
   * such frames, so the parent treats them as part of its own tree.
   */
  function isInlineFrame(el) {
    if (!el || el.tagName !== "IFRAME") return false;
    if (el.hasAttribute("srcdoc")) return true;
    const src = (el.getAttribute("src") || "").trim();
    return src === "" || /^about:blank/i.test(src);
  }

  /** The inline frame's document when it is accessible and has a body, else null. */
  function frameDocumentOf(el) {
    if (!isInlineFrame(el)) return null;
    try {
      const doc = el.contentDocument;
      return doc && doc.body ? doc : null;
    } catch {
      return null;
    }
  }

  /** Inline-frame documents under `doc` (one level deep, bounded). */
  function inlineFrameDocuments(doc, limit = 10) {
    const out = [];
    let frames;
    try {
      frames = doc.querySelectorAll("iframe");
    } catch {
      return out;
    }
    for (const f of frames) {
      const fd = frameDocumentOf(f);
      if (fd) out.push(fd);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Parent in the composed (rendered) tree: a slotted node's parent is its
   * <slot>, otherwise the DOM parent or shadow host; the root of an inline
   * frame's document continues at the <iframe> element.
   */
  function composedParent(node) {
    if (!node) return null;
    if (node.assignedSlot) return node.assignedSlot;
    const parent = parentOrHost(node);
    if (parent) return parent;
    const doc = node.parentNode;
    if (doc && doc.nodeType === 9) {
      try {
        const frame = doc.defaultView && doc.defaultView.frameElement;
        if (frame && isInlineFrame(frame)) return frame;
      } catch {
        /* cross-origin parent: stop here */
      }
    }
    return null;
  }

  /**
   * True when a light-DOM child of a shadow host is not assigned to any slot:
   * it is not rendered at all. (Closed roots report no shadowRoot, so this
   * never misfires for them.)
   */
  function isUnslotted(node) {
    const parent = node.parentElement;
    return !!(parent && parent.shadowRoot && !node.assignedSlot);
  }

  /** `ancestor.contains(node)` in the composed tree (follows slots and shadow hosts). */
  function containsDeep(ancestor, node) {
    for (let n = node; n; n = composedParent(n)) {
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
    // Walk the composed tree so a hidden <slot> (or shadow wrapper) hides the
    // slotted control too.
    for (let n = el; n; n = composedParent(n)) {
      if (isUnslotted(n)) return false;
      if (n.hasAttribute("hidden")) return false;
      if (n.getAttribute("aria-hidden") === "true") return false;
      if (n.tagName === "DIALOG" && !n.hasAttribute("open")) return false;
      const cs = styleOf(n);
      if (!cs) continue;
      if (cs.display === "none") return false;
      if (n === el && (cs.visibility === "hidden" || cs.visibility === "collapse")) return false;
      const opacity = parseFloat(cs.opacity);
      // A transparent ancestor hides everything; the element itself may be a
      // transparent control laid over its own visible label.
      if (!Number.isNaN(opacity) && opacity <= 0.01 && (n !== el || !isLabelledOverlayControl(el, env))) return false;
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
   * A native control made transparent and laid over a sibling that shows the
   * same label (Amazon's AUI buttons: `<input type=submit value="Decline"
   * style="opacity:.01">` next to `<span aria-hidden>Decline</span>`). The
   * user sees that label as the button, so the control is perceivable. The
   * parent must itself be visible and, when geometry is available, the
   * control must sit inside it.
   */
  function isLabelledOverlayControl(el, env) {
    const tag = el.tagName;
    if (tag !== "INPUT" && tag !== "BUTTON") return false;
    if (tag === "INPUT") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (type !== "submit" && type !== "button") return false;
    }
    const parent = el.parentElement;
    if (!parent) return false;
    const label = normalizeText(tag === "INPUT" ? el.value : el.textContent).toLowerCase();
    if (!label) return false;
    let shown = "";
    for (const child of parent.childNodes) {
      if (child === el) continue;
      if (child.nodeType === TEXT_NODE) shown += ` ${child.nodeValue}`;
      else if (child.nodeType === ELEMENT_NODE && !SKIP_TEXT_TAGS.has(child.tagName)) shown += ` ${child.textContent}`;
    }
    if (normalizeText(shown).toLowerCase() !== label) return false;
    const own = rectOf(el, env);
    const outer = rectOf(parent, env);
    if (own && outer) {
      const cx = own.left + own.width / 2;
      const cy = own.top + own.height / 2;
      if (cx < outer.left || cx > outer.right || cy < outer.top || cy > outer.bottom) return false;
    }
    return isVisible(parent, env);
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
      if (SKIP_TEXT_TAGS.has(el.tagName) && !(el.tagName === "IFRAME" && frameDocumentOf(el))) return true;
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
        if (!Number.isNaN(opacity) && opacity <= 0.01 && !isLabelledOverlayControl(el, env)) return;
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
      if (el.tagName === "IFRAME") {
        const fd = frameDocumentOf(el);
        if (fd) walk(fd.body, hiddenHere);
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
    forEachComposed(container, (el) => {
      if (out.length >= limit) return "stop";
      if (SKIP_TEXT_TAGS.has(el.tagName) && el.tagName !== "IFRAME") return "skip";
      if (el !== container && isButtonLike(el)) {
        if (isVisible(el, env)) out.push(el);
        return "skip";
      }
      return undefined;
    });
    return out;
  }

  /**
   * Visit `root` and its descendants in composed (rendered) tree order:
   * a shadow host's shadow root replaces its light children, and a <slot> is
   * replaced by its assigned nodes (or its fallback content). The visitor may
   * return "skip" (don't descend) or "stop". Bounded by `budget` elements.
   */
  function forEachComposed(root, visit, budget = 5000) {
    let remaining = budget;
    let stopped = false;
    const walk = (node) => {
      if (stopped) return;
      if (node.nodeType === ELEMENT_NODE) {
        if (--remaining < 0) {
          stopped = true;
          return;
        }
        const verdict = visit(node);
        if (verdict === "stop") {
          stopped = true;
          return;
        }
        if (verdict === "skip") return;
        if (node.tagName === "SLOT" && typeof node.assignedNodes === "function") {
          const assigned = node.assignedNodes({ flatten: true });
          if (assigned.length) {
            for (const child of assigned) walk(child);
            return;
          }
        }
        if (node.shadowRoot) {
          walk(node.shadowRoot);
          return;
        }
        if (node.tagName === "IFRAME") {
          const fd = frameDocumentOf(node);
          if (fd) walk(fd.body);
          return;
        }
      }
      for (const child of node.childNodes) {
        if (child.nodeType === ELEMENT_NODE || child.nodeType === DOCUMENT_FRAGMENT_NODE) walk(child);
      }
    };
    walk(root);
  }

  /** Composed-tree descendants of `root` (excluding root), bounded. */
  function composedDescendants(root, limit = 2000) {
    const out = [];
    forEachComposed(root, (el) => {
      if (el !== root) out.push(el);
      return out.length >= limit ? "stop" : undefined;
    }, limit + 1);
    return out;
  }

  /**
   * Every open shadow root under `root` (nested ones included), bounded by a
   * node budget so a huge page can't make this expensive.
   */
  function openShadowRoots(root, nodeBudget = 20000) {
    const roots = [];
    let budget = nodeBudget;
    const queue = [root];
    while (queue.length && budget > 0) {
      const scope = queue.shift();
      let all;
      try {
        all = scope.querySelectorAll("*");
      } catch {
        continue;
      }
      for (const el of all) {
        if (--budget <= 0) break;
        if (el.shadowRoot) {
          roots.push(el.shadowRoot);
          queue.push(el.shadowRoot);
        }
      }
    }
    return roots;
  }

  const api = Object.freeze({
    normalizeText,
    truncate,
    parentOrHost,
    isInlineFrame,
    frameDocumentOf,
    inlineFrameDocuments,
    composedParent,
    containsDeep,
    hasLayout,
    rectOf,
    styleOf,
    isVisible,
    isLabelledOverlayControl,
    visibleText,
    labelOf,
    querySelectorAllDeep,
    sortInTreeOrder,
    isDisabled,
    isSameDocumentLink,
    isButtonLike,
    collectButtonLike,
    forEachComposed,
    composedDescendants,
    openShadowRoots,
  });

  NS.dom = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
