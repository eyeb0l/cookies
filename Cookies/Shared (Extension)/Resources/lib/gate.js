/*
 * lib/gate.js - multilingual label matchers and the post-reply safety gate.
 *
 * The native side already validates the model's choice; everything here is a
 * second, independent check in the page (belt and braces). The gate fails
 * closed: any doubt means "do not click".
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
  const dom = typeof require === "function" ? require("./dom.js") : NS.dom;

  const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Compile a list of terms into one case-insensitive Unicode regexp.
   * - "term"   matches as a whole word/phrase (Unicode-aware boundaries);
   * - "term*"  matches words starting with "term";
   * - RegExp   is embedded verbatim (for structural patterns);
   * - CJK/Thai terms have no word boundaries (those scripts don't use spaces).
   */
  function compileTerms(terms) {
    const parts = terms.map((term) => {
      if (term instanceof RegExp) return `(?<![\\p{L}\\p{N}])(?:${term.source})`;
      const prefix = term.endsWith("*");
      const body = dom
        .normalizeText(prefix ? term.slice(0, -1) : term)
        .toLowerCase()
        .split(" ")
        .map((w) => escapeRegExp(w).replace(/'/g, "'?"))
        .join("[\\s\\-]+");
      if (CJK.test(body)) return `(?:${body})`;
      return `(?<![\\p{L}\\p{N}])(?:${body})${prefix ? "[\\p{L}\\p{N}]*" : "(?![\\p{L}\\p{N}])"}`;
    });
    return new RegExp(parts.join("|"), "iu");
  }

  /** Matching is always done on normalised, lower-cased text. */
  function prep(text) {
    return dom.normalizeText(text).toLowerCase();
  }

  // Labels that reject / decline optional cookies, or choose "necessary only".
  const REJECT_TERMS = [
    // English
    "reject", "reject all", "rejects", "decline", "decline all", "deny", "deny all", "refuse", "refuse all",
    "disagree", "i disagree", "disagree to all", "disagree and close", "no thanks", "no, thanks", "no thank you",
    "continue without accepting", "continue without agreeing", "continue without consent", "continue without",
    "proceed without accepting", "do not accept", "don't accept", "do not consent", "don't consent",
    "do not agree", "don't agree", "do not allow", "don't allow", "disallow", "opt out", "opt-out", "object to all",
    "necessary cookies only", "essential cookies only", "required cookies only", "strictly necessary only",
    /(?:only|just)\s+(?:allow\s+|accept\s+|use\s+)?(?:the\s+)?(?:strictly\s+)?(?:necessary|essential|required|functional|technical)/,
    /(?:necessary|essential|required|technical)(?:\s+cookies)?\s+only/,
    // German
    "ablehnen", "alle ablehnen", "alles ablehnen", "ablehnen*", "lehne ab", "verweigern", "nicht zustimmen",
    "nicht einverstanden", "nein danke", "weiter ohne*", "ohne zustimmung*", "nur notwendige*", "nur erforderliche*",
    "nur essenzielle*", "nur essentielle*", "nur technisch notwendige*", "nur funktionale*", "notwendige cookies verwenden",
    // French
    "refuser", "tout refuser", "je refuse", "refusez*", "rejeter", "tout rejeter", "continuer sans accepter",
    "continuer sans", "non merci", "je n'accepte pas", "pas d'accord", "uniquement les cookies n\u00e9cessaires",
    "n\u00e9cessaires uniquement", "strictement n\u00e9cessaires uniquement", "seulement les n\u00e9cessaires", "refuser tout",
    // Spanish / Catalan
    "rechazar", "rechazar todo", "rechazar todas", "rechazo", "denegar", "no acepto", "no aceptar",
    "solo necesarias", "s\u00f3lo necesarias", "solo las necesarias", "solo cookies necesarias", "continuar sin aceptar",
    "no, gracias", "no gracias", "rebutjar",
    // Italian
    "rifiuta", "rifiuta tutto", "rifiuta tutti", "rifiutare", "rifiuto", "non accetto", "solo necessari",
    "solo i necessari", "continua senza accettare", "nega", "nega tutto",
    // Dutch
    "weigeren", "alles weigeren", "weiger*", "afwijzen", "alles afwijzen", "niet akkoord", "alleen noodzakelijke*",
    "alleen functionele*", "nee bedankt",
    // Portuguese
    "rejeitar", "rejeitar tudo", "recusar", "recusar tudo", "n\u00e3o aceito", "apenas necess\u00e1rios",
    "apenas os necess\u00e1rios", "continuar sem aceitar",
    // Nordic
    "avvisa", "avvisa alla", "avb\u00f6j", "neka", "endast n\u00f6dv\u00e4ndiga", "nej tack", "avvis", "avvis alle", "avsl\u00e5",
    "kun n\u00f8dvendige*", "afvis", "afvis alle", "afsl\u00e5", "hylk\u00e4\u00e4", "hylk\u00e4\u00e4 kaikki", "vain v\u00e4ltt\u00e4m\u00e4tt\u00f6m\u00e4t", "kielt\u00e4ydy",
    // Central / Eastern European
    "odrzu\u0107", "odrzu\u0107 wszystkie", "odrzucam", "tylko niezb\u0119dne", "nie zgadzam si\u0119", "odm\u00edtnout", "odm\u00edtnout v\u0161e",
    "pouze nezbytn\u00e9", "odmietnu\u0165", "odmietnu\u0165 v\u0161etko", "elutas\u00edt*", "csak a sz\u00fcks\u00e9ges*", "respinge", "respinge tot",
    "refuz*", "odbij", "zavrni", "\u043e\u0442\u043a\u043b\u043e\u043d\u0438\u0442\u044c", "\u043e\u0442\u043a\u043b\u043e\u043d\u0438\u0442\u044c \u0432\u0441\u0435", "\u043e\u0442\u043a\u0430\u0437\u0430\u0442\u044c\u0441\u044f", "\u0432\u0456\u0434\u0445\u0438\u043b\u0438\u0442\u0438", "\u043e\u0442\u0445\u0432\u044a\u0440\u043b\u044f\u043d\u0435", "\u03b1\u03c0\u03cc\u03c1\u03c1\u03b9\u03c8\u03b7",
    "\u03b1\u03c0\u03cc\u03c1\u03c1\u03b9\u03c8\u03b7 \u03cc\u03bb\u03c9\u03bd", "reddet", "t\u00fcm\u00fcn\u00fc reddet",
    // CJK and others
    "\u62d2\u5426", "\u3059\u3079\u3066\u62d2\u5426", "\u62d2\u7edd", "\u5168\u90e8\u62d2\u7edd", "\u62d2\u7d55", "\uac70\ubd80", "\ubaa8\ub450 \uac70\ubd80", "\u0631\u0641\u0636",
  ];

  // Labels that grant consent. "Only allow essential" contains "allow" and is
  // still a reject: the reject matcher wins when both match.
  const ACCEPT_TERMS = [
    "accept", "accept all", "accept cookies", "accept all cookies", "accepts", "accepted", "agree", "i agree",
    "agree all", "agree to all", "agree and close", "allow", "allow all", "allow cookies", "allow all cookies",
    "ok", "okay", "got it", "i understand", "understood", "continue", "yes", "enable", "enable all", "consent",
    "i consent", "sounds good", "fine by me",
    "akzeptieren", "alle akzeptieren", "alles akzeptieren", "akzeptiere*", "zustimmen", "alle zustimmen",
    "einverstanden", "annehmen", "erlauben", "alle erlauben", "zulassen", "alle zulassen", "verstanden",
    "accepter", "tout accepter", "j'accepte", "d'accord", "autoriser", "tout autoriser", "j'ai compris",
    "aceptar", "aceptar todo", "aceptar todas", "acepto", "permitir", "entendido", "accetta", "accetto",
    "accetta tutto", "accetta tutti", "consenti", "acconsento", "ho capito", "accepteren", "alles accepteren",
    "akkoord", "toestaan", "aceitar", "aceitar tudo", "concordo", "godk\u00e4nn", "acceptera", "acceptera alla",
    "till\u00e5t", "godta", "godta alle", "tillat", "accepter alle", "hyv\u00e4ksy", "hyv\u00e4ksy kaikki", "akceptuj\u0119",
    "zaakceptuj", "zgadzam si\u0119", "p\u0159ijmout", "p\u0159ijmout v\u0161e", "souhlas\u00edm", "elfogad*", "accept*", "kabul",
    "kabul et", "\u043f\u0440\u0438\u043d\u044f\u0442\u044c", "\u043f\u0440\u0438\u043d\u044f\u0442\u044c \u0432\u0441\u0435", "\u0441\u043e\u0433\u043b\u0430\u0441\u0435\u043d", "\u043f\u0440\u0438\u0439\u043d\u044f\u0442\u0438", "\u03b1\u03c0\u03bf\u03b4\u03bf\u03c7\u03ae", "\u540c\u610f", "\u63a5\u53d7", "\u5168\u90e8\u63a5\u53d7",
    "\u3059\u3079\u3066\u8a31\u53ef", "\u540c\u610f\u3059\u308b", "\ub3d9\uc758", "\ud5c8\uc6a9", "\ubaa8\ub450 \ud5c8\uc6a9",
  ];

  // Controls that must never be offered to the model or clicked: they could
  // cause purchases, account actions, data loss or publishing.
  const DANGER_TERMS = [
    "buy", "buy now", "pay", "pay now", "checkout", "check out", "order", "orders", "place order", "purchase",
    "subscribe", "unsubscribe", "submit", "send", "apply", "sign in", "sign up", "sign out", "log in", "login",
    "log out", "logout", "register", "delete", "remove", "confirm", "cancel order", "cancel subscription",
    "download", "install", "upload", "share", "post", "reply", "transfer", "withdraw", "donate", "job", "jobs",
    "offer", "offers", "application", "add to cart", "add to basket",
    "kaufen", "jetzt kaufen", "bezahlen", "zahlen", "zur kasse", "bestellen", "abonnieren", "abbestellen",
    "absenden", "senden", "bewerben", "anmelden", "abmelden", "einloggen", "registrieren", "l\u00f6schen", "entfernen",
    "best\u00e4tigen", "herunterladen", "installieren", "hochladen", "teilen", "antworten", "\u00fcberweisen", "spenden",
    "acheter", "payer", "commander", "s'abonner", "se d\u00e9sabonner", "envoyer", "soumettre", "postuler",
    "se connecter", "connexion", "s'inscrire", "inscription", "supprimer", "retirer", "confirmer", "t\u00e9l\u00e9charger",
    "installer", "partager", "r\u00e9pondre", "faire un don",
    "comprar", "pagar", "suscribirse", "suscribir", "enviar", "iniciar sesi\u00f3n", "registrarse", "eliminar",
    "borrar", "confirmar", "descargar", "instalar", "compartir", "responder", "donar",
    "acquista", "compra", "paga", "ordina", "iscriviti", "invia", "accedi", "registrati", "elimina", "conferma",
    "scarica", "condividi", "rispondi", "dona",
    "kopen", "betalen", "abonneren", "verzenden", "versturen", "inloggen", "aanmelden", "registreren",
    "verwijderen", "bevestigen", "downloaden", "delen", "doneren", "solliciteren",
  ];

  const REJECT_RE = compileTerms(REJECT_TERMS);
  const ACCEPT_RE = compileTerms(ACCEPT_TERMS);
  const DANGER_RE = compileTerms(DANGER_TERMS);

  const matchesReject = (text) => REJECT_RE.test(prep(text));
  const matchesAccept = (text) => ACCEPT_RE.test(prep(text));
  const matchesDanger = (text) => DANGER_RE.test(prep(text));

  /**
   * Does a control's label (visible text + aria/title) read as a reject
   * control? Requires a reject match, no danger match, and refuses labels
   * whose visible text is accept-only (an aria-label must not "launder" an
   * "Accept all" button).
   */
  function isRejectLabel(text, aria = "") {
    const t = prep(text);
    const a = prep(aria);
    const both = `${t} ${a}`.trim();
    if (!both) return false;
    if (matchesDanger(both)) return false;
    if (!REJECT_RE.test(both)) return false;
    if (t && ACCEPT_RE.test(t) && !REJECT_RE.test(t)) return false;
    if (a && ACCEPT_RE.test(a) && !REJECT_RE.test(a)) return false;
    return true;
  }

  /** Accept-ish and not reject-ish: never click this from Layer 1. */
  function isAcceptOnlyLabel(text, aria = "") {
    const both = `${prep(text)} ${prep(aria)}`.trim();
    return ACCEPT_RE.test(both) && !REJECT_RE.test(both);
  }

  const CANDIDATE_ID = /^c\d{1,2}$/;

  /**
   * Post-reply safety gate (ARCHITECTURE, "Content-script safety gate").
   *
   * @param result    native reply (identifyRejectControlResult)
   * @param map       Map<id, Element> for this request only
   * @param container the consent container the request was built from
   * @param snapshot  Map<id, {text, aria}> captured when the request was built
   * @param state     { clicked, enabled, hostDisabled }
   * @param env       optional dom env (tests)
   * @returns {{ ok: true, element: Element } | { ok: false, reason: string }}
   */
  function shouldClick(result, map, container, snapshot, state, env) {
    const no = (reason) => ({ ok: false, reason });
    if (!result || typeof result !== "object") return no("no-result");
    if (result.type !== undefined && result.type !== "identifyRejectControlResult") return no("bad-type");
    if (result.status !== "ok") return no(`status-${typeof result.status === "string" ? result.status : "invalid"}`);
    // The native side only emits "ok" with high confidence; insist on it here too.
    if (result.confidence !== "high") return no("confidence");
    const id = result.candidateId;
    if (typeof id !== "string" || !CANDIDATE_ID.test(id)) return no("bad-id");
    if (!(map instanceof Map) || !map.has(id)) return no("unknown-id");
    if (!state || typeof state !== "object") return no("no-state");
    if (state.clicked) return no("already-clicked");
    if (state.enabled === false) return no("disabled");
    if (state.hostDisabled) return no("host-disabled");

    const el = map.get(id);
    if (!el || !el.isConnected) return no("detached");
    if (!container || !container.isConnected) return no("container-detached");
    if (!dom.containsDeep(container, el)) return no("moved");
    if (!dom.isVisible(el, env)) return no("hidden");
    if (dom.isDisabled(el)) return no("disabled-control");

    // The page could have relabelled the control while the model was thinking.
    const before = snapshot instanceof Map ? snapshot.get(id) : null;
    if (!before) return no("no-snapshot");
    const now = dom.labelOf(el, env);
    if (now.text !== before.text || now.aria !== before.aria) return no("label-changed");

    if (!isRejectLabel(now.text, now.aria)) return no("not-reject-label");
    return { ok: true, element: el };
  }

  const api = Object.freeze({
    compileTerms,
    REJECT_TERMS: Object.freeze(REJECT_TERMS.slice()),
    ACCEPT_TERMS: Object.freeze(ACCEPT_TERMS.slice()),
    DANGER_TERMS: Object.freeze(DANGER_TERMS.slice()),
    matchesReject,
    matchesAccept,
    matchesDanger,
    isRejectLabel,
    isAcceptOnlyLabel,
    shouldClick,
  });

  NS.gate = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
