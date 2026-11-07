//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  Native end of `browser.runtime.sendNativeMessage`. CookiesCore's sources
//  are compiled into this target (see Cookies/CookiesCore).
//

import Foundation
import SafariServices
import os

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private static let log = Logger(subsystem: "dev.eyeb0l.cookies", category: "handler")

    /// Dispatches on the message's `type` and calls `completeRequest`
    /// exactly once on every path. `CookiesService.handle` never throws and is
    /// bounded by its own timeout, so the asynchronous path always completes.
    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any]
        let type = message?["type"] as? String

        switch type {
        case IdentifyRejectControlRequest.messageType:
            let message = message ?? [:]
            Task {
                let reply = await CookiesService.shared.handle(message: message)
                Self.complete(context, with: reply)
            }
        case "ping", "availability":
            Self.complete(context, with: ModelAvailability.current().dictionary)
        default:
            Self.log.notice("Unsupported native message type: \(type ?? "nil", privacy: .public)")
            Self.complete(context, with: IdentifyRejectControlResult.error("unsupported message type").dictionary)
        }
    }

    private static func complete(_ context: NSExtensionContext, with reply: [String: Any]) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: reply]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
