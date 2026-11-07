/*
 * content.js — runs in every frame at document_idle, after lib/*.js (see
 * manifest.json). Orchestrates Layer 1 (CMP rules), Layer 2 (on-device model
 * via background → native) and the safety gate. Never throws into the page.
 */
"use strict";

(() => {
  const NS = globalThis.__cookies;
  if (!NS || !NS.dom || !NS.gate || !NS.cmp || !NS.detect || !NS.candidates) return;
  if (NS.started) return; // injected twice (e.g. extension reload): keep the first
  try {
    Object.defineProperty(NS, "started", { value: true, enumerable: false });
  } catch {
    return;
  }
  const runtime = typeof browser !== "undefined" && browser.runtime ? browser.runtime : null;
  if (!runtime) return;

  const { dom, gate, cmp, detect, candidates } = NS;

  const DEBUG = false;
  const log = (...args) => {
    if (DEBUG) console.debug("[cookies]", ...args);
  };

  const OBSERVE_MS = 30000; // watch for late banners this long after document_idle
  const DEBOUNCE_MS = 400; // minimum gap between passes triggered by mutations
  const STABLE_MS = 600; // a container must persist this long before Layer 2 asks the model
  const VERIFY_MS = 3000; // after clicking, wait this long for the banner to go away
  const VERIFY_POLL_MS = 100;
  // Periodic passes catch banners rendered inside shadow roots, which the
  // document-level MutationObserver cannot see.
  const TIMED_PASSES_MS = [1000, 2500, 5000, 9000, 14000, 20000, 27000];

  const isTop = (() => {
    try {
      return window.top === window;
    } catch {
      return false;
    }
  })();

  const state = {
    clicked: false, // ARCHITECTURE: never click more than once per document
    modelRequested: false, // ARCHITECTURE: at most one model request per document
    modelPending: false,
    rulesBusy: false,
    finished: false,
    observing: false,
    reported: false,
    attempted: new Set(), // rule ids whose multi-step flow already ran
    seenContainers: new WeakSet(),
    candidate: null, // { element, since } — Layer 2 stability tracking
    observer: null,
    timers: [],
    passTimer: null,
    lastPassAt: 0,
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function send(message) {
    try {
      return await runtime.sendMessage(message);
    } catch (e) {
      log("sendMessage failed", e);
      return null;
    }
  }

  async function readSettings() {
    const reply = await send({ type: "getSettings" });
    return reply && typeof reply === "object" ? reply : null;
  }

  /** Re-checked right before every click: the user may have just paused us. */
  async function stillActive() {
    const s = await readSettings();
    return !!(s && s.active === true);
  }

  function report(status) {
    state.reported = true;
    send({ type: "status", status: { outcome: status.outcome, layer: status.layer ?? null, cmp: status.cmp ?? null, reason: status.reason || "", code: status.code ?? null } });
  }

  function stopObserving() {
    state.observing = false;
    if (state.observer) state.observer.disconnect();
    state.observer = null;
    for (const t of state.timers) clearTimeout(t);
    state.timers = [];
    if (state.passTimer) clearTimeout(state.passTimer);
    state.passTimer = null;
  }

  function finish() {
    state.finished = true;
    stopObserving();
  }

  /** Resolve true once the clicked control or its banner is gone/hidden. */
  async function verifyGone(element, banner) {
    const gone = (el) => !el || !el.isConnected || !dom.isVisible(el);
    const deadline = Date.now() + VERIFY_MS;
    while (Date.now() < deadline) {
      await sleep(VERIFY_POLL_MS);
      if (gone(element) || (banner && banner !== element && gone(banner))) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Layer 1

  async function runRules() {
    if (state.rulesBusy || state.clicked || state.finished) return false;
    const action = cmp.findAction(document, { isTop, attempted: state.attempted });
    if (!action || action.kind === "detected") return false;
    const { rule } = action;
    state.rulesBusy = true;
    try {
      if (!(await stillActive())) {
        finish();
        return true;
      }
      if (state.clicked) return true;
      let element;
      if (action.kind === "reject") {
        element = action.element;
        // Re-validate after the async settings round trip.
        if (!element.isConnected || !dom.isVisible(element) || dom.isDisabled(element)) return false;
        state.clicked = true;
        element.click();
      } else {
        state.attempted.add(rule.id);
        // Starting a flow counts as this document's click: nothing else
        // (including Layer 2) may click afterwards, even if a step fails.
        state.clicked = true;
        const result = await cmp.runSteps(document, rule, { beforeClick: () => stillActive() });
        if (!result.ok) {
          report({ outcome: "error", layer: "rules", cmp: rule.id, reason: rule.name, code: "steps-failed" });
          finish();
          return true;
        }
        element = result.element;
      }
      log("rule clicked", rule.id);
      // Report immediately: if the CMP removes our iframe we never get to verify.
      report({ outcome: "rejected", layer: "rules", cmp: rule.id, reason: rule.name });
      const gone = await verifyGone(element, cmp.bannerElementFor(rule, element));
      if (!gone) report({ outcome: "error", layer: "rules", cmp: rule.id, reason: rule.name, code: "not-verified" });
      finish();
      return true;
    } finally {
      state.rulesBusy = false;
    }
  }

  // -------------------------------------------------------------------------
  // Layer 2

  const SKIP_CODES = new Set(["unavailable", "uncertain", "not-consent", "none"]);

  function reportModelResult(result) {
    const reason = typeof result.reason === "string" ? result.reason : "";
    if (SKIP_CODES.has(result.status)) report({ outcome: "skipped", layer: "model", reason, code: result.status });
    else report({ outcome: "error", layer: "model", reason, code: "error" });
  }

  async function runModel() {
    if (state.modelRequested || state.clicked || state.finished || !state.observing) return;
    // Tiny frames (ads, widgets) don't host consent banners we should touch.
    if (!isTop && (window.innerWidth < 200 || window.innerHeight < 80)) return;

    // In an iframe the whole document may be the banner (Sourcepoint & co).
    const best = detect.findBestContainer(document, { frameBody: !isTop });
    if (!best || state.seenContainers.has(best.element)) {
      state.candidate = null;
      return;
    }
    // Wait until the same container has been present for STABLE_MS so we
    // don't spend the single model request on a half-rendered banner.
    const now = Date.now();
    if (!state.candidate || state.candidate.element !== best.element) {
      state.candidate = { element: best.element, since: now };
      schedule(STABLE_MS);
      return;
    }
    if (now - state.candidate.since < STABLE_MS) {
      schedule(STABLE_MS - (now - state.candidate.since));
      return;
    }

    const container = best.element;
    state.seenContainers.add(container);
    const built = candidates.buildRequest(container, {
      frame: isTop ? "top" : "sub",
      host: location.hostname,
      lang: document.documentElement.getAttribute("lang") || "",
    });
    if (!built.request) {
      // Fail closed (too many controls, nothing reject-like, …): leave it alone.
      log("layer 2 skipped", built.reason);
      report({ outcome: "skipped", layer: "model", reason: "", code: built.reason });
      return;
    }

    state.modelRequested = true;
    state.modelPending = true;
    try {
      const reply = await send({ type: "classify", request: built.request });
      const result = reply && typeof reply === "object" ? reply : { status: "error", reason: "No reply." };
      if (result.status !== "ok") {
        reportModelResult(result);
        return;
      }
      const s = await readSettings();
      const verdict = gate.shouldClick(result, built.map, container, built.snapshot, {
        clicked: state.clicked,
        // Unknown settings (background unreachable) => fail closed.
        enabled: !!(s && s.settings && s.settings.enabled === true),
        hostDisabled: !s || s.hostDisabled !== false,
      });
      if (!verdict.ok) {
        log("gate refused", verdict.reason);
        report({ outcome: "skipped", layer: "model", reason: typeof result.reason === "string" ? result.reason : "", code: "gate" });
        return;
      }
      state.clicked = true;
      verdict.element.click();
      report({ outcome: "rejected", layer: "model", reason: result.reason || "" });
      const gone = await verifyGone(verdict.element, container);
      if (!gone) report({ outcome: "error", layer: "model", reason: result.reason || "", code: "not-verified" });
      finish();
    } finally {
      state.modelPending = false;
      built.map.clear(); // element references live for this one request only
    }
  }

  // -------------------------------------------------------------------------
  // Scheduling

  async function pass() {
    if (state.finished) return;
    state.lastPassAt = Date.now();
    try {
      if (await runRules()) return;
      if (state.finished || state.clicked || state.rulesBusy) return;
      // Not awaited: Layer 1 keeps running on mutations while the model thinks.
      runModel().catch((e) => log("layer 2 error", e));
    } catch (e) {
      log("pass error", e);
    }
  }

  /** Throttled: at most one pending pass, at least DEBOUNCE_MS apart. */
  function schedule(delay = DEBOUNCE_MS) {
    if (state.finished || !state.observing || state.passTimer) return;
    const wait = Math.max(delay, state.lastPassAt + DEBOUNCE_MS - Date.now(), 0);
    state.passTimer = setTimeout(() => {
      state.passTimer = null;
      pass();
    }, wait);
  }

  function endObservation() {
    stopObserving();
    // Only the top frame reports "nothing found"; iframes stay quiet.
    if (isTop && !state.reported && !state.modelPending && !state.clicked) report({ outcome: "none" });
  }

  async function start() {
    const s = await readSettings();
    if (!s || s.active !== true || !document.documentElement) return;
    state.observing = true;
    try {
      state.observer = new MutationObserver(() => schedule());
      state.observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style", "hidden", "open", "aria-hidden"],
      });
    } catch (e) {
      log("observer", e);
    }
    for (const t of TIMED_PASSES_MS) state.timers.push(setTimeout(() => schedule(0), t));
    state.timers.push(setTimeout(endObservation, OBSERVE_MS));
    await pass();
  }

  start().catch((e) => log("start failed", e));
})();
