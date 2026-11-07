"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { lib, load, recordClicks } = require("./helpers.js");

const { rules } = lib("rules.js");
const cmp = lib("cmp.js");
const detect = lib("detect.js");
const candidates = lib("candidates.js");

const fast = { timeout: 300, poll: 10 };

describe("rules data", () => {
  test("ids are unique and every rule is well-formed", () => {
    const ids = new Set();
    for (const r of rules) {
      assert.match(r.id, /^[a-z0-9-]+$/, r.id);
      assert.ok(!ids.has(r.id), `duplicate ${r.id}`);
      ids.add(r.id);
      assert.ok(r.name && typeof r.name === "string");
      assert.ok(Array.isArray(r.detect) && r.detect.length > 0, `${r.id} detect`);
      assert.ok((Array.isArray(r.reject) && r.reject.length > 0) || (Array.isArray(r.steps) && r.steps.length > 0), `${r.id} needs reject or steps`);
      assert.ok(r.frames === undefined || r.frames === "any" || r.frames === "top", `${r.id} frames`);
      if (r.steps) assert.ok(cmp.finalStepIndex(r.steps) >= 0, `${r.id} steps need a final click`);
    }
    assert.ok(rules.length >= 35, `expected broad coverage, got ${rules.length}`);
  });

  test("every selector parses", () => {
    const doc = load("<!doctype html><body></body>");
    const all = [];
    for (const r of rules) {
      for (const e of [...r.detect, ...(r.reject || []), ...(r.banner || []), ...(r.shadow || [])]) all.push(cmp.entryOf(e));
      for (const s of r.steps || []) for (const e of [...(s.click || []), ...(s.waitFor || [])]) all.push(cmp.entryOf(e));
    }
    for (const { selector, host } of all) {
      assert.doesNotThrow(() => doc.querySelectorAll(selector), selector);
      if (host) assert.doesNotThrow(() => doc.querySelectorAll(host), host);
    }
  });

  test("reject selectors never name accept/agree/allow controls (except necessary-only)", () => {
    for (const r of rules) {
      const finals = [...(r.reject || []), ...((r.steps && r.steps[cmp.finalStepIndex(r.steps)].click) || [])];
      for (const e of finals) {
        const { selector } = cmp.entryOf(e);
        if (/accept|agree|allow|consent-button|optin/i.test(selector.replace(/data-cookiefirst-action|optout|OptinDecline/gi, ""))) {
          assert.match(selector, /only-essential|necessary|reject|decline|deny|refuse|disagree|without-agreeing/i, `${r.id}: ${selector}`);
        }
      }
    }
  });

  test("rules are frozen", () => {
    assert.ok(Object.isFrozen(rules));
    assert.ok(Object.isFrozen(rules[0]));
    assert.ok(Object.isFrozen(rules[0].reject));
  });
});

describe("rules engine", () => {
  const expectReject = (fixtureName, ruleId, elementId, opts = {}) => {
    const doc = load(fixtureName);
    const action = cmp.findAction(doc, opts);
    assert.ok(action, `${fixtureName}: no action`);
    assert.equal(action.kind, "reject", `${fixtureName}: kind ${action.kind}`);
    assert.equal(action.rule.id, ruleId);
    if (elementId) assert.equal(action.element.id, elementId);
    return action;
  };

  test("OneTrust: banner reject, not the page's own button", () => {
    expectReject("cmp-onetrust.html", "onetrust", "onetrust-reject-all-handler");
  });

  test("Cookiebot (German)", () => {
    expectReject("cmp-cookiebot.html", "cookiebot", "CybotCookiebotDialogBodyButtonDecline");
  });

  test("Quantcast picks DISAGREE, not MORE OPTIONS or AGREE", () => {
    expectReject("cmp-quantcast.html", "quantcast", "qc-disagree");
  });

  test("Sourcepoint inside its iframe", () => {
    const a = expectReject("cmp-sourcepoint-frame.html", "sourcepoint", "", { isTop: false });
    assert.ok(a.element.classList.contains("sp_choice_type_13"));
  });

  test("Sourcepoint publisher wording: 'Essential cookies only' without choice type 13 (Sky)", () => {
    const doc = load("cmp-sourcepoint-frame.html");
    const reject = doc.querySelector(".sp_choice_type_13");
    reject.className = "message-component message-button no-children sp_choice_type_9";
    reject.title = "Essential cookies only";
    reject.textContent = "Essential cookies only";
    doc.querySelector(".sp_choice_type_12").textContent = "View options";
    const a = cmp.findAction(doc, { isTop: false });
    assert.equal(a.kind, "reject");
    assert.equal(a.element, reject);
    // With no reject-reading button at all, nothing is clicked.
    reject.remove();
    assert.equal(cmp.findAction(doc, { isTop: false }).kind, "detected");
  });

  test("CookieYes", () => {
    const a = expectReject("cmp-cookieyes.html", "cookieyes");
    assert.equal(a.element.textContent, "Reject All");
  });

  test("HubSpot (same-document anchor)", () => {
    expectReject("cmp-hubspot.html", "hubspot", "hs-eu-decline-button");
  });

  test("CookieConsent (orestbida) necessary-only", () => {
    const a = expectReject("cmp-orestbida.html", "cookieconsent");
    assert.equal(a.element.dataset.role, "necessary");
  });

  test("Google Funding Choices", () => {
    const a = expectReject("cmp-funding-choices.html", "funding-choices");
    assert.ok(a.element.classList.contains("fc-cta-do-not-consent"));
  });

  test("Usercentrics inside an open shadow root", () => {
    const doc = load("cmp-usercentrics.html");
    const host = doc.getElementById("usercentrics-root");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<div data-testid="uc-container"><p>Wir verwenden Cookies</p>
      <button data-testid="uc-accept-all-button">Alle akzeptieren</button>
      <button data-testid="uc-deny-all-button">Alle ablehnen</button></div>`;
    const action = cmp.findAction(doc);
    assert.equal(action.kind, "reject");
    assert.equal(action.rule.id, "usercentrics");
    assert.equal(action.element.getAttribute("data-testid"), "uc-deny-all-button");
    assert.equal(action.element.getRootNode(), root);
  });

  test("Transcend: host-scoped selector never escapes the shadow root", () => {
    const doc = load("cmp-transcend.html");
    const root = doc.getElementById("transcend-consent-manager").attachShadow({ mode: "open" });
    root.innerHTML = `<div><button>Allow all</button></div>`;
    const none = cmp.findAction(doc);
    assert.equal(none.kind, "detected", "page's own 'Decline invitation' must not be used");
    root.innerHTML = `<div><button id="t-accept">Allow all</button><button id="t-decline">Decline all</button></div>`;
    const action = cmp.findAction(doc);
    assert.equal(action.kind, "reject");
    assert.equal(action.element.id, "t-decline");
  });

  test("accept-labelled control behind a reject selector is refused", () => {
    const action = cmp.findAction(load("cmp-onetrust-accept-only.html"));
    assert.equal(action.kind, "detected");
  });

  test("already-consented (hidden) banner: detected, nothing to do", () => {
    const action = cmp.findAction(load("cmp-onetrust-consented.html"));
    assert.equal(action.kind, "detected");
  });

  test("no CMP: null", () => {
    assert.equal(cmp.findAction(load("banner-fixed.html")), null);
  });

  test("frames: top-only rules don't run in iframes", () => {
    const doc = load("cmp-trustarc.html");
    assert.equal(cmp.findAction(doc, { isTop: false }), null);
    assert.equal(cmp.findAction(doc, { isTop: true }).kind, "steps");
  });

  test("OneTrust variant: Manage → Reject all (steps)", async () => {
    const doc = load("cmp-onetrust-steps.html");
    const clicks = recordClicks(doc);
    doc.getElementById("onetrust-pc-btn-handler").addEventListener("click", () => {
      doc.getElementById("onetrust-pc-sdk").style.display = "block";
    });
    doc.getElementById("pc-refuse").addEventListener("click", () => {
      doc.getElementById("onetrust-consent-sdk").style.display = "none";
    });
    const action = cmp.findAction(doc);
    assert.equal(action.kind, "steps");
    const result = await cmp.runSteps(doc, action.rule, fast);
    assert.ok(result.ok, result.reason);
    assert.deepEqual(clicks, ["onetrust-pc-btn-handler", "pc-refuse"]);
    assert.equal(result.element.id, "pc-refuse");
  });

  test("OneTrust steps are skipped when the preference centre has no reject (probe)", () => {
    const doc = load("cmp-onetrust-steps.html");
    doc.getElementById("pc-refuse").remove();
    assert.equal(cmp.findAction(doc).kind, "detected");
  });

  test("Didomi variant: Paramétrer → Tout refuser (popup rendered on demand)", async () => {
    const doc = load("cmp-didomi-steps.html");
    const clicks = recordClicks(doc);
    doc.getElementById("didomi-notice-learn-more-button").addEventListener("click", () => {
      setTimeout(() => {
        const popup = doc.createElement("div");
        popup.id = "didomi-popup";
        popup.innerHTML = `<div class="didomi-consent-popup-actions">
          <button id="d-refuse">Tout refuser</button><button id="d-accept">Tout accepter</button></div>`;
        doc.getElementById("didomi-host").append(popup);
      }, 30);
    });
    doc.addEventListener("click", (e) => {
      if (e.target.id === "d-refuse") doc.getElementById("didomi-host").remove();
    });
    const action = cmp.findAction(doc);
    assert.equal(action.kind, "steps");
    assert.equal(action.rule.id, "didomi");
    const result = await cmp.runSteps(doc, action.rule, fast);
    assert.ok(result.ok, result.reason);
    assert.deepEqual(clicks, ["didomi-notice-learn-more-button", "d-refuse"]);
  });

  test("TrustArc two-step: Cookie Preferences → Decline all", async () => {
    const doc = load("cmp-trustarc.html");
    const clicks = recordClicks(doc);
    doc.getElementById("truste-show-consent").addEventListener("click", () => {
      const cm = doc.createElement("div");
      cm.className = "truste_popframe trustarc_newcm_container";
      cm.innerHTML = `<button data-button-key="accept_all" id="ta-accept">Accept All</button>
        <button data-button-key="decline_all" id="ta-decline">Decline All</button>`;
      doc.body.append(cm);
    });
    const action = cmp.findAction(doc);
    assert.equal(action.kind, "steps");
    const result = await cmp.runSteps(doc, action.rule, fast);
    assert.ok(result.ok, result.reason);
    assert.deepEqual(clicks, ["truste-show-consent", "ta-decline"]);
  });

  test("steps fail closed when the next view never appears", async () => {
    const doc = load("cmp-trustarc.html");
    const clicks = recordClicks(doc);
    const action = cmp.findAction(doc);
    const result = await cmp.runSteps(doc, action.rule, fast);
    assert.equal(result.ok, false);
    assert.deepEqual(clicks, ["truste-show-consent"]);
  });

  test("beforeClick can veto a step", async () => {
    const doc = load("cmp-trustarc.html");
    const clicks = recordClicks(doc);
    const action = cmp.findAction(doc);
    const result = await cmp.runSteps(doc, action.rule, { ...fast, beforeClick: async () => false });
    assert.equal(result.ok, false);
    assert.deepEqual(clicks, []);
  });

  test("bannerElementFor finds the CMP container", () => {
    const doc = load("cmp-onetrust.html");
    const action = cmp.findAction(doc);
    assert.equal(cmp.bannerElementFor(action.rule, action.element).id, "onetrust-banner-sdk");
  });
});

describe("Amazon (transparent submit inputs over styled labels)", () => {
  const fixtureDoc = () => load("cmp-amazon.html", { url: "https://www.amazon.co.uk/" });

  test("Layer 1: amazon rule picks Decline, never Accept", () => {
    const doc = fixtureDoc();
    const action = cmp.findAction(doc);
    assert.ok(action && action.kind === "reject", "expected a direct reject");
    assert.equal(action.rule.id, "amazon");
    assert.equal(action.element.id, "sp-cc-rejectall-link");
  });

  test("Layer 1: not in iframes", () => {
    assert.equal(cmp.findAction(fixtureDoc(), { isTop: false }), null);
  });

  test("Layer 2 (rules off): the dialog is the container and both inputs are candidates", () => {
    const doc = fixtureDoc();
    const best = detect.findBestContainer(doc);
    assert.ok(best, "no container");
    assert.equal(best.element.id, "cos-banner");
    const built = candidates.buildRequest(best.element, { host: "www.amazon.co.uk" });
    assert.ok(built.request, built.reason);
    assert.deepEqual(
      built.request.candidates.map((c) => c.text),
      ["Accept", "Decline"],
    );
    assert.equal(built.request.candidates.find((c) => c.text === "Decline").aria, "Decline");
  });
});
