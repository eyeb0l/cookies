// swift-tools-version: 6.0
//
// CookiesCore: the native decision logic behind the Cookies Safari Web Extension.
//
// The sources in Sources/CookiesCore are also compiled directly into the
// "Cookies Extension (macOS)" and "Cookies Extension (iOS)" targets of
// Cookies.xcodeproj, so they must not depend on anything but the SDK.

import PackageDescription

let package = Package(
    name: "CookiesCore",
    platforms: [
        .macOS(.v14),
        .iOS(.v17),
    ],
    products: [
        .library(name: "CookiesCore", targets: ["CookiesCore"]),
    ],
    targets: [
        .target(name: "CookiesCore"),
        .testTarget(name: "CookiesCoreTests", dependencies: ["CookiesCore"]),
    ]
)
