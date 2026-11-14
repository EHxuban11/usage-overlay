// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "UsageOverlay",
  platforms: [.macOS(.v13)],
  products: [.executable(name: "UsageOverlay", targets: ["UsageOverlay"])],
  targets: [
    .target(name: "UsageCore", linkerSettings: [.linkedLibrary("sqlite3")]),
    .executableTarget(name: "UsageOverlay", dependencies: ["UsageCore"]),
    .testTarget(name: "UsageCoreTests", dependencies: ["UsageCore"]),
  ]
)
