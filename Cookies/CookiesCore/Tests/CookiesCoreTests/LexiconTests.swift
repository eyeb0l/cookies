import XCTest
@testable import CookiesCore

final class LexiconTests: XCTestCase {
    /// Labels that must count as "reject all / necessary only" and pass the
    /// whole lexical gate (reject-like, not accept-like, not dangerous).
    static let rejectLabels: [(lang: String, label: String)] = [
        ("en", "Reject all"), ("en", "Decline"), ("en", "Deny"), ("en", "Refuse all cookies"),
        ("en", "I disagree"), ("en", "No, thanks"), ("en", "Only necessary"), ("en", "Essential only"),
        ("en", "Continue without accepting"), ("en", "Accept only necessary cookies"),
        ("en", "Use necessary cookies only"), ("en", "Do not accept"), ("en", "Reject non-essential"),
        ("de", "Alle ablehnen"), ("de", "Ablehnen"), ("de", "Nur notwendige Cookies"),
        ("de", "Nur notwendige Cookies akzeptieren"), ("de", "Nur essenzielle Cookies erlauben"),
        ("fr", "Tout refuser"), ("fr", "Refuser"), ("fr", "Continuer sans accepter"),
        ("es", "Rechazar todo"), ("es", "Solo las necesarias"),
        ("it", "Rifiuta"), ("it", "Rifiuta tutto"), ("it", "Continua senza accettare"),
        ("nl", "Weigeren"), ("nl", "Alles afwijzen"), ("nl", "Alleen noodzakelijke cookies"),
        ("pt", "Rejeitar todos"), ("pt", "Recusar"), ("pt", "Apenas necessários"),
        ("pl", "Odrzuć wszystkie"), ("pl", "Odrzuć"), ("pl", "Tylko niezbędne"),
        ("sv", "Avvisa alla"), ("sv", "Godkänn endast nödvändiga"),
        ("da", "Afvis alle"), ("da", "Tillad kun nødvendige"),
        ("nb", "Avvis alle"), ("nb", "Bare nødvendige"),
        ("fi", "Hylkää kaikki"), ("fi", "Hylkää"),
        ("cs", "Odmítnout vše"), ("cs", "Odmítnout"),
        ("tr", "Tümünü reddet"), ("tr", "Reddet"),
        ("ro", "Respinge toate"), ("ro", "Respinge"),
        ("hu", "Összes elutasítása"), ("hu", "Elutasít"),
        ("el", "Απόρριψη όλων"), ("el", "ΑΠΟΡΡΙΨΗ"),
        ("ja", "すべて拒否"), ("ja", "拒否"), ("ja", "必要なCookieのみ許可"),
        ("zh", "全部拒绝"), ("zh", "拒绝"), ("zh", "拒絕所有"), ("zh", "仅接受必要的"),
        ("ko", "모두 거부"), ("ko", "거부"), ("ko", "거부합니다"), ("ko", "필수 쿠키만 허용"),
    ]

    func testRejectLabelsPassTheLexicalGate() {
        for (lang, label) in Self.rejectLabels {
            XCTAssertTrue(Lexicon.isRejectLike(label), "\(lang): \(label) should be reject-like")
            XCTAssertFalse(Lexicon.isAcceptLike(label), "\(lang): \(label) should not be accept-like")
            XCTAssertFalse(Lexicon.isDangerous(label), "\(lang): \(label) should not be dangerous")
        }
    }

    static let acceptLabels: [String] = [
        "Accept all", "Accept", "Allow all", "I agree", "Agree and close", "OK", "Ok!", "Got it", "I understand",
        "Continue", "Yes", "Enable all", "Accept necessary and analytics", "Allow essential cookies",
        "Alle akzeptieren", "Akzeptieren", "Einverstanden", "Tout accepter", "J'accepte", "Accepter et fermer",
        "Aceptar todo", "Accetta tutto", "Alles accepteren", "Akkoord", "Aceitar tudo", "Zaakceptuj wszystkie",
        "Godkänn alla", "Accepter alle", "Godta alle", "Hyväksy kaikki", "Přijmout vše", "Tümünü kabul et",
        "Acceptă tot", "Összes elfogadása", "Αποδοχή όλων", "すべて受け入れる", "同意する", "全部接受", "同意",
        "모두 동의", "동의합니다", "Only necessary? No, accept all",
    ]

    func testAcceptLabelsAreAcceptLike() {
        for label in Self.acceptLabels {
            XCTAssertTrue(Lexicon.isAcceptLike(label), "\(label) should be accept-like")
        }
    }

    func testNegatedRejectIsAcceptLike() {
        XCTAssertTrue(Lexicon.isAcceptLike("Don't reject"))
        XCTAssertTrue(Lexicon.isAcceptLike("Nicht ablehnen"))
    }

    func testRejectPlusAcceptIsAcceptLike() {
        XCTAssertTrue(Lexicon.isAcceptLike("Reject all and accept"))
        XCTAssertTrue(Lexicon.isAcceptLike("Rejeter ou tout accepter"))
    }

    func testNotRejectLike() {
        for label in ["Cookie settings", "Manage preferences", "Customise", "More options", "Learn more",
                      "Save", "Einstellungen", "Paramètres", "Close", "×", "", "設定", "设置", "설정"] {
            XCTAssertFalse(Lexicon.isRejectLike(label), "\(label) should not be reject-like")
        }
    }

    /// Decision: plain patterns match whole words only. "deny" matches
    /// "Deny all" but not "denying" or "denylist"; "ok" never matches inside
    /// "cookies" or "book".
    func testWordBoundaries() {
        XCTAssertTrue(Lexicon.isRejectLike("Deny"))
        XCTAssertTrue(Lexicon.isRejectLike("DENY ALL"))
        XCTAssertTrue(Lexicon.isRejectLike("deny."))
        XCTAssertFalse(Lexicon.isRejectLike("denying"))
        XCTAssertFalse(Lexicon.isRejectLike("denylist"))
        XCTAssertFalse(Lexicon.isAcceptLike("Cookies"))
        XCTAssertFalse(Lexicon.isAcceptLike("Book a table"))
        XCTAssertFalse(Lexicon.isAcceptLike("Disagree"))
        XCTAssertTrue(Lexicon.isAcceptLike("OK"))
        // Prefix patterns (`reject*`) do match inflections.
        XCTAssertTrue(Lexicon.isRejectLike("Rejecting cookies"))
        XCTAssertTrue(Lexicon.isRejectLike("Ablehnung"))
        // Danger words obey boundaries too.
        XCTAssertFalse(Lexicon.isDangerous("Postpone"))
        XCTAssertTrue(Lexicon.isDangerous("Post"))
    }

    func testCJKMatchesWithoutSpaces() {
        XCTAssertTrue(Lexicon.isRejectLike("全部拒绝并关闭"))
        XCTAssertTrue(Lexicon.isRejectLike("クッキーを拒否する"))
        XCTAssertTrue(Lexicon.isRejectLike("모든쿠키거부"))
        XCTAssertFalse(Lexicon.isAcceptLike("不同意"))
        XCTAssertFalse(Lexicon.isAcceptLike("同意しない"))
        XCTAssertFalse(Lexicon.isAcceptLike("동의하지 않음"))
        XCTAssertTrue(Lexicon.isAcceptLike("同意して閉じる"))
        // A Latin pattern next to kana still has a boundary.
        XCTAssertTrue(Lexicon.isAcceptLike("OKです"))
    }

    func testNormalisationDefeatsObfuscation() {
        XCTAssertTrue(Lexicon.isAcceptLike("Ac\u{200B}cept"))         // zero-width space
        XCTAssertTrue(Lexicon.isAcceptLike("ＡＣＣＥＰＴ"))              // full-width
        XCTAssertTrue(Lexicon.isRejectLike("REJECT"))
        XCTAssertTrue(Lexicon.isRejectLike("Odrzuc wszystkie"))      // missing diacritics
        XCTAssertTrue(Lexicon.isRejectLike("Don’t accept"))          // typographic apostrophe
        XCTAssertEqual(Lexicon.normalise("  Tout   REFUSER ! "), "tout refuser")
    }

    func testDangerList() {
        for label in ["Buy now", "Pay", "Subscribe", "Unsubscribe", "Sign in", "Log in", "Register", "Submit",
                      "Delete account", "Download", "Donate", "Apply for this job", "Refuser et s'abonner",
                      "Ablehnen und Abo abschließen", "Jetzt kaufen", "Abonnieren", "Comprar", "Acquista",
                      "Kopen", "Zaloguj się", "購入する", "ログイン", "订阅", "登录", "구독하기", "로그인"] {
            XCTAssertTrue(Lexicon.isDangerous(label), "\(label) should be dangerous")
        }
    }

    func testNecessaryOnlyHelpers() {
        XCTAssertTrue(Lexicon.isNecessaryOnly("This is the necessary-only option."))
        XCTAssertTrue(Lexicon.isNecessaryOnly("It keeps only essential cookies"))
        XCTAssertFalse(Lexicon.isNecessaryOnly("It rejects everything"))
        XCTAssertTrue(Lexicon.mentionsNecessary("Strictly necessary"))
        XCTAssertTrue(Lexicon.mentionsNecessary("Notwendige"))
        XCTAssertTrue(Lexicon.mentionsNecessary("必須"))
        XCTAssertFalse(Lexicon.mentionsNecessary("Statistics"))
    }

    func testEveryPatternNormalisesToSomething() {
        let all = Lexicon.rejectPatterns + Lexicon.necessaryOnlyPatterns + Lexicon.negatedRejectPatterns
            + Lexicon.acceptPhrasePatterns + Lexicon.acceptVerbPatterns + Lexicon.dangerPatterns
            + Lexicon.necessaryWordPatterns
        for raw in all {
            XCTAssertNotNil(LexiconPattern(raw), raw)
        }
    }

    /// No reject or necessary-only pattern may itself look dangerous, or the
    /// gate could never pass for that language.
    func testRejectPatternsAreNotDangerous() {
        for raw in Lexicon.rejectPatterns + Lexicon.necessaryOnlyPatterns {
            let body = raw.hasSuffix("*") ? String(raw.dropLast()) : raw
            XCTAssertFalse(Lexicon.isDangerous(body), raw)
        }
    }
}
