//
//  Lexicon.swift
//  CookiesCore
//
//  Multilingual word lists used to double-check the model's choice. The model
//  proposes; the lexicon can only veto. A false "accept-like" or "dangerous"
//  match merely blocks a click (fail closed); a false "reject-like" match is
//  harmless on its own because every other check must pass too.
//

import Foundation

/// Pattern syntax (applied after `Lexicon.normalise`):
///
/// * Plain text matches whole words/phrases: `"deny"` matches "Deny all" but
///   not "denying" or "Denylist".
/// * A trailing `*` makes the last word a prefix: `"ablehn*"` matches
///   "Ablehnen" and "Ablehnung"; the matched span extends to the end of that
///   word.
/// * Word boundaries are only enforced on sides where the pattern starts or
///   ends with a letter/digit of a space-separated script. Han, kana and
///   Hangul edges match as plain substrings, because CJK labels have no
///   spaces and Korean attaches particles/endings ("거부합니다").
public enum Lexicon {

    // MARK: Public API

    /// True if `text` contains a reject/decline/deny/necessary-only phrase.
    public static func isRejectLike(_ text: String) -> Bool {
        reject.containsMatch(chars(text))
    }

    /// True if `text` reads as accepting, agreeing, allowing, consenting or
    /// otherwise saying "yes".
    ///
    /// Algorithm (fail closed):
    /// 1. A negated reject ("don't reject") is accept-like.
    /// 2. Reject phrases are masked out, so the "accept" inside
    ///    "Continue without accepting" or the "agree" inside
    ///    "Ich stimme nicht zu"/"I do not agree" no longer counts.
    /// 3. Any remaining accept phrase that is not a bare verb ("accept all",
    ///    "OK", "Got it", "Continue", "Yes", …) is accept-like.
    /// 4. Bare accept verbs ("accept", "allow", "akzeptieren", "許可", …)
    ///    are accept-like, unless the label is a necessary-only label
    ///    ("Accept only necessary", "Nur notwendige Cookies akzeptieren"),
    ///    where the verb merely qualifies the restriction.
    public static func isAcceptLike(_ text: String) -> Bool {
        let normalised = chars(text)
        if negatedReject.containsMatch(normalised) { return true }
        let masked = mask(normalised, with: reject)
        if acceptPhrases.containsMatch(masked) { return true }
        if necessaryOnly.containsMatch(normalised) { return false }
        return acceptVerbs.containsMatch(masked)
    }

    /// True if `text` names an action that must never be automated (buy,
    /// subscribe, log in, delete, submit, …). Never masked: "Refuser et
    /// s'abonner" (pay-or-OK walls) is dangerous even though it says
    /// "refuse".
    public static func isDangerous(_ text: String) -> Bool {
        danger.containsMatch(chars(text))
    }

    /// True if `text` expresses "only necessary/essential/required" in any
    /// supported language. Used for labels and for the model's reason.
    public static func isNecessaryOnly(_ text: String) -> Bool {
        necessaryOnly.containsMatch(chars(text))
    }

    /// True if `text` contains a word for necessary/essential/required.
    public static func mentionsNecessary(_ text: String) -> Bool {
        necessaryWords.containsMatch(chars(text))
    }

    /// Canonical form used for all matching: NFKC, case/diacritic/width
    /// folded, typographic apostrophes unified, final sigma folded, every
    /// other punctuation or symbol turned into a space, whitespace collapsed.
    public static func normalise(_ text: String) -> String {
        let cleaned = TextSanitiser.clean(text, limit: 4_096) ?? ""
        let folded = cleaned
            .precomposedStringWithCompatibilityMapping
            .folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
            .lowercased()
            .precomposedStringWithCanonicalMapping
        var out = ""
        out.reserveCapacity(folded.count)
        var lastWasSpace = true
        for character in folded {
            let mapped: Character
            switch character {
            case "'", "\u{2019}", "\u{2018}", "\u{02BC}", "\u{0060}", "\u{00B4}": mapped = "'"
            case "ς": mapped = "σ"
            default: mapped = (character.isLetter || character.isNumber) ? character : " "
            }
            if mapped == " " {
                if !lastWasSpace { out.append(" ") }
                lastWasSpace = true
            } else {
                out.append(mapped)
                lastWasSpace = false
            }
        }
        while out.last == " " { out.removeLast() }
        return out
    }

    // MARK: Matching internals

    static func chars(_ text: String) -> [Character] { Array(normalise(text)) }

    /// Replaces every span matched by `list` with a single "|" marker. The
    /// marker is a word boundary but not a space, so masking never fuses the
    /// words around a removed phrase into a new multi-word match.
    static func mask(_ text: [Character], with list: PatternList) -> [Character] {
        var covered = [Bool](repeating: false, count: text.count)
        for span in list.spans(in: text) {
            for index in span { covered[index] = true }
        }
        var out: [Character] = []
        out.reserveCapacity(text.count)
        for (index, character) in text.enumerated() {
            if covered[index] {
                if out.last != "|" { out.append("|") }
            } else {
                out.append(character)
            }
        }
        return out
    }

    /// Han, Hiragana, Katakana and Hangul (incl. compatibility jamo).
    static func isCJK(_ character: Character) -> Bool {
        guard let value = character.unicodeScalars.first?.value else { return false }
        switch value {
        case 0x1100...0x11FF, 0x3040...0x30FF, 0x3130...0x318F, 0x31F0...0x31FF,
             0x3400...0x4DBF, 0x4E00...0x9FFF, 0xA960...0xA97F, 0xAC00...0xD7FF,
             0xF900...0xFAFF, 0xFF66...0xFF9F, 0x20000...0x3134F:
            return true
        default:
            return false
        }
    }

    /// A character that continues a word in a space-separated script.
    static func isWordCharacter(_ character: Character) -> Bool {
        (character.isLetter || character.isNumber) && !isCJK(character)
    }

    // MARK: Pattern lists

    static let reject = PatternList(rejectPatterns + necessaryOnlyPatterns)
    static let necessaryOnly = PatternList(necessaryOnlyPatterns)
    static let negatedReject = PatternList(negatedRejectPatterns)
    static let acceptPhrases = PatternList(acceptPhrasePatterns)
    static let acceptVerbs = PatternList(acceptVerbPatterns)
    static let danger = PatternList(dangerPatterns)
    static let necessaryWords = PatternList(necessaryWordPatterns)

    /// Reject / decline / deny / refuse / disagree, incl. negated consent.
    static let rejectPatterns: [String] = [
        // en
        "reject*", "decline*", "deny", "deny all", "denied", "refuse*", "disagree*",
        "i do not agree", "do not agree", "don't agree", "dont agree", "not agree",
        "do not accept", "don't accept", "dont accept", "not accept",
        "do not consent", "don't consent", "dont consent", "no consent", "withhold consent",
        "do not allow", "don't allow", "dont allow", "no thanks", "no thank you",
        "continue without", "continue without accept*", "continue without agree*", "continue without consent*",
        "proceed without", "proceed without accept*", "opt out", "opt-out",
        // de
        "ablehn*", "lehne ab", "lehnen ab", "verweiger*", "zurückweis*", "widersprech*",
        "nicht akzeptieren", "nicht zustimmen", "stimme nicht zu", "nicht einverstanden",
        "ohne zustimmung*", "ohne einwilligung*", "ohne zu akzeptieren", "weiter ohne", "weiter ohne zustimmung*",
        "weiter ohne einwilligung*", "fortfahren ohne*", "nein danke",
        // fr
        "refus*", "tout refuser", "rejeter", "tout rejeter", "décliner", "je ne suis pas d'accord",
        "pas d'accord", "ne pas accepter", "continuer sans", "continuer sans accept*", "continuer sans consent*",
        "non merci",
        // es
        "rechaz*", "denegar*", "no aceptar", "no acepto", "no estoy de acuerdo",
        "continuar sin", "continuar sin acept*", "no gracias",
        // it
        "rifiut*", "nega", "non accetto", "non accettare", "continua senza", "continua senza accett*", "no grazie",
        // nl
        "weiger*", "afwijz*", "wijs af", "niet akkoord", "niet accepteren", "doorgaan zonder", "doorgaan zonder accept*", "doorgaan zonder te accept*",
        "nee bedankt",
        // pt
        "rejeit*", "recus*", "não aceitar", "não aceito", "não concordo", "continuar sem", "continuar sem aceit*",
        "não obrigado",
        // pl
        "odrzuć*", "odrzuc*", "odmów*", "odmaw*", "nie zgadzam się", "nie akceptuj*", "nie wyrażam zgody",
        "kontynuuj bez", "kontynuuj bez akcept*", "kontynuuj bez zgody",
        // sv
        "avvisa*", "avböj*", "neka*", "nej tack", "fortsätt utan", "fortsätt utan att godkänn*", "fortsätt utan att accept*",
        // da
        "afvis*", "afslå*", "nej tak", "fortsæt uden", "fortsæt uden at accept*",
        // nb
        "avvis*", "avslå*", "nei takk", "fortsett uten", "fortsett uten å godta", "fortsett uten å akseptere",
        // fi
        "hylkää*", "hylkaa*", "kieltäydy*", "en hyväksy", "ei kiitos", "jatka ilman", "jatka hyväksymättä",
        // cs
        "odmít*", "nesouhlas*", "nepřijímám", "ne děkuji", "pokračovat bez", "pokračovat bez souhlasu", "pokračovat bez přijetí",
        // tr
        "reddet*", "redded*", "kabul etme*", "kabul etmiyorum", "hayır teşekkürler", "onaylamıyorum",
        // ro
        "resping*", "refuz*", "nu accept", "nu sunt de acord", "nu mulțumesc", "continuă fără", "continuă fără a accepta", "continuă fără acceptare",
        // hu
        "elutasít*", "megtagad*", "nem fogadom el", "nem engedélyezem", "nem járulok hozzá", "nem köszönöm",
        // el
        "απόρριψ*", "απορρίπτ*", "δεν συμφωνώ", "δεν αποδέχομαι", "όχι ευχαριστώ", "συνέχεια χωρίς", "συνέχεια χωρίς αποδοχή",
        // ja
        "拒否", "拒絶", "同意しない", "同意しません", "受け入れない", "許可しない",
        // zh
        "拒绝", "拒絕", "不同意", "不接受", "不允许", "不允許",
        // ko
        "거부", "거절", "동의하지 않", "동의 안 함", "동의안함", "허용 안 함", "허용하지 않",
    ]

    /// "Only necessary / essential / required" phrasing.
    static let necessaryOnlyPatterns: [String] = [
        // en
        "only necessary*", "necessary only", "necessary cookies only", "only essential*", "essential only",
        "essential cookies only", "only required", "required only", "required cookies only",
        "only strictly necessary*", "strictly necessary only", "strictly necessary cookies only",
        "only the necessary*", "only the essential*", "only the required*",
        "minimum cookies", "necessary-only",
        // de
        "nur notwendig*", "nur erforderlich*", "nur essenziell*", "nur essentiell*", "nur technisch*",
        "nur die notwendig*", "nur die erforderlich*", "nur unbedingt*",
        // fr
        "uniquement nécessaire*", "uniquement les nécessaire*", "uniquement les cookies nécessaire*",
        "uniquement essentiel*", "uniquement les essentiel*", "seulement nécessaire*", "seulement les nécessaire*",
        "nécessaires uniquement", "nécessaires seulement", "essentiels uniquement",
        "cookies nécessaires uniquement", "strictement nécessaires uniquement",
        // es
        "solo necesari*", "solo las necesari*", "solo los necesari*", "solo cookies necesari*",
        "solo las cookies necesari*", "solo esencial*", "solo las esencial*", "únicamente necesari*",
        "únicamente las necesari*", "solo las imprescindibles", "solo imprescindibles",
        // it
        "solo necessari*", "solo i necessari*", "solo cookie necessari*", "solo i cookie necessari*",
        "solo essenzial*", "solo tecnici", "solo i tecnici", "solo cookie tecnici", "solo quelli necessari*",
        // nl
        "alleen noodzakelijk*", "alleen functione*", "alleen essentie*", "alleen de noodzakelijk*",
        "alleen strikt noodzakelijk*", "alleen vereist*",
        // pt
        "apenas necessári*", "apenas os necessári*", "apenas essencia*", "apenas os essencia*",
        "somente necessári*", "somente os necessári*", "só necessári*", "só os necessári*",
        "apenas cookies necessári*", "apenas os cookies necessári*",
        // pl
        "tylko niezbędne*", "tylko niezbedne*", "tylko wymagane*", "tylko konieczne*", "wyłącznie niezbędne*",
        // sv
        "endast nödvändiga*", "bara nödvändiga*", "endast nödvändig*", "bara nödvändig*", "endast väsentliga*",
        // da / nb
        "kun nødvendige*", "kun nødvendig*", "bare nødvendige*", "bare nødvendig*", "kun essentielle*",
        "kun påkrævede*", "kun strengt nødvendige*",
        // fi
        "vain välttämättöm*", "vain tarpeelli*", "vain pakolli*", "vain olennai*",
        // cs
        "pouze nezbytn*", "jen nezbytn*", "pouze nutn*", "jen nutn*", "pouze nezbytně*",
        // tr
        "sadece gerekli*", "yalnızca gerekli*", "sadece zorunlu*", "yalnızca zorunlu*",
        // ro
        "doar necesare", "doar cele necesare", "doar esențiale", "doar cele esențiale", "numai necesare",
        "numai cele necesare", "doar cookie urile necesare",
        // hu
        "csak a szükséges*", "csak szükséges*", "csak az elengedhetetlen*", "csak a kötelező*",
        // el
        "μόνο τα απαραίτητ*", "μόνο απαραίτητ*", "μόνο τα αναγκαί*", "μόνο αναγκαί*",
        // ja
        "必要なもののみ", "必要なcookieのみ", "必須cookieのみ", "必須のcookieのみ", "必要なクッキーのみ",
        "必須クッキーのみ", "必須のみ", "必要のみ", "必要最低限",
        // zh
        "仅必要", "僅必要", "仅限必要", "僅限必要", "仅接受必要", "僅接受必要", "只接受必要", "仅使用必要",
        "僅使用必要", "只允许必要", "仅允许必要", "僅允許必要", "仅必需", "僅必需",
        // ko
        "필수만", "필수 쿠키만", "필요한 쿠키만", "필수적인 쿠키만", "필수 항목만",
    ]

    /// Negations of rejection; these make a label accept-like outright.
    static let negatedRejectPatterns: [String] = [
        "don't reject", "dont reject", "do not reject", "not reject", "never reject",
        "nicht ablehnen", "ne pas refuser", "no rechazar", "non rifiutare", "niet weigeren",
        "não rejeitar", "nie odrzucaj",
    ]

    /// Accept phrases other than bare verbs. Never neutralised.
    static let acceptPhrasePatterns: [String] = [
        // en
        "accept all*", "allow all*", "agree to all", "agree all", "enable all*", "accept cookies", "allow cookies",
        "ok", "okay", "got it", "i got it", "i understand", "understood", "yes", "yes please", "sure",
        "continue", "fine", "fine by me", "sounds good", "that's ok", "thats ok", "alright", "let's go",
        "enable*", "i'm ok with that", "i'm fine with that", "keep browsing", "continue browsing",
        // de
        "alle akzeptieren", "alles akzeptieren", "alle cookies akzeptieren", "alle zulassen", "alle erlauben",
        "allen zustimmen", "alle annehmen", "alles annehmen", "einverstanden", "ja", "verstanden", "weiter",
        "alle auswählen", "alle aktivieren", "annehmen",
        // fr
        "tout accepter", "accepter tout", "tout autoriser", "autoriser tout", "d'accord", "oui", "continuer",
        "compris", "j'ai compris", "ok pour moi",
        // es
        "aceptar todo*", "aceptar todas", "permitir todo*", "de acuerdo", "sí", "entendido", "continuar",
        "vale",
        // it
        "accetta tutto", "accetta tutti", "accetto", "va bene", "ho capito", "continua", "consenti tutto",
        "consenti tutti",
        // nl
        "alles accepteren", "alle cookies accepteren", "alles toestaan", "akkoord", "ja", "doorgaan",
        "prima", "begrepen", "oké",
        // pt
        "aceitar tudo", "aceitar todos", "aceito", "concordo", "sim", "entendi", "permitir todos",
        // pl
        "zaakceptuj wszystkie", "akceptuj wszystkie", "akceptuję wszystkie", "zgadzam się", "zgoda", "tak",
        "rozumiem", "przejdź dalej", "kontynuuj", "zezwól na wszystkie",
        // sv
        "godkänn alla", "acceptera alla", "tillåt alla", "jag förstår", "fortsätt",
        // da / nb
        "accepter alle", "acceptér alle", "tillad alle", "godta alle", "aksepter alle", "tillat alle",
        "forstået", "forstått", "fortsæt", "fortsett",
        // fi
        "hyväksy kaikki", "salli kaikki", "kyllä", "jatka", "selvä",
        // cs
        "přijmout vše", "přijmout všechny", "povolit vše", "povolit všechny", "souhlasím", "ano", "rozumím",
        "pokračovat",
        // tr
        "tümünü kabul et", "hepsini kabul et", "tamam", "evet", "anladım", "devam et", "kabul ediyorum",
        // ro
        "acceptă tot", "accept tot", "acceptă toate", "accept toate", "permite toate", "de acord", "da",
        "am înțeles", "continuă",
        // hu
        "összes elfogadása", "mindet elfogadom", "elfogadom", "igen", "rendben", "értem", "tovább",
        "összes engedélyezése",
        // el
        "αποδοχή όλων", "αποδέχομαι όλα", "συμφωνώ", "ναι", "εντάξει", "κατάλαβα", "συνέχεια",
        // ja
        "すべて受け入れる", "すべて同意", "すべてに同意", "全て同意", "全てに同意", "すべて許可", "全て許可",
        "すべてのcookieを受け入れる", "はい", "了解",
        // zh
        "全部接受", "接受全部", "接受所有", "全部同意", "全部允许", "全部允許", "好的", "知道了", "确定", "確定",
        // ko
        "모두 동의", "모두 허용", "모두 수락", "전체 동의", "전체 허용", "확인",
    ]

    /// Bare accept/allow/agree/consent verbs.
    static let acceptVerbPatterns: [String] = [
        "accept*", "allow*", "agree*", "consent*", "permit",
        "akzeptier*", "zulassen", "erlauben", "zustimm*", "stimme zu", "stimmen zu", "einwillig*",
        "autoriser", "j'accepte",
        "acept*", "permitir", "consentir",
        "accett*", "consenti*", "autorizza*",
        "toestaan", "toestemming geven",
        "aceit*", "autorizar", "permitir",
        "akceptuj*", "zaakceptuj*", "zezwól*", "zezwal*", "zgadzam*",
        "godkänn*", "tillåt*", "tillad*", "godta*", "tillat*", "aksepter*",
        "hyväksy*", "salli*",
        "přijmout", "přijímám", "povolit", "souhlas",
        "kabul*", "izin ver*", "onayla*",
        "permite", "accept",
        "elfogad*", "engedélyez*", "hozzájárul*",
        "αποδοχ*", "αποδέχ*", "επιτρέπ*",
        "受け入れ", "許可", "同意", "承諾", "受諾",
        "接受", "允许", "允許",
        "동의", "수락", "허용",
    ]

    /// Actions that must never be automated.
    static let dangerPatterns: [String] = [
        // en
        "buy*", "pay", "pay now", "payment*", "paying", "paid", "checkout", "check out", "order*", "purchas*",
        "subscri*", "unsubscri*", "submit*", "send", "apply", "sign in", "sign up", "log in", "log on", "login",
        "logon", "register*", "delete*", "remove*", "confirm*", "cancel order", "cancel subscription",
        "cancel my subscription", "download*", "install*", "upload*", "share*", "post", "reply", "transfer*",
        "withdraw*", "donat*", "job*", "offer*", "application*", "contentpass", "pur abo", "ad free", "ad-free",
        "go ad free", "premium", "trial", "add to cart", "add to basket",
        // de
        "kauf*", "kaufen", "bezahl*", "zahlen", "jetzt zahlen", "bestell*", "abonn*", "abo", "anmeld*",
        "einloggen", "registrier*", "lösch*", "entfern*", "bestätig*", "herunterlad*", "absenden", "senden",
        "teilen", "spend*", "bewerb*", "angebot*", "werbefrei*",
        // fr
        "achet*", "achat*", "payer", "paiement*", "commander", "commande*", "s'abonner", "abonnement*",
        "inscri*", "connexion", "se connecter", "supprimer", "envoyer", "valider", "confirmer", "télécharger",
        "partager", "faire un don", "offre*", "candidat*", "sans publicité",
        // es
        "comprar", "compra*", "pagar", "pago*", "pedido*", "suscrib*", "suscripción", "registr*",
        "iniciar sesión", "eliminar", "borrar", "enviar", "confirmar", "descargar", "compartir", "donar",
        "oferta*", "sin anuncios",
        // it
        "acquist*", "paga*", "ordina*", "abbona*", "iscriv*", "accedi", "elimina*", "invia*", "conferma*",
        "scarica*", "condividi", "dona*", "offerta*", "senza pubblicità",
        // nl
        "kopen", "koop*", "betal*", "bestel*", "abonne*", "inschrijv*", "inloggen", "aanmelden",
        "verwijder*", "verzend*", "versturen", "bevestig*", "downloaden", "delen", "doneer*", "aanbieding*",
        // pt
        "assin*", "excluir", "baixar", "compartilhar", "entrar", "fazer login", "enviar",
        // pl
        "kup*", "zapłać*", "płatnoś*", "zamów*", "zamaw*", "subskryb*", "zaloguj*", "zarejestruj*", "usuń*",
        "wyślij*", "potwierdź*", "pobierz*", "udostępnij*", "prenumerat*",
        // sv
        "köp*", "betala*", "beställ*", "prenumerer*", "logga in", "registrera*", "ta bort", "skicka*",
        "bekräfta*", "ladda ner", "dela",
        // da / nb
        "køb*", "kjøp*", "betal", "bestil*", "log ind", "logg inn", "tilmeld*", "registrer*", "slet*",
        "slett*", "bekræft*", "bekreft*", "abonnér", "abonner",
        // fi
        "osta*", "maksa*", "tilaa*", "kirjaudu*", "rekisteröidy*", "poista*", "lähetä*", "vahvista*", "lataa*",
        // cs
        "koupit", "kup*", "zaplat*", "objedn*", "předplat*", "přihlás*", "registrovat*", "smazat", "odeslat",
        "potvrdit*", "stáhnout",
        // tr
        "satın al*", "öde*", "ödeme*", "sipariş*", "abone*", "giriş yap*", "kayıt ol*", "sil", "gönder*",
        "indir*",
        // ro
        "cumpără*", "cumpar*", "plătește*", "plata*", "comandă*", "abonează*", "abonare*", "autentific*",
        "înregistr*", "șterge*", "trimite*", "confirmă*", "descarcă*",
        // hu
        "vásárl*", "vásárol*", "megvesz*", "fizet*", "megrendel*", "rendel*", "előfizet*", "bejelentkez*",
        "regisztr*", "töröl*", "küld*", "megerősít*", "letölt*",
        // el
        "αγορ*", "πληρω*", "παραγγελ*", "συνδρομ*", "εγγραφ*", "σύνδεση", "διαγραφ*", "αποστολ*",
        "επιβεβαίωσ*", "λήψη",
        // ja
        "購入", "支払", "支払い", "決済", "注文", "購読", "登録", "ログイン", "サインイン", "削除", "送信",
        "ダウンロード", "申し込", "申込",
        // zh
        "购买", "購買", "支付", "付款", "订单", "訂單", "订阅", "訂閱", "注册", "註冊", "登录", "登錄", "登入",
        "删除", "刪除", "提交", "发送", "發送", "下载", "下載",
        // ko
        "구매", "결제", "주문", "구독", "가입", "로그인", "삭제", "전송", "제출", "다운로드", "신청",
    ]

    /// Words for necessary/essential/required, any language.
    static let necessaryWordPatterns: [String] = [
        "necessary", "essential*", "required", "strictly necessary",
        "notwendig*", "erforderlich*", "essenziell*", "essentiell*",
        "nécessaire*", "essentiel*", "indispensable*",
        "necesari*", "esencial*", "imprescindible*",
        "necessari*", "essenzial*", "tecnici",
        "noodzakelijk*", "functione*", "essentie*",
        "necessári*", "essencia*",
        "niezbędn*", "niezbedn*", "wymagan*", "konieczn*",
        "nödvändig*", "nødvendig*", "påkrævet*", "väsentlig*",
        "välttämättöm*", "tarpeelli*", "pakolli*",
        "nezbytn*", "nutn*",
        "gerekli*", "zorunlu*",
        "necesar*", "esențial*",
        "szükséges*", "elengedhetetlen*", "kötelező*",
        "απαραίτητ*", "αναγκαί*",
        "必要", "必須", "必需",
        "필수", "필요",
    ]
}

/// One normalised pattern; see `Lexicon` for the syntax.
struct LexiconPattern: Sendable {
    let characters: [Character]
    let isPrefix: Bool
    let needsLeftBoundary: Bool
    let needsRightBoundary: Bool

    init?(_ raw: String) {
        let isPrefix = raw.hasSuffix("*")
        let body = isPrefix ? String(raw.dropLast()) : raw
        let characters = Array(Lexicon.normalise(body))
        guard let first = characters.first, let last = characters.last else { return nil }
        self.characters = characters
        self.isPrefix = isPrefix
        self.needsLeftBoundary = Lexicon.isWordCharacter(first)
        self.needsRightBoundary = !isPrefix && Lexicon.isWordCharacter(last)
    }

    /// The span matched at `start`, or nil.
    func match(in text: [Character], at start: Int) -> Range<Int>? {
        let end = start + characters.count
        guard end <= text.count else { return nil }
        for offset in 0..<characters.count where text[start + offset] != characters[offset] {
            return nil
        }
        if needsLeftBoundary, start > 0, Lexicon.isWordCharacter(text[start - 1]) { return nil }
        if isPrefix {
            var extended = end
            while extended < text.count, Lexicon.isWordCharacter(text[extended]) { extended += 1 }
            return start..<extended
        }
        if needsRightBoundary, end < text.count, Lexicon.isWordCharacter(text[end]) { return nil }
        return start..<end
    }
}

struct PatternList: Sendable {
    let patterns: [LexiconPattern]

    init(_ raw: [String]) {
        patterns = raw.compactMap(LexiconPattern.init)
    }

    func containsMatch(_ text: [Character]) -> Bool {
        guard !text.isEmpty else { return false }
        for pattern in patterns {
            for start in text.indices where pattern.match(in: text, at: start) != nil {
                return true
            }
        }
        return false
    }

    func spans(in text: [Character]) -> [Range<Int>] {
        var spans: [Range<Int>] = []
        for pattern in patterns {
            for start in text.indices {
                if let span = pattern.match(in: text, at: start) { spans.append(span) }
            }
        }
        return spans
    }
}
