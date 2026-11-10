<img src="assets/icon.svg" width="64" height="64" alt="">

# Cookies

A Safari extension for macOS and iOS that presses **Reject all** on cookie-consent banners for you.
It uses deterministic rules for the consent platforms it knows, and Apple's on-device Foundation Models
for the ones it doesn't. Nothing leaves your device.

## How it works

1. **Rules first.** The content script checks the page for well-known consent-management platforms
   (OneTrust, Cookiebot, Didomi, Quantcast, TrustArc, Sourcepoint, Usercentrics, CookieYes, Klaro,
   Osano, Complianz, Iubenda, Termly and many more) and clicks their reject control directly. No model
   inference is involved.
2. **On-device model for the rest.** If no rule matches, the script looks for a plausible consent
   overlay, builds a minimal description of its buttons (visible text, a few attributes, opaque ids
   `c1…cN`), and hands that to the native app extension. The native side asks the system language model,
   through the Foundation Models framework, to pick the control that rejects optional cookies. The answer
   is structured generation constrained to the candidate id set plus `none`, so the model can only
   return an id that exists, never arbitrary JavaScript.
3. **Fail closed.** The native side only answers `ok` if the model says the overlay is a cookie banner,
   is highly confident, and the chosen control's own text reads like "reject" and not like "accept" or
   anything risky (pay, submit, apply, delete, sign in…). The content script then re-checks that the
   element is still there, still visible, still inside the same overlay, and unchanged, before it clicks
   once. One model request per page load, one click per page. If anything is uncertain it does nothing.
4. **Private by design.** The extension has no network permission and makes no requests. Inference runs
   in Apple's sandboxed app extension on the device. Only the trimmed candidate list described above is
   ever passed from the page to the native side.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the message contract and the full safety rules.

## Requirements

- macOS 14 / iOS 17 or later for the extension and the rule-based layer.
- macOS 26 / iOS 26 or later with Apple Intelligence enabled for the on-device model layer. On earlier
  systems, or when Apple Intelligence is off, only the rules run and the model layer reports "unavailable".
- Xcode 27 to build.

## Build and run

```sh
open Cookies/Cookies.xcodeproj
```

Pick the **Cookies (macOS)** scheme, set your signing team, and run. The container app reports whether
the Safari extension is enabled and whether the on-device model is available. Enable the extension in
Safari → Settings → Extensions. While developing with an ad-hoc signature, turn on
Safari → Develop → Allow Unsigned Extensions.

To build, sign with your Apple Development certificate, and install to /Applications in one step:

```sh
scripts/install-macos.sh
```

To build, sign, install and launch on a connected iPhone (the first paired one, or pass a UDID):

```sh
scripts/install-ios.sh [team-id] [device-udid]
```

Then turn on Cookies in Settings → Apps → Safari → Extensions and allow it on all websites.

Command-line build (no signing):

```sh
xcodebuild -project Cookies/Cookies.xcodeproj -scheme "Cookies (macOS)" \
  -configuration Debug CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO build
```

## Tests

```sh
# Web extension (rules engine, banner detection, candidate extraction, safety gate, background router)
npm install && npm test

# Native logic (request validation, lexicon, prompt, decision policy, service)
cd Cookies/CookiesCore && swift test
```

## Layout

```
Cookies/Shared (Extension)/Resources/   the web extension (manifest, content/background scripts, popup, lib/)
Cookies/Shared (Extension)/SafariWebExtensionHandler.swift
Cookies/CookiesCore/                    Swift package: validation, prompt, schema, Foundation Models engine, policy
Cookies/Shared (App)/, macOS (App)/, iOS (App)/   container app
tests/                                  Node tests (node:test + jsdom)
docs/ARCHITECTURE.md
```

Inspired by [Omar Shahine's post](https://x.com/OmarShahine/status/2117025022527300047).
