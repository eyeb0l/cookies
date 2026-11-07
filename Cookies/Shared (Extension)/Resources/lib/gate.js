/*
 * lib/gate.js — multilingual label matchers and the post-reply safety gate.
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
    "continuer sans", "non merci", "je n'accepte pas", "pas d'accord", "uniquement les cookies nécessaires",
    "nécessaires uniquement", "strictement nécessaires uniquement", "seulement les nécessaires", "refuser tout",
    // Spanish / Catalan
    "rechazar", "rechazar todo", "rechazar todas", "rechazo", "denegar", "no acepto", "no aceptar",
    "solo necesarias", "sólo necesarias", "solo las necesarias", "solo cookies necesarias", "continuar sin aceptar",
    "no, gracias", "no gracias", "rebutjar",
    // Italian
    "rifiuta", "rifiuta tutto", "rifiuta tutti", "rifiutare", "rifiuto", "non accetto", "solo necessari",
    "solo i necessari", "continua senza accettare", "nega", "nega tutto",
    // Dutch
    "weigeren", "alles weigeren", "weiger*", "afwijzen", "alles afwijzen", "niet akkoord", "alleen noodzakelijke*",
    "alleen functionele*", "nee bedankt",
    // Portuguese
    "rejeitar", "rejeitar tudo", "recusar", "recusar tudo", "não aceito", "apenas necessários",
    "apenas os necessários", "continuar sem aceitar",
    // Nordic
    "avvisa", "avvisa alla", "avböj", "neka", "endast nödvändiga", "nej tack", "avvis", "avvis alle", "avslå",
    "kun nødvendige*", "afvis", "afvis alle", "afslå", "hylkää", "hylkää kaikki", "vain välttämättömät", "kieltäydy",
    // Central / Eastern European
    "odrzuć", "odrzuć wszystkie", "odrzucam", "tylko niezbędne", "nie zgadzam się", "odmítnout", "odmítnout vše",
    "pouze nezbytné", "odmietnuť", "odmietnuť všetko", "elutasít*", "csak a szükséges*", "respinge", "respinge tot",
    "refuz*", "odbij", "zavrni", "отклонить", "отклонить все", "отказаться", "відхилити", "отхвърляне", "απόρριψη",
    "απόρριψη όλων", "reddet", "tümünü reddet",
    // CJK and others
    "拒否", "すべて拒否", "拒绝", "全部拒绝", "拒絕", "거부", "모두 거부", "رفض",
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
    "akkoord", "toestaan", "aceitar", "aceitar tudo", "concordo", "godkänn", "acceptera", "acceptera alla",
    "tillåt", "godta", "godta alle", "tillat", "accepter alle", "hyväksy", "hyväksy kaikki", "akceptuję",
    "zaakceptuj", "zgadzam się", "přijmout", "přijmout vše", "souhlasím", "elfogad*", "accept*", "kabul",
    "kabul et", "принять", "принять все", "согласен", "прийняти", "αποδοχή", "同意", "接受", "全部接受",
    "すべて許可", "同意する", "동의", "허용", "모두 허용",
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
    "absenden", "senden", "bewerben", "anmelden", "abmelden", "einloggen", "registrieren", "löschen", "entfernen",
    "bestätigen", "herunterladen", "installieren", "hochladen", "teilen", "antworten", "überweisen", "spenden",
    "acheter", "payer", "commander", "s'abonner", "se désabonner", "envoyer", "soumettre", "postuler",
    "se connecter", "connexion", "s'inscrire", "inscription", "supprimer", "retirer", "confirmer", "télécharger",
    "installer", "partager", "répondre", "faire un don",
    "comprar", "pagar", "suscribirse", "suscribir", "enviar", "iniciar sesión", "registrarse", "eliminar",
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
