/*
 * lib/rules.js — Layer 1: deterministic rules for known consent-management
 * platforms (CMPs). Pure data; the generic engine lives in lib/cmp.js.
 *
 * Rule shape (see docs/ARCHITECTURE.md):
 *   id, name          stable slug and display name
 *   detect            any selector matching (visible or not) => CMP present
 *   banner            optional: selectors whose visibility means the banner is
 *                     showing; multi-step flows only start when one is visible
 *                     (defaults to `detect`)
 *   reject            first *visible*, enabled match is clicked (may be omitted
 *                     when the rule is steps-only)
 *   steps             optional multi-step flow when no direct reject is visible:
 *                     [{ click, waitFor?, optional? }]; the last non-optional
 *                     click is the reject. `probe: true` additionally requires
 *                     the final target to already exist in the DOM (hidden is
 *                     fine) before the flow starts.
 *   frames            "any" (default) or "top"
 *   shadow            shadow hosts whose open shadow roots are also searched
 *
 * A selector entry is either a CSS string or { selector, text?, host? }:
 *   text: "reject"    the element's label must pass gate.isRejectLabel
 *   text: RegExp      the element's label must match
 *   host: "css"       search only inside that host's shadow root
 *
 * SAFETY: every `reject` target and final step must be a control that rejects
 * / declines / denies optional cookies or keeps "necessary only". Never accept,
 * agree, or save without disabling first. The engine additionally refuses any
 * target whose label reads as accept-only.
 */
"use strict";

(() => {
  const NS = (() => {
    if (globalThis.__cookies) return globalThis.__cookies;
    const ns = {};
    try {
      Object.defineProperty(globalThis, "__cookies", { value: ns, configurable: true, writable: false, enumerable: false });
    } catch {
      globalThis.__cookies = ns;
    }
    return ns;
  })();

  const R = "reject"; // shorthand: label must read as a reject control

  const rules = [
    {
      id: "onetrust",
      name: "OneTrust",
      detect: ["#onetrust-banner-sdk", "#onetrust-consent-sdk"],
      banner: ["#onetrust-banner-sdk"],
      reject: ["#onetrust-reject-all-handler", "#onetrust-pc-sdk .ot-pc-refuse-all-handler"],
      // Variant without a banner-level reject: open the preference centre and
      // use its "Reject all". The preference centre markup ships with the SDK,
      // so `probe` avoids opening it on sites that have no reject-all at all.
      steps: [
        { click: ["#onetrust-pc-btn-handler", "#onetrust-banner-sdk .ot-sdk-show-settings"], waitFor: ["#onetrust-pc-sdk .ot-pc-refuse-all-handler"] },
        { click: ["#onetrust-pc-sdk .ot-pc-refuse-all-handler"] },
      ],
      probe: true,
      frames: "any",
    },
    {
      id: "cookiebot",
      name: "Cookiebot",
      detect: ["#CybotCookiebotDialog"],
      reject: ["#CybotCookiebotDialogBodyButtonDecline", "#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll"],
      frames: "any",
    },
    {
      id: "quantcast",
      name: "Quantcast Choice",
      detect: ["#qc-cmp2-container", ".qc-cmp2-container"],
      banner: ["#qc-cmp2-ui"],
      // Button classes are shared between "Disagree" and "More options", so
      // the label must read as a reject.
      reject: [
        { selector: "#qc-cmp2-ui .qc-cmp2-summary-buttons button", text: R },
        { selector: "#qc-cmp2-ui .qc-cmp2-footer button", text: R },
      ],
      frames: "any",
    },
    {
      id: "didomi",
      name: "Didomi",
      detect: ["#didomi-host", "#didomi-notice"],
      banner: ["#didomi-notice", "#didomi-popup", ".didomi-popup-notice"],
      reject: ["#didomi-notice-disagree-button", ".didomi-continue-without-agreeing", { selector: "#didomi-popup .didomi-consent-popup-actions button", text: R }],
      // Variant that hides "Disagree to all" behind "Learn more"/"Settings".
      steps: [
        { click: ["#didomi-notice-learn-more-button"], waitFor: [{ selector: "#didomi-popup button", text: R }] },
        { click: [{ selector: "#didomi-popup .didomi-consent-popup-actions button", text: R }, { selector: "#didomi-popup button", text: R }] },
        // Some versions only toggle everything off; save the (all-off) choice.
        { click: [{ selector: "#didomi-popup .didomi-consent-popup-actions button", text: /save|enregistrer|speichern|guardar|salva|opslaan/i }], optional: true },
      ],
      frames: "any",
    },
    {
      id: "trustarc",
      name: "TrustArc",
      detect: ["#truste-consent-track", "#truste-consent-content"],
      banner: ["#truste-consent-track", "#truste-consent-content", "#trustarc-banner-overlay"],
      reject: ["#truste-consent-required"],
      // Two-step: the banner only offers "Cookie preferences"; the new consent
      // manager then offers "Decline all".
      steps: [
        { click: ["#truste-show-consent"], waitFor: ['.trustarc_newcm_container button[data-button-key="decline_all"]'] },
        { click: ['.trustarc_newcm_container button[data-button-key="decline_all"]'] },
      ],
      frames: "top",
    },
    {
      id: "trustarc-cm",
      name: "TrustArc",
      detect: [".truste_popframe.trustarc_newcm_container", ".trustarc_newcm_container", "#trustarc-pc"],
      reject: [
        '.trustarc_newcm_container button[data-button-key="decline_all"]',
        ".trustarc_newcm_container button.required",
        ".trustarc_newcm_container a.required",
      ],
      frames: "any",
    },
    {
      id: "sourcepoint",
      name: "Sourcepoint",
      // Runs inside the Sourcepoint message iframe (content scripts run in all frames).
      detect: ['[class*="sp_choice_type_"]', ".message-container .message-button"],
      reject: [
        ".sp_choice_type_13",
        ".sp_choice_type_REJECT_ALL",
        { selector: 'button[title="Reject All"]', text: R },
        { selector: 'button[title="Reject all"]', text: R },
        // Publisher-worded messages (Sky: "Essential cookies only") use other
        // choice types; fall back to any message button whose label rejects.
        { selector: 'button.message-button, .message-component.message-button, [class*="sp_choice_type_"]', text: R },
      ],
      frames: "any",
    },
    {
      id: "usercentrics",
      name: "Usercentrics",
      detect: ["#usercentrics-root", "#usercentrics-cmp-ui", "#usercentrics-button"],
      shadow: ["#usercentrics-root", "#usercentrics-cmp-ui"],
      reject: [
        '[data-testid="uc-deny-all-button"]',
        "#usercentrics-button #uc-btn-deny-banner",
        { selector: "button#deny, button.uc-deny-button, button[data-action-type=\"deny\"]", text: R, host: "#usercentrics-cmp-ui" },
      ],
      frames: "any",
    },
    {
      id: "cookieyes",
      name: "CookieYes",
      detect: [".cky-consent-container", ".cky-consent-bar"],
      reject: ['.cky-consent-container [data-cky-tag="reject-button"]', ".cky-btn-reject"],
      frames: "any",
    },
    {
      id: "klaro",
      name: "Klaro",
      detect: [".klaro .cookie-notice", ".klaro .cookie-modal"],
      reject: [".klaro .cn-decline", ".klaro .cm-btn-decline"],
      frames: "any",
    },
    {
      id: "osano",
      name: "Osano",
      detect: [".osano-cm-window"],
      banner: [".osano-cm-dialog:not(.osano-cm-dialog--hidden)"],
      reject: [".osano-cm-denyAll", ".osano-cm-dialog .osano-cm-deny"],
      frames: "any",
    },
    {
      id: "complianz",
      name: "Complianz",
      detect: ["#cmplz-cookiebanner-container", ".cmplz-cookiebanner"],
      reject: [".cmplz-cookiebanner .cmplz-deny"],
      frames: "any",
    },
    {
      id: "iubenda",
      name: "iubenda",
      detect: ["#iubenda-cs-banner"],
      reject: [".iubenda-cs-reject-btn"],
      frames: "any",
    },
    {
      id: "termly",
      name: "Termly",
      detect: ["#termly-code-snippet-support", '[data-tid="banner-decline"]'],
      reject: ['[data-tid="banner-decline"]', ".t-declineAllButton"],
      frames: "any",
    },
    {
      id: "civic",
      name: "Civic Cookie Control",
      detect: ["#ccc", "#ccc-module", "#ccc-notify"],
      reject: ["#ccc-reject-settings", "#ccc-notify-reject", ".ccc-reject-button"],
      frames: "any",
    },
    {
      id: "consentmanager",
      name: "consentmanager.net",
      detect: ["#cmpbox", "#cmpwrapper", "#ncmp__tool .ncmp__banner"],
      shadow: ["#cmpwrapper"],
      reject: [".cmpboxbtnno", "#cmpwelcomebtnno a", "#cmpwelcomebtnno", { selector: "#ncmp__tool .ncmp__banner button", text: R }],
      frames: "any",
    },
    {
      id: "funding-choices",
      name: "Google Funding Choices",
      detect: [".fc-consent-root"],
      reject: [".fc-cta-do-not-consent"],
      frames: "any",
    },
    {
      id: "hubspot",
      name: "HubSpot",
      detect: ["#hs-eu-cookie-confirmation"],
      reject: ["#hs-eu-decline-button"],
      frames: "any",
    },
    {
      id: "shopify",
      name: "Shopify",
      detect: ["#shopify-pc__banner"],
      reject: ["#shopify-pc__banner__btn-decline"],
      frames: "any",
    },
    {
      id: "borlabs",
      name: "Borlabs Cookie",
      detect: ["#BorlabsCookieBox", "._brlbs-block-content", ".brlbs-cmpnt-dialog"],
      // "Accept only essential cookies" is a necessary-only choice.
      reject: [".brlbs-btn-accept-only-essential", "a[data-cookie-refuse]"],
      frames: "any",
    },
    {
      id: "tarteaucitron",
      name: "tarteaucitron",
      detect: ["#tarteaucitronRoot"],
      banner: ["#tarteaucitronAlertBig"],
      reject: ["#tarteaucitronAllDenied2"],
      steps: [
        { click: ["#tarteaucitronPersonalize2", "#tarteaucitronPersonalize"], waitFor: ["#tarteaucitronAllDenied"] },
        { click: ["#tarteaucitronAllDenied"] },
        { click: ["#tarteaucitronClosePanel"], optional: true },
      ],
      probe: true,
      frames: "any",
    },
    {
      id: "cookieinformation",
      name: "Cookie Information",
      detect: ["#cookie-information-template-wrapper", "#coiOverlay"],
      reject: [
        "#cookie-information-template-wrapper #declineButton",
        "#coiOverlay #declineButton",
        ".coi-banner__decline",
        { selector: "#coiOverlay button", text: R },
      ],
      frames: "any",
    },
    {
      id: "axeptio",
      name: "Axeptio",
      detect: [".axeptio_widget", ".axeptio_mount"],
      shadow: [".axeptio_mount .needsclick", ".axeptio_mount"],
      // "No thanks" / "Non merci"
      reject: ["button#axeptio_btn_dismiss", "button.ax-discardButton"],
      frames: "any",
    },
    {
      id: "cookiefirst",
      name: "CookieFirst",
      detect: ["#cookiefirst-root", ".cookiefirst-root"],
      reject: ['button[data-cookiefirst-action="reject"]', "#btnRejectAllCookies"],
      frames: "any",
    },
    {
      id: "moove",
      name: "Moove GDPR",
      detect: ["#moove_gdpr_cookie_info_bar"],
      banner: ["#moove_gdpr_cookie_info_bar:not(.moove-gdpr-info-bar-hidden)"],
      reject: [".moove-gdpr-infobar-reject-btn"],
      frames: "any",
    },
    {
      id: "wp-gdpr-cookie-consent",
      name: "GDPR Cookie Consent (WordPress)",
      detect: ["#cookie-law-info-bar", "#cliSettingsPopup"],
      reject: ["#cookie_action_close_header_reject", ".cookie_action_close_header_reject", '.cli_action_button[data-cli_action="reject"]'],
      frames: "any",
    },
    {
      id: "piwik-pro",
      name: "Piwik PRO",
      detect: ["#ppms_cm_popup_overlay", "#PiwikPROConsentForm-container"],
      reject: ["#ppms_cm_reject-all", "#ppms_cm_disagree", "#PiwikPROConsentForm-reject-all"],
      frames: "any",
    },
    {
      id: "ketch",
      name: "Ketch",
      detect: ["#lanyard_root", "#ketch-banner"],
      banner: ["#lanyard_root div[role='dialog']", "#ketch-banner"],
      reject: [{ selector: "#lanyard_root button, #ketch-banner button", text: R }],
      frames: "any",
    },
    {
      id: "transcend",
      name: "Transcend",
      detect: ["#transcend-consent-manager"],
      shadow: ["#transcend-consent-manager"],
      reject: [{ selector: "button", text: R, host: "#transcend-consent-manager" }],
      frames: "any",
    },
    {
      id: "securiti",
      name: "Securiti",
      // Securiti's banner reuses the open-source cookieconsent markup.
      detect: ['script[src*="securiti.ai" i]', ".f-cmp-flyout-wrapper"],
      reject: [".cc-window .cc-deny", { selector: ".cc-window .cc-btn", text: R }],
      frames: "any",
    },
    {
      id: "orejime",
      name: "Orejime",
      detect: [".orejime-Notice", ".orejime-Banner", ".orejime-banner-portal .fr-consent-banner"],
      reject: [".orejime-Notice-declineButton", ".orejime-Banner-declineButton", { selector: ".orejime-banner-portal .fr-consent-banner button", text: R }],
      frames: "any",
    },
    {
      id: "wix",
      name: "Wix",
      detect: ['[data-hook="ccsu-banner-wrapper"]', '[data-comp-type="cookie-banner-root-uou"]', '[data-comp-type="cookie-banner-root-wix"]'],
      reject: ['[data-hook="ccsu-banner-decline-all"]', '[data-hook="consent-banner-decline-all-button"]'],
      frames: "any",
    },
    {
      id: "squarespace",
      name: "Squarespace",
      detect: [".cookie-banner-mount-point"],
      reject: [".cookie-banner-mount-point button.decline"],
      frames: "any",
    },
    {
      id: "jimdo",
      name: "Jimdo",
      // Jimdo builds use hashed class names, so key off the platform and only
      // ever click a reject-labelled control inside a cookie-named container.
      detect: ['meta[name="generator"][content*="jimdo" i]', 'script[src*="jimdo" i]', 'link[href*="jimdo" i]'],
      reject: [{ selector: '[class*="cookie" i] button, [id*="cookie" i] button, [class*="cookie" i] [role="button"]', text: R }],
      frames: "top",
    },
    {
      id: "govuk",
      name: "GOV.UK cookie banner",
      // GOV.UK Design System banner (used across UK government services). It
      // is an in-flow block; after rejecting it shows a confirmation and a
      // "Hide cookie message" button, so the flow is: reject, then hide.
      detect: [".govuk-cookie-banner", "#global-cookie-message", '[data-module="cookie-banner"]'],
      banner: [".govuk-cookie-banner__message"],
      steps: [
        {
          click: [
            '.govuk-cookie-banner button[data-reject-cookies="true"]',
            '.govuk-cookie-banner button[value="reject"]',
            { selector: '.govuk-cookie-banner button, .govuk-cookie-banner input[type="submit"], .govuk-cookie-banner a.govuk-button', text: R },
          ],
        },
        { click: ['.govuk-cookie-banner button[data-hide-cookie-banner="true"]', { selector: ".govuk-cookie-banner button", text: /^\s*hide/i }], optional: true },
      ],
      frames: "top",
    },
    {
      id: "amazon",
      name: "Amazon",
      // Same markup on every Amazon storefront: a fixed <form role="dialog">
      // whose Accept/Decline are transparent submit inputs over styled labels.
      detect: ["#sp-cc", "#cos-banner", "#sp-cc-wrapper"],
      banner: ["#cos-banner", "#sp-cc"],
      reject: ["#sp-cc-rejectall-link", "#sp-cc-rejectall-container input", { selector: '#cos-banner input[type="submit"], #sp-cc input[type="submit"]', text: R }],
      frames: "top",
    },
    {
      id: "nhsuk",
      name: "NHS cookie banner",
      // nhsuk-frontend banner (NHS website and services). The reject button's
      // id ends in "link_accept", so match on the label rather than the id.
      detect: ["#nhsuk-cookie-banner", "#cookiebanner.nhsuk-cookie-banner"],
      banner: ["#cookiebanner.nhsuk-cookie-banner", "#nhsuk-cookie-banner .nhsuk-cookie-banner"],
      reject: [{ selector: "#nhsuk-cookie-banner button, #cookiebanner.nhsuk-cookie-banner button", text: R }],
      frames: "top",
    },
    {
      id: "twitch",
      name: "Twitch",
      detect: ['[data-a-target="consent-banner"]', '[data-a-target="consent-banner-accept"]'],
      banner: [".consent-banner", '[data-a-target="consent-banner"]'],
      reject: [{ selector: '.consent-banner button, [data-a-target="consent-banner"] button', text: R }],
      frames: "top",
    },
    {
      id: "appconsent",
      name: "AppConsent",
      // SFBX AppConsent (Le Figaro and other French publishers) renders in a
      // srcdoc iframe. The ".button__refuseAll" slot is sometimes a sign-in
      // link, so every target must read as a reject.
      detect: [".modal__banner .button__acceptAll", ".page__banner .banner__buttons", "button.button__openPrivacyCenter"],
      banner: [".modal__banner", ".page__banner"],
      reject: [{ selector: "button.button__skip, button.button__refuseAll", text: R }],
      frames: "any",
    },
    {
      id: "reddit",
      name: "Reddit",
      // The dialog and its buttons are light DOM slotted into shadow chrome.
      detect: ["#data-protection-consent-dialog", "reddit-cookie-banner", "[bundlename=reddit_cookie_banner]"],
      reject: [
        { selector: "#data-protection-consent-dialog rpl-modal-card > button.button-secondary", text: R },
        { selector: "#data-protection-consent-dialog button", text: R },
      ],
      frames: "any",
    },
    {
      id: "cookieconsent",
      name: "CookieConsent",
      // orestbida/cookieconsent v3 (and v2 as #cc--main)
      detect: ["#cc-main", "#cc--main"],
      reject: ['#cc-main .cm__btn[data-role="necessary"]', '#cc-main .pm__btn[data-role="necessary"]', "#cc--main #s-rall-bn"],
      steps: [
        { click: ['#cc-main .cm__btn[data-role="show"]'], waitFor: ['#cc-main .pm__btn[data-role="necessary"]'] },
        { click: ['#cc-main .pm__btn[data-role="necessary"]'] },
      ],
      banner: ["#cc-main .cm-wrapper", "#cc-main .cm"],
      frames: "any",
    },
    {
      id: "cookieconsent-legacy",
      name: "Cookie Consent",
      // Osano's legacy open-source cookieconsent (also used by Complianz/Securiti themes).
      detect: [".cc-window"],
      reject: [".cc-window .cc-deny"],
      frames: "any",
    },
  ];

  // Freeze deeply so a page script can never tamper with rules (and so tests
  // catch accidental mutation).
  const deepFreeze = (value) => {
    if (value && typeof value === "object" && !(value instanceof RegExp) && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const v of Object.values(value)) deepFreeze(v);
    }
    return value;
  };
  deepFreeze(rules);

  const api = Object.freeze({ rules });
  NS.rules = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
