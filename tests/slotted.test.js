"use strict";
// Banners that are in-flow (GOV.UK) or slotted through nested shadow roots (Reddit).
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { lib, load, recordClicks } = require("./helpers.js");

const dom = lib("dom.js");
const cmp = lib("cmp.js");
const detect = lib("detect.js");
const candidates = lib("candidates.js");
const gate = lib("gate.js");
const { rules } = lib("rules.js");

const without = (id) => rules.filter((r) => r.id !== id);
const fast = { timeout: 300, poll: 10 };
const R = (top, height, width = 1280, left = 0) => ({ top, left, height, width, bottom: top + height, right: left + width });

/**
 * Reddit's structure (live, 2026-11):
 *   body > shreddit-app (open shadow: <slot>)
 *     > div#data-protection-consent-dialog (open shadow: fixed overlay > <slot>)
 *       > rpl-modal-card (open shadow: <slot>) > p, button.button-secondary, button.button-primary
 */
function buildReddit() {
  const doc = load(`<!doctype html><html lang="en"><body>
    <shreddit-app>
      <main><p>Popular posts</p></main>
      <div id="data-protection-consent-dialog" bundlename="reddit_cookie_banner">
        <rpl-modal-card>
          <h2>Cookie Notice</h2>
          <p>Reddit and its partners use cookies and similar technologies to provide you with a better experience.</p>
          <button class="button-secondary" id="reddit-reject">Reject Optional Cookies</button>
          <button class="button-primary" id="reddit-accept">Accept All</button>
        </rpl-modal-card>
      </div>
    </shreddit-app></body></html>`);
  doc.querySelector("shreddit-app").attachShadow({ mode: "open" }).innerHTML = "<slot></slot>";
  const dialog = doc.getElementById("data-protection-consent-dialog");
  dialog.attachShadow({ mode: "open" }).innerHTML = `<div class="overlay" style="position:fixed;inset:0;z-index:5"><div class="frame"><slot></slot></div></div>`;
  doc.querySelector("rpl-modal-card").attachShadow({ mode: "open" }).innerHTML = `<div class="card"><slot></slot></div>`;
  const overlay = dialog.shadowRoot.querySelector(".overlay");
  // Geometry as observed live: the host div is 0×0, the overlay fills the viewport.
  const env = {
    viewport: { width: 1280, height: 800, scrollY: 0 },
    isVisible: (el) => el.isConnected && dom.isVisible(el),
    rect: (el) => (el === dialog ? R(0, 0, 0) : el === overlay ? R(0, 800) : el.tagName === "SHREDDIT-APP" ? R(0, 3000) : R(300, 40, 300, 400)),
  };
  return { doc, dialog, overlay, env };
}

describe("Reddit (slotted light DOM inside nested shadow roots)", () => {
  test("dom: slotted buttons are visible, collected and contained in the overlay", () => {
    const { doc, overlay } = buildReddit();
    const reject = doc.getElementById("reddit-reject");
    assert.equal(dom.isVisible(reject), true);
    assert.equal(dom.containsDeep(overlay, reject), true);
    assert.deepEqual(dom.collectButtonLike(overlay).map((b) => b.id), ["reddit-reject", "reddit-accept"]);
    assert.match(dom.visibleText(overlay), /Reddit and its partners use cookies/);
  });

  test("dom: a hidden <slot> hides the slotted control; unslotted children are not rendered", () => {
    const { doc, dialog } = buildReddit();
    const reject = doc.getElementById("reddit-reject");
    doc.querySelector("rpl-modal-card").shadowRoot.querySelector("slot").style.display = "none";
    assert.equal(dom.isVisible(reject), false);
    dialog.shadowRoot.innerHTML = `<div class="overlay" style="position:fixed"></div>`; // no slot
    assert.equal(dom.isVisible(doc.querySelector("rpl-modal-card")), false);
  });

  test("Layer 1: reddit rule picks the secondary (reject) button", () => {
    const { doc } = buildReddit();
    const action = cmp.findAction(doc);
    assert.equal(action.kind, "reject");
    assert.equal(action.rule.id, "reddit");
    assert.equal(action.element.id, "reddit-reject");
  });

  test("Layer 2: overlay found, both buttons sent, gate follows slots", () => {
    const { doc, overlay, env } = buildReddit();
    assert.equal(cmp.findAction(doc, { rules: without("reddit") }), null);
    assert.equal(detect.pageMayHaveBanner(doc), true);

    // Found through the consent-named shadow host, without the fallback scan.
    assert.ok(detect.candidatePool(doc, { scan: false, env }).includes(overlay));
    const best = detect.findBestContainer(doc, { env, scan: false });
    assert.ok(best, "expected a container");
    assert.equal(best.element, overlay);

    const built = candidates.buildRequest(best.element, { env, frame: "top" });
    assert.ok(built.request, built.reason);
    assert.deepEqual(built.request.candidates.map((c) => c.text), ["Reject Optional Cookies", "Accept All"]);
    const rejectId = built.request.candidates.find((c) => c.text === "Reject Optional Cookies").id;

    const result = { type: "identifyRejectControlResult", version: 1, status: "ok", candidateId: rejectId, confidence: "high", reason: "rejects optional cookies", engine: "foundation-models" };
    const verdict = gate.shouldClick(result, built.map, best.element, built.snapshot, { clicked: false, enabled: true, hostDisabled: false }, env);
    assert.equal(verdict.ok, true, verdict.reason);
    assert.equal(verdict.element.id, "reddit-reject");
  });

  test("Layer 2: a slotted password field still excludes the container", () => {
    const { doc, overlay, env } = buildReddit();
    const pw = doc.createElement("input");
    pw.type = "password";
    doc.querySelector("rpl-modal-card").append(pw);
    assert.equal(detect.evaluateContainer(overlay, { env }).reason, "password-field");
  });
});

describe("GOV.UK (in-flow banner)", () => {
  test("Layer 1: reject, then hide; never accept", async () => {
    const doc = load("cmp-govuk.html");
    const clicks = recordClicks(doc);
    const banner = doc.getElementById("global-cookie-message");
    const [message, confirmation] = banner.querySelectorAll(".govuk-cookie-banner__message");
    doc.querySelector('[data-reject-cookies="true"]').addEventListener("click", () => {
      setTimeout(() => {
        message.hidden = true;
        confirmation.hidden = false;
        confirmation.querySelector(".gem-c-cookie-banner__confirmation-message--rejected").hidden = false;
        confirmation.querySelector(".js-hide-button").hidden = false;
      }, 20);
    });
    doc.querySelector('[data-hide-cookie-banner="true"]').addEventListener("click", () => {
      banner.hidden = true;
    });

    const action = cmp.findAction(doc);
    assert.equal(action.kind, "steps");
    assert.equal(action.rule.id, "govuk");
    const result = await cmp.runSteps(doc, action.rule, fast);
    assert.ok(result.ok, result.reason);
    assert.deepEqual(clicks, ["Reject additional cookies", "Hide cookie message"]);
    assert.equal(result.element.textContent, "Reject additional cookies");
    assert.equal(dom.isVisible(banner), false);
  });

  test("Layer 1: hide step is optional", async () => {
    const doc = load("cmp-govuk.html");
    const clicks = recordClicks(doc);
    const result = await cmp.runSteps(doc, cmp.findAction(doc).rule, fast);
    assert.ok(result.ok);
    assert.deepEqual(clicks, ["Reject additional cookies"]);
  });

  test("Layer 1: banner already dismissed → nothing to do", () => {
    const doc = load("cmp-govuk.html");
    for (const m of doc.querySelectorAll(".govuk-cookie-banner__message")) m.hidden = true;
    assert.equal(cmp.findAction(doc).kind, "detected");
  });

  const govEnv = (top) => ({
    viewport: { width: 1280, height: 800, scrollY: 0 },
    rect: (el) => {
      if (el.id === "global-cookie-message") return R(top, 325);
      if (el.tagName === "MAIN") return R(top === 0 ? 400 : 0, 1500);
      if (el.tagName === "HTML" || el.tagName === "BODY") return R(0, 4000);
      return R(top + 40, 40, 300, 20);
    },
  });

  test("Layer 2: in-flow banner at the top of the page is the container", () => {
    const doc = load("cmp-govuk.html");
    assert.equal(cmp.findAction(doc, { rules: without("govuk") }), null);
    const best = detect.findBestContainer(doc, { env: govEnv(0) });
    assert.ok(best);
    assert.equal(best.element.id, "global-cookie-message");
    assert.equal(best.kind, "inflow");
    const built = candidates.buildRequest(best.element, { env: govEnv(0) });
    assert.deepEqual(built.request.candidates.map((c) => c.text), ["Accept additional cookies", "Reject additional cookies"]);
  });

  test("Layer 2: same markup mid-page (top: 2000) is not a container", () => {
    const doc = load("cmp-govuk.html");
    const el = doc.getElementById("global-cookie-message");
    assert.equal(detect.isInflowBanner(el, govEnv(2000)), false);
    assert.equal(detect.findBestContainer(doc, { env: govEnv(2000) }), null);
  });

  test("Layer 2: in-flow banner taller than 60 % of the viewport is not a container", () => {
    const doc = load("cmp-govuk.html");
    const env = { ...govEnv(0), rect: (el) => (el.id === "global-cookie-message" ? R(0, 600) : govEnv(0).rect(el)) };
    assert.equal(detect.isInflowBanner(doc.getElementById("global-cookie-message"), env), false);
  });

  test("Layer 2: in-flow detection fails closed without geometry (jsdom default)", () => {
    const doc = load("cmp-govuk.html");
    assert.equal(detect.isInflowBanner(doc.getElementById("global-cookie-message")), false);
    assert.equal(detect.findBestContainer(doc), null);
  });

  test("Layer 2: static footer region mentioning only 'privacy' is not a container", () => {
    const doc = load("neg-region-footer.html");
    const env = { viewport: { width: 1280, height: 800, scrollY: 0 }, rect: (el) => (el.tagName === "FOOTER" ? R(700, 100) : R(0, 600)) };
    const footer = doc.querySelector("footer");
    assert.equal(detect.isInflowBanner(footer, env), true, "geometry and role qualify…");
    assert.equal(detect.evaluateContainer(footer, { env }).reason, "no-strong-keyword", "…but the vocabulary does not");
    assert.equal(detect.findBestContainer(doc, { env }), null);
  });

  test("Layer 2: a nested in-flow banner qualifies only when it is named as a cookie/consent element", () => {
    const doc = load("cmp-govuk.html");
    const wrapper = doc.createElement("div");
    doc.body.prepend(wrapper);
    const banner = doc.getElementById("global-cookie-message");
    wrapper.append(banner);
    assert.equal(detect.evaluateContainer(banner, { env: govEnv(0) }).eligible, true, "named banner may be nested");
    // Same element with only role="region" left as a hint: fail closed.
    for (const attr of ["id", "class", "aria-label", "data-module"]) banner.removeAttribute(attr);
    assert.equal(detect.evaluateContainer(banner, { env: govEnv(0) }).reason, "low-stacking");
  });
});

describe("Nested in-flow banners (NHS, Twitch)", () => {
  // jsdom has no layout: give the banner a rect at the top of a 1280×800 viewport.
  const envFor = (doc, selector, height) => {
    const banner = doc.querySelector(selector);
    return {
      viewport: { width: 1280, height: 800, scrollY: 0 },
      rect: (el) => (el === banner || banner.contains(el) ? R(0, el === banner ? height : 32) : R(600, 200)),
      isVisible: (el) => el.isConnected && dom.isVisible(el),
    };
  };

  test("NHS: Layer 1 clicks 'Reject analytics cookies' despite its id ending in link_accept", () => {
    const doc = load("cmp-nhs.html", { url: "https://www.nhs.uk/" });
    const action = cmp.findAction(doc);
    assert.ok(action && action.kind === "reject", "expected a direct reject");
    assert.equal(action.rule.id, "nhsuk");
    assert.equal(action.element.id, "nhsuk-cookie-banner__link_accept");
    assert.equal(action.element.textContent.trim(), "Reject analytics cookies");
  });

  test("NHS: Layer 2 (rules off) finds the nested in-flow banner and both buttons", () => {
    const doc = load("cmp-nhs.html", { url: "https://www.nhs.uk/" });
    const env = envFor(doc, "#nhsuk-cookie-banner", 329);
    const best = detect.findBestContainer(doc, { env });
    assert.ok(best, "no container");
    // The outermost cookie-named block wins over the nested #cookiebanner.
    assert.equal(best.element.id, "nhsuk-cookie-banner");
    assert.equal(best.kind, "inflow");
    const built = candidates.buildRequest(best.element, { env, host: "www.nhs.uk" });
    assert.ok(built.request, built.reason);
    assert.deepEqual(built.request.candidates.map((c) => c.text), ["Accept analytics cookies", "Reject analytics cookies"]);
  });

  test("Twitch: Layer 1 clicks Reject, never Accept or Customize", () => {
    const doc = load("cmp-twitch.html", { url: "https://www.twitch.tv/" });
    const action = cmp.findAction(doc);
    assert.ok(action && action.kind === "reject", "expected a direct reject");
    assert.equal(action.rule.id, "twitch");
    assert.equal(action.element.id, "tw-reject");
  });

  test("Twitch: Layer 2 (rules off) accepts the banner six wrappers below body", () => {
    const doc = load("cmp-twitch.html", { url: "https://www.twitch.tv/" });
    const env = envFor(doc, ".consent-banner", 213);
    const best = detect.findBestContainer(doc, { env });
    assert.ok(best, "no container");
    assert.ok(best.element.classList.contains("consent-banner"));
    const built = candidates.buildRequest(best.element, { env, host: "www.twitch.tv" });
    assert.ok(built.request, built.reason);
    assert.deepEqual(built.request.candidates.map((c) => c.text), ["Accept", "Customize", "Reject"]);
    // The login/sign-up nav outside the banner is never part of the request.
    assert.ok(!built.request.candidates.some((c) => /log in|sign up/i.test(c.text)));
  });

  test("Twitch: the same banner mid-page is not a container", () => {
    const doc = load("cmp-twitch.html", { url: "https://www.twitch.tv/" });
    const banner = doc.querySelector(".consent-banner");
    const env = { viewport: { width: 1280, height: 800, scrollY: 0 }, rect: (el) => (el === banner ? R(300, 213) : R(300, 32)), isVisible: (el) => el.isConnected && dom.isVisible(el) };
    assert.equal(detect.evaluateContainer(banner, { env }).reason, "not-positioned");
  });
});

describe("AppConsent (consent UI inside a srcdoc iframe)", () => {
  const { fixture } = require("./helpers.js");
  // jsdom does not load srcdoc, so the frame document is filled in by hand;
  // the iframe has no src, which is what makes it an inline frame.
  const setup = ({ withSkip = true } = {}) => {
    const doc = load("cmp-appconsent.html", { url: "https://www.lefigaro.fr/" });
    const frame = doc.querySelector("#appconsent iframe");
    const inner = frame.contentDocument;
    assert.ok(inner && inner.body, "jsdom gives inline frames a document");
    inner.body.innerHTML = fixture("cmp-appconsent-frame.html");
    if (!withSkip) inner.querySelector(".button__skip").remove();
    return { doc, frame, inner };
  };

  test("dom: the composed walk crosses into the inline frame", () => {
    const { doc, frame, inner } = setup();
    const skip = inner.querySelector(".button__skip");
    assert.equal(dom.isInlineFrame(frame), true);
    assert.equal(dom.frameDocumentOf(frame), inner);
    assert.equal(dom.composedParent(inner.documentElement), frame);
    assert.equal(dom.containsDeep(frame, skip), true);
    assert.equal(dom.containsDeep(doc.body, skip), true);
    assert.equal(dom.isVisible(skip), true);
    assert.match(dom.visibleText(frame), /Continue without accepting.*Make a choice for your data.*Accept all/);
    assert.deepEqual(
      dom.collectButtonLike(frame).map((b) => dom.labelOf(b).text),
      ["Continue without accepting", "our 251 partners", "privacy policy", "Set up", "Accept all", "Already subscribed? Sign in"],
    );
    // A frame with a real src is somebody else's document.
    const external = doc.createElement("iframe");
    external.src = "https://ads.example/x";
    doc.body.append(external);
    assert.equal(dom.isInlineFrame(external), false);
    assert.equal(dom.inlineFrameDocuments(doc).length, 1);
  });

  test("Layer 1: appconsent rule clicks 'Continue without accepting' inside the frame", () => {
    const { doc, inner } = setup();
    const clicks = [];
    inner.addEventListener("click", (e) => clicks.push(e.target.textContent.trim()), true);
    const action = cmp.findAction(doc);
    assert.ok(action && action.kind === "reject", `expected reject, got ${action && action.kind}`);
    assert.equal(action.rule.id, "appconsent");
    assert.equal(action.element.className.includes("button__skip"), true);
    action.element.click();
    assert.deepEqual(clicks, ["Continue without accepting"]);
    assert.match(cmp.bannerElementFor(action.rule, action.element).className, /page__banner|modal__banner/);
  });

  test("Layer 1: the 'refuseAll' slot holding a sign-in link is never clicked", () => {
    const { doc } = setup({ withSkip: false });
    const action = cmp.findAction(doc);
    assert.ok(action, "CMP still detected");
    assert.equal(action.kind, "detected");
  });

  test("Layer 2 (rules off): the fixed iframe is the container; the sign-in button is dropped; the gate follows the frame", () => {
    const { doc, frame, inner } = setup();
    const best = detect.findBestContainer(doc);
    assert.ok(best, "no container");
    assert.equal(best.element, frame);
    const built = candidates.buildRequest(frame, { host: "www.lefigaro.fr" });
    assert.ok(built.request, built.reason);
    const texts = built.request.candidates.map((c) => c.text);
    assert.ok(texts.includes("Continue without accepting"));
    assert.ok(texts.includes("Accept all"));
    assert.ok(!texts.some((t) => /sign in/i.test(t)), "danger-listed control must not be sent");
    const id = built.request.candidates.find((c) => c.text === "Continue without accepting").id;
    const verdict = gate.shouldClick(
      { type: "identifyRejectControlResult", version: 1, status: "ok", candidateId: id, confidence: "high", reason: "", engine: "foundation-models" },
      built.map,
      frame,
      built.snapshot,
      { clicked: false, enabled: true, hostDisabled: false },
    );
    assert.equal(verdict.ok, true, verdict.reason);
    assert.equal(verdict.element, inner.querySelector(".button__skip"));
  });
});
