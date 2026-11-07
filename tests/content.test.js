"use strict";
// Integration: run the real content-script bundle (manifest order) in jsdom
// with a mocked `browser.runtime`.
const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { RESOURCES, fixture } = require("./helpers.js");

const manifest = JSON.parse(fs.readFileSync(path.join(RESOURCES, "manifest.json"), "utf8"));
const bundle = manifest.content_scripts[0].js.map((f) => fs.readFileSync(path.join(RESOURCES, f), "utf8"));

const windows = [];
afterEach(() => {
  // Closing the window cancels content.js timers so the test process exits.
  while (windows.length) windows.pop().close();
});

function run(html, { settings = { active: true, hostDisabled: false, settings: { enabled: true, disabledHosts: [] } }, classify } = {}) {
  const jsdom = new JSDOM(html, { url: "https://www.example.com/", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = jsdom;
  windows.push(window);
  const messages = [];
  window.browser = {
    runtime: {
      sendMessage: async (msg) => {
        messages.push(msg);
        if (msg.type === "getSettings") return typeof settings === "function" ? settings() : settings;
        if (msg.type === "classify") return classify ? classify(msg.request) : { status: "error" };
        return { ok: true };
      },
    },
  };
  for (const code of bundle) window.eval(code);
  return { window, document: window.document, messages };
}

const until = async (fn, timeout = 4000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
};
const statuses = (messages) => messages.filter((m) => m.type === "status").map((m) => m.status);

describe("content script", () => {
  test("namespace is non-enumerable and the bundle loads without throwing", () => {
    const { window } = run("<!doctype html><body></body>");
    assert.ok(window.__cookies && window.__cookies.dom && window.__cookies.cmp);
    assert.ok(!Object.keys(window).includes("__cookies"));
  });

  test("Layer 1: clicks OneTrust reject once and reports it", async () => {
    const { document, messages } = run(fixture("cmp-onetrust.html"));
    const clicked = [];
    document.addEventListener("click", (e) => {
      clicked.push(e.target.id);
      if (e.target.id === "onetrust-reject-all-handler") document.getElementById("onetrust-banner-sdk").style.display = "none";
    });
    const s = await until(() => statuses(messages).find((x) => x.outcome === "rejected"));
    assert.ok(s, "expected a rejected status");
    assert.deepEqual(JSON.parse(JSON.stringify(s)), { outcome: "rejected", layer: "rules", cmp: "onetrust", reason: "OneTrust", code: null });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(clicked, ["onetrust-reject-all-handler"]);
    assert.equal(messages.filter((m) => m.type === "classify").length, 0, "no model request when a rule matched");
  });

  test("the rejected status is sent before the click, so a click that navigates cannot lose it", async () => {
    const { document, messages } = run(fixture("cmp-onetrust.html"));
    let reportedBeforeClick = null;
    document.addEventListener("click", (e) => {
      if (e.target.id === "onetrust-reject-all-handler") {
        reportedBeforeClick = statuses(messages).some((x) => x.outcome === "rejected");
        document.getElementById("onetrust-banner-sdk").remove();
      }
    });
    await until(() => reportedBeforeClick !== null);
    assert.equal(reportedBeforeClick, true);
  });

  test("steps flow: the rejected status precedes the final click, not the intermediate one", async () => {
    const { document, messages } = run(fixture("cmp-onetrust-steps.html"));
    const seen = {};
    document.addEventListener("click", (e) => {
      seen[e.target.id] = statuses(messages).some((x) => x.outcome === "rejected");
      if (e.target.id === "onetrust-pc-btn-handler") document.getElementById("onetrust-pc-sdk").style.display = "block";
      if (e.target.classList.contains("ot-pc-refuse-all-handler")) document.getElementById("onetrust-consent-sdk").remove();
    });
    await until(() => Object.keys(seen).length >= 2);
    assert.equal(seen["onetrust-pc-btn-handler"], false, "no rejected report before opening the preference centre");
    assert.equal(Object.values(seen).at(-1), true, "rejected reported before the final click");
  });

  test("in an iframe, a control that stops intersecting the viewport after the click counts as gone", async () => {
    // The real bundle runs inside a jsdom iframe, so window.top !== window.
    const { document } = run("<!doctype html><body><iframe id=\"f\"></iframe></body>");
    const fw = document.getElementById("f").contentWindow;
    const fd = fw.document;
    fd.body.innerHTML = fixture("cmp-sourcepoint-frame.html").replace(/^[\s\S]*<body>|<\/body>[\s\S]*$/g, "");
    const messages = [];
    fw.browser = {
      runtime: {
        sendMessage: async (msg) => {
          messages.push(msg);
          if (msg.type === "getSettings") return { active: true, hostDisabled: false, settings: { enabled: true, disabledHosts: [] } };
          return { ok: true };
        },
      },
    };
    let hidden = false;
    fw.IntersectionObserver = class {
      constructor(cb) {
        this.cb = cb;
      }
      observe() {
        setTimeout(() => this.cb([{ isIntersecting: !hidden }]), 0);
      }
      disconnect() {}
    };
    fd.addEventListener("click", (e) => {
      // Sourcepoint leaves the message DOM alone; the parent hides the frame.
      if (e.target.classList.contains("sp_choice_type_13")) hidden = true;
    });
    for (const code of bundle) fw.eval(code);
    assert.ok(await until(() => statuses(messages).some((x) => x.outcome === "rejected")), "rule should click inside the frame");
    await new Promise((r) => setTimeout(r, 3500));
    assert.ok(!statuses(messages).some((x) => x.code === "not-verified"), "hidden frame must not be reported as not-verified");
  });

  test("disabled: does nothing", async () => {
    const { document, messages } = run(fixture("cmp-onetrust.html"), { settings: { active: false, hostDisabled: true } });
    const clicked = [];
    document.addEventListener("click", (e) => clicked.push(e.target.id));
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(clicked, []);
    assert.deepEqual(messages.map((m) => m.type), ["getSettings"]);
  });

  test("Layer 2: one model request, gate passes, clicks the reject candidate", async () => {
    const requests = [];
    const { document, messages } = run(fixture("banner-fixed.html"), {
      classify: (request) => {
        requests.push(request);
        const reject = request.candidates.find((c) => c.text === "Reject all");
        return { type: "identifyRejectControlResult", version: 1, status: "ok", candidateId: reject.id, confidence: "high", reason: "Declines optional cookies", engine: "foundation-models" };
      },
    });
    const clicked = [];
    document.addEventListener("click", (e) => {
      clicked.push(e.target.textContent);
      document.querySelector(".notice-bar").remove();
    });
    const s = await until(() => statuses(messages).find((x) => x.outcome === "rejected"));
    assert.ok(s, "expected a rejected status");
    assert.equal(s.layer, "model");
    assert.equal(s.reason, "Declines optional cookies");
    assert.deepEqual(clicked, ["Reject all"]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].page.host, "www.example.com");
  });

  test("Layer 2: model picking the accept button is refused by the gate", async () => {
    const { document, messages } = run(fixture("banner-fixed.html"), {
      classify: (request) => ({ type: "identifyRejectControlResult", version: 1, status: "ok", candidateId: request.candidates.find((c) => /Accept/.test(c.text)).id, confidence: "high", reason: "x", engine: "foundation-models" }),
    });
    const clicked = [];
    document.addEventListener("click", (e) => clicked.push(e.target.textContent));
    const s = await until(() => statuses(messages).find((x) => x.outcome === "skipped"));
    assert.equal(s.code, "gate");
    assert.deepEqual(clicked, []);
  });

  test("Layer 2: non-ok status is reported and nothing is clicked", async () => {
    const { document, messages } = run(fixture("banner-de.html"), {
      classify: () => ({ type: "identifyRejectControlResult", version: 1, status: "unavailable", candidateId: null, confidence: null, reason: "Apple Intelligence is off", engine: "none" }),
    });
    const clicked = [];
    document.addEventListener("click", (e) => clicked.push(e.target.textContent));
    const s = await until(() => statuses(messages).find((x) => x.outcome === "skipped"));
    assert.equal(s.code, "unavailable");
    assert.deepEqual(clicked, []);
  });

  test("Layer 2: user pauses the site while the model is thinking", async () => {
    let active = true;
    const { document, messages } = run(fixture("banner-fixed.html"), {
      settings: () => (active ? { active: true, hostDisabled: false, settings: { enabled: true, disabledHosts: [] } } : { active: false, hostDisabled: true, settings: { enabled: true, disabledHosts: ["example.com"] } }),
      classify: (request) => {
        active = false;
        return { type: "identifyRejectControlResult", version: 1, status: "ok", candidateId: request.candidates.find((c) => c.text === "Reject all").id, confidence: "high", reason: "x", engine: "foundation-models" };
      },
    });
    const clicked = [];
    document.addEventListener("click", (e) => clicked.push(e.target.textContent));
    const s = await until(() => statuses(messages).find((x) => x.outcome === "skipped"));
    assert.equal(s.code, "gate");
    assert.deepEqual(clicked, []);
  });

  test("late banner inserted after idle is caught by the observer", async () => {
    const { document, messages } = run("<!doctype html><body><p>Hello</p></body>");
    const clicked = [];
    document.addEventListener("click", (e) => {
      clicked.push(e.target.id);
      e.target.closest("#hs-eu-cookie-confirmation").remove();
    });
    await new Promise((r) => setTimeout(r, 100));
    const div = document.createElement("div");
    div.id = "hs-eu-cookie-confirmation";
    div.innerHTML = `<p>This website stores cookies.</p><a id="hs-eu-confirmation-button" href="#">Accept</a><a id="hs-eu-decline-button" href="#">Decline</a>`;
    document.body.append(div);
    const s = await until(() => statuses(messages).find((x) => x.outcome === "rejected"));
    assert.ok(s);
    assert.equal(s.cmp, "hubspot");
    assert.deepEqual(clicked, ["hs-eu-decline-button"]);
  });
});
