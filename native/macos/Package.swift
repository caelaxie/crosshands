// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "CrossHandsComputerUseMacOS",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "CrossHandsComputerUseMacOSCore",
            targets: ["CrossHandsComputerUseMacOSCore"]
        ),
        .executable(
            name: "crosshands-computer-use-macos",
            targets: ["CrossHandsComputerUseMacOS"]
        )
    ],
    targets: [
        .target(
            name: "CrossHandsComputerUseMacOSCore",
            path: "Sources/CrossHandsComputerUseMacOSCore"
        ),
        .executableTarget(
            name: "CrossHandsComputerUseMacOS",
            dependencies: ["CrossHandsComputerUseMacOSCore"],
            path: "Sources/CrossHandsComputerUseMacOS"
        ),
        .testTarget(
            name: "CrossHandsComputerUseMacOSTests",
            dependencies: ["CrossHandsComputerUseMacOSCore"],
            path: "Tests/CrossHandsComputerUseMacOSTests"
        )
    ]
)
