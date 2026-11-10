"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { RESOURCES } = require("./helpers.js");

// Safari does not reliably decode extension scripts as UTF-8: the background
// script's "✓" badge rendered as "âœ“" on iOS. Keeping every script pure ASCII
// (non-ASCII written as \uXXXX escapes) makes the source decode identically
// under any charset, so multilingual labels like "odrzuć" still match.
function scripts(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return scripts(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

for (const file of scripts(RESOURCES)) {
  test(`${path.relative(RESOURCES, file)} is pure ASCII`, () => {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const offending = lines.flatMap((line, i) => (/[^\x00-\x7f]/.test(line) ? [`${i + 1}: ${line.trim()}`] : []));
    assert.deepEqual(offending, [], "write non-ASCII characters as \\uXXXX escapes");
  });
}
