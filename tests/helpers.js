"use strict";
// Shared test helpers (not a test file: node --test only runs *.test.js here).
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const RESOURCES = path.join(__dirname, "..", "Cookies", "Shared (Extension)", "Resources");
const LIB = path.join(RESOURCES, "lib");

const lib = (name) => require(path.join(LIB, name));

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
}

/** Parse a fixture (or raw HTML) into a jsdom Document. */
function load(nameOrHtml, { url = "https://www.example.com/page", runScripts } = {}) {
  const html = nameOrHtml.endsWith(".html") ? fixture(nameOrHtml) : nameOrHtml;
  const jsdom = new JSDOM(html, { url, pretendToBeVisual: true, runScripts });
  return jsdom.window.document;
}

/** Record ids (or text) of every element that receives a click. */
function recordClicks(doc) {
  const clicks = [];
  doc.addEventListener(
    "click",
    (e) => {
      const target = e.composedPath()[0];
      clicks.push(target.id || target.textContent.trim());
    },
    true,
  );
  return clicks;
}

module.exports = { RESOURCES, LIB, lib, fixture, load, recordClicks };
