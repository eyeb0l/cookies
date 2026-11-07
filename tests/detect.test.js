"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { lib, load } = require("./helpers.js");

const detect = lib("detect.js");
const dom = lib("dom.js");

describe("consent container detection — positives", () => {
  test("fixed bottom cookie banner", () => {
    const best = detect.findBestContainer(load("banner-fixed.html"));
    assert.ok(best);
    assert.ok(best.element.classList.contains("notice-bar"));
    assert.ok(best.score >= detect.SCORE_THRESHOLD);
    assert.ok(best.hasReject && best.hasAccept);
  });

  test("role=dialog banner without positioning CSS (span role=button controls)", () => {
    const best = detect.findBestContainer(load("banner-dialog.html"));
    assert.ok(best);
    assert.equal(best.element.tagName, "SECTION");
    assert.equal(best.buttons.length, 2);
  });

  test("German banner", () => {
    const best = detect.findBestContainer(load("banner-de.html"));
    assert.ok(best);
    assert.equal(best.element.id, "datenschutz-hinweis");
  });

  test("French banner", () => {
    const best = detect.findBestContainer(load("banner-fr.html"));
    assert.ok(best);
    assert.ok(best.element.classList.contains("bandeau"));
  });

  test("ignores the sticky site header (no consent vocabulary)", () => {
    const doc = load("banner-fixed.html");
    const header = doc.querySelector("header");
    assert.equal(detect.evaluateContainer(header).eligible, false);
  });

  test("banner inside an open shadow root of a body child", () => {
    const doc = load("<!doctype html><body><p>x</p><cookie-notice></cookie-notice></body>");
    const host = doc.querySelector("cookie-notice");
    host.attachShadow({ mode: "open" }).innerHTML = `<div role="dialog"><p>We use cookies for analytics.</p>
      <button>Accept</button><button>Reject</button></div>`;
    const best = detect.findBestContainer(doc);
    assert.ok(best);
    assert.equal(best.element.getAttribute("role"), "dialog");
  });
});

describe("consent container detection — negatives", () => {
  for (const [name, why] of [
    ["neg-login.html", "password-field"],
    ["neg-checkout.html", "payment-field"],
    ["neg-newsletter.html", "email-with-submit"],
    ["neg-job-application.html", "file-input"],
  ]) {
    test(`${name} is excluded (${why})`, () => {
      const doc = load(name);
      assert.equal(detect.findBestContainer(doc), null);
      const el = doc.querySelector('[role="dialog"]');
      assert.equal(detect.evaluateContainer(el).reason, why);
    });
  }

  test("chat widget mentioning the privacy policy scores below threshold", () => {
    const doc = load("neg-chat.html");
    assert.equal(detect.findBestContainer(doc), null);
    const r = detect.evaluateContainer(doc.querySelector(".chat-widget"));
    assert.ok(!r.eligible || r.score < detect.SCORE_THRESHOLD);
  });

  test("static (non-positioned) footer notice is ignored", () => {
    assert.equal(detect.findBestContainer(load("neg-static-footer.html")), null);
  });

  test("more than 12 button-like controls: not a container", () => {
    const doc = load("banner-many-buttons.html");
    assert.equal(detect.findBestContainer(doc), null);
    assert.equal(detect.evaluateContainer(doc.querySelector(".cookie-banner")).reason, "too-many-buttons");
  });

  test("hidden banner is ignored", () => {
    const doc = load("banner-fixed.html");
    doc.querySelector(".notice-bar").style.visibility = "hidden";
    assert.equal(detect.findBestContainer(doc), null);
    doc.querySelector(".notice-bar").style.visibility = "";
    doc.querySelector(".notice-bar").setAttribute("aria-hidden", "true");
    assert.equal(detect.findBestContainer(doc), null);
  });

  test("low stacking: nested sticky element without z-index", () => {
    const doc = load(`<!doctype html><body><div><div><div class="x" style="position:sticky">We use cookies.
      <button>Reject all</button><button>Accept all</button></div></div></div></body>`);
    assert.equal(detect.evaluateContainer(doc.querySelector(".x")).reason, "low-stacking");
  });

  test("page without consent vocabulary is skipped by the pre-check", () => {
    const doc = load(`<!doctype html><body><div style="position:fixed;z-index:99">Hello <button>OK</button></div></body>`);
    assert.equal(detect.pageMayHaveBanner(doc), false);
    assert.equal(detect.findBestContainer(doc), null);
  });
});

describe("geometry via env overrides (jsdom has no layout)", () => {
  test("too-small container is rejected when geometry is known", () => {
    const doc = load("banner-fixed.html");
    const el = doc.querySelector(".notice-bar");
    const env = { rect: () => ({ left: 0, top: 0, right: 40, bottom: 10, width: 40, height: 10 }) };
    assert.equal(detect.evaluateContainer(el, { env }).reason, "too-small");
  });

  test("env.isVisible overrides the style heuristic", () => {
    const doc = load("banner-fixed.html");
    const el = doc.querySelector(".notice-bar");
    assert.equal(detect.evaluateContainer(el, { env: { isVisible: () => false } }).reason, "hidden");
  });

  test("off-screen controls are not visible when geometry is known", () => {
    const doc = load("banner-fixed.html");
    const button = doc.querySelector(".notice-bar button");
    const env = { rect: () => ({ left: -10000, top: 0, right: -9900, bottom: 20, width: 100, height: 20 }) };
    assert.equal(dom.isVisible(button, env), false);
  });
});

describe("dom helpers", () => {
  test("visibleText skips hidden, aria-hidden and script content", () => {
    const doc = load(`<!doctype html><body><div id="r">A <span style="display:none">B</span>
      <span aria-hidden="true">C</span><script>D</script><span style="visibility:hidden">E<b style="visibility:visible">F</b></span>
      <input type="button" value="G"></div></body>`);
    assert.equal(dom.visibleText(doc.getElementById("r")), "A F G");
  });

  test("visibleText respects max length", () => {
    const doc = load(`<!doctype html><body><div id="r">${"word ".repeat(1000)}</div></body>`);
    assert.ok(dom.visibleText(doc.getElementById("r"), { max: 50 }).length <= 50);
  });

  test("same-document link detection", () => {
    const doc = load(`<!doctype html><body>
      <a id="a1">x</a><a id="a2" href="">x</a><a id="a3" href="#">x</a><a id="a4" href="javascript:void(0)">x</a>
      <a id="a5" href="/page?q=1">x</a><a id="a6" href="/page">x</a><a id="a7" href="https://other.example/">x</a>
      <a id="a8" href="/page#frag">x</a></body>`, { url: "https://www.example.com/page" });
    const r = (id) => dom.isSameDocumentLink(doc.getElementById(id));
    assert.deepEqual(["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"].map(r), [true, true, true, true, false, true, false, true]);
  });

  test("button-like detection", () => {
    const doc = load(`<!doctype html><body>
      <button id="b1">x</button><input id="b2" type="submit"><input id="b3" type="text"><div id="b4" role="button">x</div>
      <div id="b5" tabindex="0" class="cc-btn">Reject</div><div id="b6" tabindex="0"><p>a</p><p>b</p><p>c</p></div>
      <span id="b7" onclick="x()">Decline</span><a id="b8" href="/elsewhere">x</a></body>`);
    const r = (id) => dom.isButtonLike(doc.getElementById(id));
    assert.deepEqual(["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"].map(r), [true, true, false, true, true, false, true, false]);
  });

  test("querySelectorAllDeep returns shadow matches in tree order", () => {
    const doc = load(`<!doctype html><body><button id="first">1</button><div id="host"></div><button id="last">3</button></body>`);
    doc.getElementById("host").attachShadow({ mode: "open" }).innerHTML = `<button id="middle">2</button>`;
    assert.deepEqual(dom.querySelectorAllDeep(doc, "button").map((b) => b.id), ["first", "middle", "last"]);
  });
});

describe("transparent controls over a visible label", () => {
  const html = (inputValue, shown, { opacity = "0.01", tag = "input" } = {}) => `<!doctype html><body>
    <span id="wrap" style="position:relative">
      ${tag === "input" ? `<input id="ctl" type="submit" value="${inputValue}" style="position:absolute;opacity:${opacity}">` : `<button id="ctl" style="position:absolute;opacity:${opacity}">${inputValue}</button>`}
      <span aria-hidden="true"> ${shown} </span>
    </span></body>`;

  test("input at opacity .01 over a span showing the same label is visible", () => {
    const doc = load(html("Decline", "Decline"));
    assert.equal(dom.isVisible(doc.getElementById("ctl")), true);
    assert.equal(dom.visibleText(doc.getElementById("wrap")), "Decline");
  });

  test("a button works the same way", () => {
    const doc = load(html("Decline", "Decline", { tag: "button" }));
    assert.equal(dom.isVisible(doc.getElementById("ctl")), true);
  });

  test("label mismatch keeps the control hidden", () => {
    const doc = load(html("Decline", "Accept"));
    assert.equal(dom.isVisible(doc.getElementById("ctl")), false);
  });

  test("no sibling label keeps the control hidden", () => {
    const doc = load(html("Decline", ""));
    assert.equal(dom.isVisible(doc.getElementById("ctl")), false);
  });

  test("opacity 0 with a label is still hidden on the parent, and a hidden parent hides the control", () => {
    const doc = load(`<!doctype html><body><span id="wrap" style="opacity:0"><input id="ctl" type="submit" value="Decline" style="opacity:0.01"><span aria-hidden="true">Decline</span></span></body>`);
    assert.equal(dom.isVisible(doc.getElementById("ctl")), false);
  });

  test("a transparent ancestor still hides an ordinary control", () => {
    const doc = load(`<!doctype html><body><div style="opacity:0.01"><button id="ctl">Decline</button></div></body>`);
    assert.equal(dom.isVisible(doc.getElementById("ctl")), false);
  });

  test("geometry: the control must sit inside its parent", () => {
    const doc = load(html("Decline", "Decline"));
    const ctl = doc.getElementById("ctl");
    const far = { rect: (el) => (el === ctl ? { left: 900, top: 900, right: 950, bottom: 930, width: 50, height: 30 } : { left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40 }) };
    assert.equal(dom.isVisible(ctl, far), false);
    const inside = { rect: (el) => (el === ctl ? { left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40 } : { left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40 }) };
    assert.equal(dom.isVisible(ctl, inside), true);
  });
});

describe("sub-frame whose whole document is the banner", () => {
  const candidates = lib("candidates.js");

  test("body qualifies only when content.js opts in (iframe) and the text has strong consent vocabulary", () => {
    const doc = load("cmp-sourcepoint-frame.html");
    assert.equal(detect.findBestContainer(doc), null, "top-level documents never use body");
    const best = detect.findBestContainer(doc, { frameBody: true });
    assert.ok(best, "frame body should be the container");
    assert.equal(best.element, doc.body);
    assert.equal(best.kind, "frame");
    const built = candidates.buildRequest(doc.body, { frame: "sub", host: "cdn.privacy-mgmt.com" });
    assert.deepEqual(built.request.candidates.map((c) => c.text), ["Settings", "Reject All", "Accept All"]);
  });

  test("frame body with only weak vocabulary, or with a login form, is refused", () => {
    const weak = load(`<!doctype html><body><p>Read our privacy policy.</p><button>Reject</button></body>`);
    assert.equal(detect.evaluateContainer(weak.body, { frameBody: true }).reason, "no-strong-keyword");
    const login = load(`<!doctype html><body><p>Cookies help us sign you in.</p><form method="post"><input type="text" name="u"><input type="password" name="p"><button>Reject</button></form></body>`);
    assert.equal(detect.evaluateContainer(login.body, { frameBody: true }).reason, "password-field");
  });

  test("a positioned banner inside the frame still wins over the body", () => {
    const doc = load("banner-fixed.html");
    const best = detect.findBestContainer(doc, { frameBody: true });
    assert.ok(best);
    assert.notEqual(best.element, doc.body);
  });
});
