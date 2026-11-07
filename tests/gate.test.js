"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { lib, load } = require("./helpers.js");

const gate = lib("gate.js");
const candidates = lib("candidates.js");

function setup() {
  const doc = load("banner-fixed.html");
  const container = doc.querySelector(".notice-bar");
  const built = candidates.buildRequest(container);
  // banner-fixed: c1 Accept all, c2 Reject all, c3 Cookie settings
  const result = { type: "identifyRejectControlResult", version: 1, status: "ok", candidateId: "c2", confidence: "high", reason: "Reject all declines optional cookies", engine: "foundation-models" };
  const state = { clicked: false, enabled: true, hostDisabled: false };
  return { doc, container, ...built, result, state };
}

describe("safety gate", () => {
  test("accepts the good case", () => {
    const s = setup();
    const v = gate.shouldClick(s.result, s.map, s.container, s.snapshot, s.state);
    assert.equal(v.ok, true, v.reason);
    assert.equal(v.element.textContent, "Reject all");
  });

  const failures = {
    "null result": (s) => [null],
    "status none": (s) => [{ ...s.result, status: "none", candidateId: null }],
    "status uncertain": (s) => [{ ...s.result, status: "uncertain" }],
    "status not-consent": (s) => [{ ...s.result, status: "not-consent" }],
    "status unavailable": (s) => [{ ...s.result, status: "unavailable" }],
    "status error": (s) => [{ ...s.result, status: "error" }],
    "wrong type": (s) => [{ ...s.result, type: "somethingElse" }],
    "medium confidence": (s) => [{ ...s.result, confidence: "medium" }],
    "unknown id": (s) => [{ ...s.result, candidateId: "c9" }],
    "malformed id": (s) => [{ ...s.result, candidateId: "#reject" }],
    "missing map": (s) => [s.result, null],
    "already clicked": (s) => [s.result, s.map, s.container, s.snapshot, { ...s.state, clicked: true }],
    "disabled globally": (s) => [s.result, s.map, s.container, s.snapshot, { ...s.state, enabled: false }],
    "disabled for host": (s) => [s.result, s.map, s.container, s.snapshot, { ...s.state, hostDisabled: true }],
    "missing state": (s) => [s.result, s.map, s.container, s.snapshot, null],
    "missing snapshot": (s) => [s.result, s.map, s.container, null],
    "element detached": (s) => {
      s.map.get("c2").remove();
      return [s.result];
    },
    "container detached": (s) => {
      s.container.remove();
      return [s.result];
    },
    "element moved out of container": (s) => {
      s.doc.body.append(s.map.get("c2"));
      return [s.result];
    },
    "element hidden": (s) => {
      s.map.get("c2").style.display = "none";
      return [s.result];
    },
    "element disabled": (s) => {
      s.map.get("c2").disabled = true;
      return [s.result];
    },
    "text changed": (s) => {
      s.map.get("c2").textContent = "Reject all and subscribe";
      return [s.result];
    },
    "aria changed": (s) => {
      s.map.get("c2").setAttribute("aria-label", "Accept all");
      return [s.result];
    },
    "model chose the accept button": (s) => [{ ...s.result, candidateId: "c1" }],
    "model chose cookie settings": (s) => [{ ...s.result, candidateId: "c3" }],
  };

  for (const [name, mutate] of Object.entries(failures)) {
    test(`refuses: ${name}`, () => {
      const s = setup();
      const args = mutate(s);
      const [result, map = s.map, container = s.container, snapshot = s.snapshot, state = s.state] = args;
      const v = gate.shouldClick(result, args.length >= 2 ? map : s.map, container, args.length >= 4 ? snapshot : s.snapshot, args.length >= 5 ? state : s.state);
      assert.equal(v.ok, false);
      assert.equal(typeof v.reason, "string");
    });
  }
});

describe("label matchers", () => {
  const rejects = [
    "Reject all", "Decline", "Deny", "Refuse all", "I disagree", "No thanks", "Continue without accepting",
    "Use necessary cookies only", "Only allow essential cookies", "Accept only necessary", "Necessary only",
    "Alle ablehnen", "Nur notwendige Cookies", "Tout refuser", "Continuer sans accepter", "Rechazar todo",
    "Rifiuta tutto", "Weigeren", "Avvisa alla", "Odrzuć wszystkie", "Odmítnout vše", "Hylkää kaikki",
    "Je n’accepte pas", "すべて拒否", "Do not consent",
  ];
  const accepts = ["Accept all", "I agree", "Allow all", "OK", "Got it", "Continue", "Yes", "Alle akzeptieren", "Tout accepter", "Aceptar", "Accetta tutto", "Akkoord"];
  const dangers = ["Buy now", "Subscribe", "Sign in", "Log in", "Delete account", "Submit application", "Jetzt kaufen", "Se connecter", "Download", "Confirm my choices", "Job offers"];
  const neutral = ["Cookie settings", "Manage preferences", "Learn more", "Necessary cookies", "Rejection letter template", "Declined payments FAQ"];

  for (const s of rejects) test(`reject: ${s}`, () => assert.equal(gate.isRejectLabel(s), true));
  for (const s of accepts) {
    test(`accept: ${s}`, () => {
      assert.equal(gate.isRejectLabel(s), false);
      assert.equal(gate.isAcceptOnlyLabel(s), true);
    });
  }
  for (const s of dangers) test(`danger: ${s}`, () => assert.equal(gate.matchesDanger(s), true));
  for (const s of neutral) test(`neutral: ${s}`, () => assert.equal(gate.isRejectLabel(s), false));

  test("aria cannot launder an accept label", () => {
    assert.equal(gate.isRejectLabel("Accept all", "Reject all"), false);
    assert.equal(gate.isRejectLabel("", "Reject all"), true);
    assert.equal(gate.isRejectLabel("Reject", "Accept"), false);
  });

  test("danger wins over reject", () => {
    assert.equal(gate.isRejectLabel("Decline and subscribe"), false);
  });
});
