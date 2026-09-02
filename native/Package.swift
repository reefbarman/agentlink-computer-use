// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "ComputerUseNative",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "ComputerUseNative", targets: ["ComputerUseNative"]),
        .executable(name: "GroundingTestTarget", targets: ["GroundingTestTarget"]),
        .executable(name: "SemanticWorkflowTestTarget", targets: ["SemanticWorkflowTestTarget"]),
        .executable(name: "KeyboardTestTarget", targets: ["KeyboardTestTarget"]),
        .executable(name: "MouseTestTarget", targets: ["MouseTestTarget"]),
    ],
    targets: [
        .executableTarget(
            name: "GroundingTestTarget",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("CoreGraphics"),
            ]
        ),
        .executableTarget(
            name: "SemanticWorkflowTestTarget",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("CoreGraphics"),
            ]
        ),
        .executableTarget(
            name: "KeyboardTestTarget",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("CoreGraphics"),
            ]
        ),
        .executableTarget(
            name: "MouseTestTarget",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("CoreGraphics"),
            ]
        ),
        .executableTarget(
            name: "ComputerUseNative",
            linkerSettings: [
                .linkedFramework("ApplicationServices"),
                .linkedFramework("AppKit"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("CryptoKit"),
                .linkedFramework("ImageIO"),
                .linkedFramework("ScreenCaptureKit"),
            ]
        ),
    ]
)
