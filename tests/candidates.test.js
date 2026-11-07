"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { lib, load } = require("./helpers.js");

const detect = lib("detect.js");
const candidates = lib("candidates.js");
const background = require("../Cookies/Shared (Extension)/Resources/background.js");

describe("candidate extraction", () => {
  test("ids c1..cN in document order; danger and non-button controls dropped", () => {
    const doc = load("banner-dangerous.html");
    const container = doc.querySelector(".cookie-banner");
    const { request, map, snapshot } = candidates.buildRequest(container, { frame: "top" });
    assert.ok(request);
    assert.deepEqual(request.candidates.map((c) => c.id), ["c1", "c2", "c3"]);
    assert.deepEqual([...map.values()].map((el) => el.id), ["b1", "b2", "b5"]);
    assert.equal(snapshot.get("c2").text, "Reject all");
    assert.equal(snapshot.get("c2").aria, "Reject all optional cookies");
    assert.ok(background.validateRequest(request), "request must satisfy the wire contract");
  });

  test("payload shape, truncation and attribute whitelist", () => {
    const doc = load("banner-dangerous.html");
    const { request } = candidates.buildRequest(doc.querySelector(".cookie-banner"), { frame: "top" });
    assert.equal(request.type, "identifyRejectControl");
    assert.equal(request.version, 1);
    assert.deepEqual(request.page, { host: "www.example.com", lang: "en", frame: "top" });
    assert.equal(request.container.tag, "div");
    assert.ok(request.container.text.length <= 600);
    assert.deepEqual(request.container.attrs, { class: "cookie-banner" });

    const c1 = request.candidates[0];
    assert.equal(c1.tag, "button");
    assert.equal(c1.text.length, 80);
    assert.ok(c1.text.startsWith("Accept all cookies"));
    assert.equal(c1.role, "");
    assert.equal(c1.disabled, false);
    assert.deepEqual(Object.keys(c1.attrs), ["id", "class", "data-action", "data-track", "data-x1", "data-x2"]);
    assert.equal(c1.attrs["data-track"].length, 60);
    assert.ok(!("style" in c1.attrs) && !("href" in c1.attrs));

    const c2 = request.candidates[1];
    assert.equal(c2.aria, "Reject all optional cookies");

    const c3 = request.candidates[2];
    assert.equal(c3.tag, "a");
    assert.equal(c3.text, "Cookie settings");
  });

  test("container text is capped at 600 characters", () => {
    const long = "We use cookies. ".repeat(100);
    const doc = load(`<!doctype html><body><div class="cookie" style="position:fixed;z-index:99">${long}<button>Reject all</button></div></body>`);
    const { request } = candidates.buildRequest(doc.querySelector(".cookie"));
    assert.ok(request.container.text.length <= 600);
  });

  test("more than 12 button-like controls aborts Layer 2 entirely", () => {
    const doc = load("banner-many-buttons.html");
    const r = candidates.buildRequest(doc.querySelector(".cookie-banner"));
    assert.equal(r.request, null);
    assert.equal(r.reason, "too-many-controls");
  });

  test("no reject-like control: nothing is sent", () => {
    const doc = load(`<!doctype html><body><div class="cookie" style="position:fixed;z-index:99">We use cookies.
      <button>Accept</button><button>Settings</button></div></body>`);
    const r = candidates.buildRequest(doc.querySelector(".cookie"));
    assert.equal(r.request, null);
    assert.equal(r.reason, "no-reject-control");
  });

  test("only dangerous controls: aborted", () => {
    const doc = load(`<!doctype html><body><div class="cookie">Cookies <button>Subscribe</button><button>Buy now</button></div></body>`);
    assert.equal(candidates.buildRequest(doc.querySelector(".cookie")).reason, "only-dangerous-controls");
  });

  test("multilingual danger list drops controls", () => {
    const doc = load(`<!doctype html><body><div class="cookie">Cookies
      <button>Jetzt kaufen</button><button>S'abonner</button><button>Iniciar sesión</button><button>Alle ablehnen</button></div></body>`);
    const { request } = candidates.buildRequest(doc.querySelector(".cookie"));
    assert.deepEqual(request.candidates.map((c) => c.text), ["Alle ablehnen"]);
    assert.equal(request.candidates[0].id, "c1");
  });

  test("subframe and lang sanitising", () => {
    const doc = load(`<!doctype html><html lang="de-DE"><body><div class="c">Cookies <button>Ablehnen</button></div></body></html>`);
    const { request } = candidates.buildRequest(doc.querySelector(".c"), { frame: "sub" });
    assert.equal(request.page.frame, "sub");
    assert.equal(request.page.lang, "de-DE");
    assert.equal(candidates.sanitizeLang("<script>"), "");
  });

  test("end to end with the detector", () => {
    const doc = load("banner-de.html");
    const best = detect.findBestContainer(doc);
    const { request } = candidates.buildRequest(best.element);
    assert.deepEqual(request.candidates.map((c) => c.text), ["Alle akzeptieren", "Nur notwendige Cookies", "Einstellungen"]);
  });
});
