//
//  Logging.swift
//  CookiesCore
//
//  Unified logging only (nothing persisted by us). Page-derived strings are
//  always interpolated with `privacy: .private`, so they are redacted unless a
//  developer profile is installed; page text itself is never logged.
//

import Foundation
import os

enum Log {
    static let subsystem = "dev.eyeb0l.cookies"
    static let service = Logger(subsystem: subsystem, category: "service")
    static let engine = Logger(subsystem: subsystem, category: "engine")
}
