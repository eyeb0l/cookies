//
//  ViewController.swift
//  Shared (App)
//
//  Created by Iris Giertuga on 06/11/2026.
//

import Foundation
import WebKit

#if os(iOS)
import UIKit
typealias PlatformViewController = UIViewController
#elseif os(macOS)
import Cocoa
import SafariServices
typealias PlatformViewController = NSViewController
#endif

let extensionBundleIdentifier = "dev.eyeb0l.cookies.Extension"

class ViewController: PlatformViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    private var pageLoaded = false
    private var activationObserver: NSObjectProtocol?

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self
        self.webView.configuration.userContentController.add(self, name: "controller")

        guard let page = Bundle.main.url(forResource: "Main", withExtension: "html"),
              let resources = Bundle.main.resourceURL else { return }
        self.webView.loadFileURL(page, allowingReadAccessTo: resources)

        // Re-check when the user comes back, e.g. after turning on Apple
        // Intelligence or the Safari extension.
#if os(iOS)
        let activation = UIApplication.didBecomeActiveNotification
#elseif os(macOS)
        let activation = NSApplication.didBecomeActiveNotification
#endif
        activationObserver = NotificationCenter.default.addObserver(forName: activation, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageLoaded = true
        refresh()
    }

    private func refresh() {
        guard pageLoaded else { return }
#if os(iOS)
        webView.evaluateJavaScript("show('ios')")
#elseif os(macOS)
        webView.evaluateJavaScript("show('mac')")
        Task { @MainActor [weak self] in
            guard let state = try? await SFSafariExtensionManager.stateOfSafariExtension(withIdentifier: extensionBundleIdentifier) else { return }
            _ = try? await self?.webView.evaluateJavaScript("show('mac', \(state.isEnabled), true)")
        }
#endif
        showModelAvailability()
    }

    /// Passes `SystemLanguageModel.default.availability` (via CookiesCore's
    /// `ModelAvailability`) to the page as JSON.
    private func showModelAvailability() {
        let status = ModelAvailability.current()
        let payload: [String: Any] = [
            "available": status.available,
            "reason": status.reason.rawValue,
            "message": Self.message(for: status.reason),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("showModel(\(json))")
    }

    private static func message(for reason: ModelAvailabilityStatus.Reason) -> String {
#if os(iOS)
        let settings = "Settings → Apple Intelligence & Siri"
        let minimumOS = "iOS 26"
#elseif os(macOS)
        let settings = "System Settings → Apple Intelligence & Siri"
        let minimumOS = "macOS 26"
#endif
        switch reason {
        case .available:
            return "Apple Intelligence is ready. Banners the built-in rules don’t recognise are handled by the on-device model."
        case .appleIntelligenceNotEnabled:
            return "Turn on Apple Intelligence in \(settings) so banners the built-in rules don’t recognise can be handled too. Until then, only built-in rules will run."
        case .deviceNotEligible:
            return "This device doesn’t support Apple Intelligence; only built-in rules will run."
        case .modelNotReady:
            return "The on-device model is still downloading or getting ready. Built-in rules work in the meantime."
        case .osUnsupported:
            return "The on-device model needs \(minimumOS) or later; only built-in rules will run."
        case .frameworkUnavailable, .unknown:
            return "The on-device model isn’t available right now; only built-in rules will run."
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
#if os(macOS)
        guard message.body as? String == "open-preferences" else { return }

        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { error in
            guard error == nil else { return }
            DispatchQueue.main.async {
                NSApp.terminate(nil)
            }
        }
#endif
    }

}
