# Cookies — architecture and message contract

Cookies is a Safari Web Extension (macOS and iOS) that automatically presses the
"reject all" control on cookie-consent banners. It has two layers and a strict
safety gate. Nothing ever leaves the device.

```
┌──────────────────────────────── Safari tab ───────────────────────────────┐
│ content.js (every frame)                                                  │
│   1. Layer 1: CMP rules (lib/rules.js) → deterministic click, no model    │
│   2. Layer 2: find consent container → build candidate list → ask native  │
│   3. Safety gate: validate returned id, re-check element, click           │
└───────────────┬───────────────────────────────────────────────────────────┘
                │ browser.runtime.sendMessage
┌───────────────▼───────────────────────────────────────────────────────────┐
│ background.js (service worker / background page)                          │
│   settings, per-tab status for the popup, forwards classify requests via  │
│   browser.runtime.sendNativeMessage                                       │
└───────────────┬───────────────────────────────────────────────────────────┘
                │ SFExtensionMessageKey (NSExtensionItem.userInfo)
┌───────────────▼───────────────────────────────────────────────────────────┐
│ SafariWebExtensionHandler.swift (native app extension, sandboxed)         │
│   CookiesCore: prompt building, FoundationModels session, dynamic schema  │
│   constrained to candidate ids, post-validation, fail-closed defaults     │
└───────────────────────────────────────────────────────────────────────────┘
```

## Layer 1 — known consent-management platforms (CMPs)

`lib/rules.js` exports an ordered array of rules. Each rule:

```js
{
  id: "onetrust",                     // stable slug
  name: "OneTrust",
  detect: ["#onetrust-banner-sdk"],   // any selector matching ⇒ CMP present
  reject: ["#onetrust-reject-all-handler"], // first visible match is clicked
  // optional multi-step flow for CMPs that hide "reject all" behind a settings view
  steps: [
    { click: ["#truste-show-consent"], waitFor: ["#truste-consent-track"] },
    { click: ["#truste-consent-required"] }
  ],
  frames: "any" | "top",              // where the rule may run (default "any")
  shadow: ["#usercentrics-root"]      // shadow hosts to search inside (optional)
}
```

Rules must only ever point at controls that reject/decline/deny optional
cookies (or "necessary only"). Never at "accept", "agree", "save" without
first disabling toggles, or anything unrelated to consent.

## Layer 2 — unknown banners, on-device model

### Finding the consent container (content.js)

A candidate container must satisfy all of:

- positioned `fixed` or `sticky`, or `role="dialog"`/`alertdialog`, or `aria-modal`, or a `<dialog>`;
  or an in-flow block that is named as a cookie/consent element (id, class, aria-label, data-module)
  or carries a landmark role, sits within 150 px of the page top or the viewport bottom, and is no
  taller than 60 % of the viewport (role-only in-flow blocks must be direct children of `body`);
- visible, non-trivial size, high stacking (z-index ≥ 10 or a direct child of body/html);
- its visible text (max 2 000 chars considered) contains at least one cookie/consent keyword
  (multilingual list: cookie, cookies, consent, consentement, einwilligung, privacy, privacidad,
  datenschutz, GDPR, DSGVO, RGPD, tracking, "your choices", "we value your privacy", etc.);
- contains at least 1 and at most 12 button-like controls;
- contains **no** `input[type=password]`, `input[type=email]` with a submit, credit-card
  fields (`autocomplete=cc-*`), `<form method=post>` with text inputs, or file inputs.

A consent UI drawn into a same-origin inline frame (`srcdoc` or `about:blank`, as AppConsent does)
is handled from the parent document: the fixed `<iframe>` is the container and the composed-tree
walk (text, buttons, containment, visibility) continues inside its document, exactly as it does for
open shadow roots. Frames with a real `src` are left to their own content script.

Pick the best-scoring container. If none scores above the threshold, do nothing.

### Candidate controls

Button-like: `button`, `[role=button]`, `input[type=button|submit]`, `a` whose `href` is
empty, `#`, `javascript:` or same-document, and elements with `onclick`/`tabindex=0` that
look clickable. Each candidate gets an opaque id `c1…cN` (assigned by the content script
in document order and kept in a `Map<id, Element>` for this one request only).

Per candidate, send: `id`, `tag`, `text` (visible text, trimmed, ≤ 80 chars), `aria`
(aria-label / title, ≤ 80), `attrs` (`id`, `class`, `name`, `data-*` keys only, each ≤ 60
chars, max 6 attrs), `role`, `disabled`.

Layer 2 is only attempted when at least one candidate's own label reads as a reject control
(the native policy would refuse anything else, so asking the model would be wasted work and
would send page text out of the page for nothing).

Candidates whose text matches the **danger list** (case-insensitive, multilingual) are
dropped before sending: buy, pay, checkout, order, purchase, subscribe, unsubscribe,
submit, send, apply, sign in, sign up, log in, login, register, delete, remove, confirm,
cancel order, cancel subscription, download, install, upload, share, post, reply,
transfer, withdraw, donate, "job", "offer", "application".

### Message: extension → native

```json
{
  "type": "identifyRejectControl",
  "version": 1,
  "page": { "host": "example.com", "lang": "en", "frame": "top" | "sub" },
  "container": {
    "tag": "div",
    "role": "dialog",
    "text": "We use cookies to improve your experience … (≤ 600 chars)",
    "attrs": { "id": "cookie-banner", "class": "cb-root" }
  },
  "candidates": [
    { "id": "c1", "tag": "button", "text": "Accept all", "aria": "", "attrs": { "class": "cb-btn primary" }, "role": "", "disabled": false },
    { "id": "c2", "tag": "button", "text": "Reject all", "aria": "", "attrs": { "class": "cb-btn" }, "role": "", "disabled": false },
    { "id": "c3", "tag": "a",      "text": "Cookie settings", "aria": "", "attrs": { "class": "cb-link" }, "role": "", "disabled": false }
  ]
}
```

### Message: native → extension

```json
{
  "type": "identifyRejectControlResult",
  "version": 1,
  "status": "ok" | "none" | "not-consent" | "uncertain" | "unavailable" | "error",
  "candidateId": "c2" | null,
  "confidence": "high" | "medium" | "low" | null,
  "reason": "short human-readable explanation",
  "engine": "foundation-models" | "none"
}
```

`status = "ok"` is the only status on which the content script may click.
`candidateId` is non-null only when `status = "ok"`.

### Native decision pipeline (CookiesCore)

1. Decode and validate the request (version, ≤ 12 candidates, string lengths, ids match `^c\d{1,2}$`).
2. If `SystemLanguageModel.default.availability != .available` → `status: "unavailable"`.
3. Build a `DynamicGenerationSchema` whose `rejectControlId` property is `anyOf:` the request's
   candidate ids **plus** the sentinel `"none"`. The model physically cannot emit an unknown id.
   Also: `isCookieConsentBanner: Bool`, `confidence: anyOf ["high","medium","low"]`,
   `reason: String`.
4. One `LanguageModelSession` per request, with fixed instructions (see `Prompt.swift`),
   `GenerationOptions(sampling: .greedy, temperature: 0, maximumResponseTokens: ~120)`.
5. Post-validate (fail closed, every check must pass):
   - `isCookieConsentBanner == true`
   - `rejectControlId` ≠ `"none"` and ∈ request ids
   - `confidence == "high"`
   - the chosen candidate's text/aria does **not** match an *accept* pattern (accept, agree,
     allow all, ok, got it, i understand, continue, yes, enable, …) and does not match the
     danger list.
   - the chosen candidate's text/aria **does** match a *reject-ish* pattern (reject, decline,
     deny, refuse, disagree, no thanks, only necessary, essential only, continue without,
     ablehnen, refuser, rechazar, rifiuta, weigeren, avvisa, odrzuć, …) — or the model's reason
     mentions it is the "necessary only" option and the text contains "necessary"/"essential"/
     "required".
   Any failure → `status: "uncertain"` (or `"not-consent"` / `"none"`), never `"ok"`.
6. Map `GenerationError`s to `status: "error"` with a terse reason; never throw out of
   `beginRequest`.
7. Timeouts nest from the inside out: the native service answers within 12 s (`status: "error",
   reason: "timeout"`), the background script gives up on the native reply after 15 s, so the
   extension always receives an explicit non-`ok` reply rather than a dangling promise.

### Content-script safety gate (after the reply)

Click only if **all** hold:

- `status == "ok"` and `candidateId` is in this request's `Map`;
- the element is still connected, visible, enabled, and still inside the same container
  (a transparent native control laid over a sibling that shows the same label, as on Amazon,
  counts as visible: the user sees that label as the button);
- its visible text/aria is unchanged since the request;
- the content script has not clicked anything else on this document in this page load;
- the user has not disabled the extension globally or for this host.

Then report the outcome and dispatch a real `click()` (the report goes first because some sites
navigate or tear the frame down on the click itself); wait up to 3 s for the container to
disappear and record `not-verified` if it does not. Inside an iframe, a collapsed viewport or a
control that no longer intersects the top-level viewport counts as disappeared, since the parent
hides the whole frame and this document cannot see that directly. At most **one** model request per document per page load; a second banner is left
alone. Observe DOM mutations for up to 30 s after `document_idle` to catch late banners (CMP
scripts on a cold load can take well over 10 s), then stop observing.

## Extension ↔ background ↔ popup messages

```
content → background : { type: "classify", request: <identifyRejectControl payload> }
background → content : <identifyRejectControlResult>   (reply)
content → background : { type: "status", status: { outcome: "rejected"|"skipped"|"none"|"error",
                         layer: "rules"|"model"|null, cmp: "onetrust"|null, reason: "..." } }
content → background : { type: "getSettings" } → { active, settings, hostDisabled }
popup → background   : { type: "getStatus", tabId }  → { settings, tab: { host, status } }
popup → background   : { type: "setSettings", settings: { enabled: Bool, disabledHosts: [String] } }
background → native  : identifyRejectControl ;  native → background : identifyRejectControlResult
```

Settings live in `browser.storage.local` under `settings`.

## Privacy

- No network permission, no `host_permissions` beyond content-script matching, no fetch.
- Only the minimal candidate representation above is sent to the native handler, which runs
  in Apple's app-extension sandbox and uses `FoundationModels` on device only. The extension is sandboxed
  without the outgoing-network entitlement. The container app keeps that entitlement only because
  a sandboxed WKWebView cannot render even its bundled local page without it; the app makes no
  requests.
- Nothing is logged persistently; `os_log` debug lines contain no page text in Release.

## Repository layout

```
Cookies/                              Xcode project (generated by safari-web-extension-converter, Xcode 27 JSON format)
  Cookies.xcodeproj/project.xcproj
  Shared (Extension)/Resources/       the web extension (manifest.json, content.js, background.js, popup.*, lib/)
  Shared (Extension)/SafariWebExtensionHandler.swift
  CookiesCore/                        Swift package: pure logic + FoundationModels adapter + XCTest
  Shared (App)/, macOS (App)/, iOS (App)/   container app
tests/                                Node tests (node:test + jsdom) for the web extension
package.json
docs/ARCHITECTURE.md                  this file
```
