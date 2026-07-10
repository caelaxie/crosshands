// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "CrossHandsConformanceFixture",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "CrossHandsConformanceFixture", targets: ["CrossHandsConformanceFixture"])],
    targets: [.executableTarget(name: "CrossHandsConformanceFixture")]
)
