import SQLite3
import XCTest

@testable import UsageCore

final class UsageCoreTests: XCTestCase {
  func testClaudeCreditPlanWithoutSubscriptionWindows() {
    let usage = Parsers.claude([
      "five_hour": NSNull(), "seven_day": NSNull(),
      "extra_usage": ["is_enabled": true, "utilization": 37.5],
      "spend": ["enabled": true, "percent": 38],
    ])
    XCTAssertNil(usage.error)
    XCTAssertEqual(usage.rows, [UsageRow("spnd", 37.5)])
    XCTAssertEqual(
      Parsers.claude(["spend": ["enabled": true, "percent": 38]]).rows, [UsageRow("spnd", 38)])
    XCTAssertNotNil(Parsers.claude(["extra_usage": ["is_enabled": false, "utilization": 0]]).error)
  }
  func testMalformedConfigurationFallsBackPerField() {
    let config = Config([
      "refreshSeconds": 1, "marginX": -100, "marginY": "oops", "corner": "elsewhere",
      "sections": ["codex", "bogus", "codex"], "copilotIncluded": 0,
    ])
    XCTAssertEqual(config.refreshSeconds, 15)
    XCTAssertEqual(config.marginX, 0)
    XCTAssertEqual(config.marginY, 14)
    XCTAssertEqual(config.corner, "top-right")
    XCTAssertEqual(config.sections, ["codex"])
    XCTAssertEqual(config.copilotIncluded, 200)
    XCTAssertEqual(Config(["refreshSeconds": true]).refreshSeconds, 60)
  }

  func testCodexUsesActualWindowAndRejectsOtherLimits() {
    let usage = Parsers.codexLine(event(percent: 7, minutes: 10080))
    XCTAssertEqual(usage?.rows.first?.label, "wk")
    XCTAssertEqual(usage?.rows.first?.percent, 7)
    XCTAssertNotNil(usage?.updated)
    XCTAssertNil(Parsers.codexLine(event(percent: 99, id: "codex-other-model")))
    XCTAssertNil(Parsers.codexLine("{\"payload\":{\"rate_limits\":null}}"))
    XCTAssertNil(Parsers.codexLine("{\"payload\":{\"rate_limits\":{}}}"))
  }

  func testCodexReverseScanAcrossChunksAndPartialLastRecord() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let sessions = directory.appendingPathComponent(".codex/sessions/2026/01/01")
    try FileManager.default.createDirectory(at: sessions, withIntermediateDirectories: true)
    let text =
      event(percent: 42) + "\n" + String(repeating: "x", count: 140_000) + "\n"
      + "{\"payload\":{\"rate_limits\":null}}\n{\"rate_limits\":"
    try text.write(
      to: sessions.appendingPathComponent("rollout-fixture.jsonl"), atomically: true,
      encoding: .utf8)
    let usage = try Providers(home: directory, environment: [:]).codex()
    XCTAssertEqual(usage.rows.first?.percent, 42)
    XCTAssertNil(usage.error)
  }

  func testCodexSelectsNewestEventInsteadOfMostRecentlyTouchedFile() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let sessions = directory.appendingPathComponent(".codex/sessions")
    try FileManager.default.createDirectory(at: sessions, withIntermediateDirectories: true)
    let new = sessions.appendingPathComponent("rollout-new.jsonl")
    let old = sessions.appendingPathComponent("rollout-old.jsonl")
    try event(percent: 20, timestamp: "2098-01-02T00:00:00Z").write(
      to: new, atomically: true, encoding: .utf8)
    try event(percent: 10, timestamp: "2098-01-01T00:00:00Z").write(
      to: old, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes(
      [.modificationDate: Date().addingTimeInterval(10)], ofItemAtPath: old.path)
    XCTAssertEqual(try Providers(home: directory, environment: [:]).codex().rows.first?.percent, 20)
  }

  func testExpiredCodexSnapshotIsMarkedStale() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let sessions = directory.appendingPathComponent(".codex/sessions")
    try FileManager.default.createDirectory(at: sessions, withIntermediateDirectories: true)
    try event(percent: 80, reset: 1).write(
      to: sessions.appendingPathComponent("rollout-fixture.jsonl"), atomically: true,
      encoding: .utf8)
    let usage = try Providers(home: directory, environment: [:]).codex()
    XCTAssertEqual(usage.rows.first?.percent, 80)
    XCTAssertEqual(usage.error, "awaiting new session data")
  }

  func testFailureRetainsValuesAndOriginalTimestamp() {
    let good = Usage(rows: [UsageRow("5h", 42)], updated: Date(timeIntervalSince1970: 100))
    let failure = Usage(error: "offline").retainingLastGood(good)
    XCTAssertEqual(failure.rows, good.rows)
    XCTAssertEqual(failure.updated, good.updated)
    XCTAssertEqual(failure.error, "offline")
    XCTAssertNil(good.retainingLastGood(failure).error)
  }

  func testMissingProviderValuesAreNotReportedAsZeroUsage() {
    XCTAssertNotNil(Parsers.claude([:]).error)
    XCTAssertNotNil(Parsers.cursor(["individualUsage": ["plan": [:]]]).error)
    let claude = Parsers.claude([
      "five_hour": ["utilization": 12, "resets_at": "2099-01-01T12:00:00.000Z"],
      "seven_day": NSNull(),
    ])
    XCTAssertEqual(claude.rows.count, 1)
    XCTAssertEqual(claude.rows.first?.percent, 12)
    XCTAssertNotNil(claude.rows.first?.resets)
    let cursor = Parsers.cursor([
      "individualUsage": ["plan": ["totalPercentUsed": 55]],
      "billingCycleEnd": "2099-01-01T12:00:00Z",
    ])
    XCTAssertEqual(cursor.rows.map(\.label), ["tot"])
    XCTAssertEqual(cursor.rows.first?.percent, 55)
  }

  func testOpenCodeReadsTotalsWithoutChangingDatabase() async throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let folder = directory.appendingPathComponent(".local/share/opencode")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let path = folder.appendingPathComponent("opencode.db")
    var db: OpaquePointer?
    XCTAssertEqual(sqlite3_open(path.path, &db), SQLITE_OK)
    XCTAssertEqual(
      sqlite3_exec(
        db,
        "CREATE TABLE session(cost REAL, tokens_input INTEGER, tokens_output INTEGER, time_created INTEGER); INSERT INTO session VALUES (2.5, 200000, 300000, 0), (1.5, 300000, 200000, \(Int64(Date().timeIntervalSince1970 * 1000)));",
        nil, nil, nil), SQLITE_OK)
    sqlite3_close(db)
    let before = try Data(contentsOf: path)
    let providers = Providers(home: directory, environment: [:])
    XCTAssertEqual(providers.detected(Config()), ["opencode"])
    let usage = await providers.fetch("opencode", config: Config())
    XCTAssertNil(usage.error)
    XCTAssertEqual(usage.text, ["mo $1.50 spent", "all $4.00 / 1.0M tok"])
    XCTAssertEqual(try Data(contentsOf: path), before)
  }

  func testCountdownAndExpiredFileCredentials() {
    let now = Date(timeIntervalSince1970: 1000)
    XCTAssertEqual(countdown(now.addingTimeInterval(86400 + 7200), now: now), "1d 2h")
    XCTAssertEqual(countdown(now.addingTimeInterval(-1), now: now), "reset due")
    XCTAssertEqual(countdown(nil), "")
    let providers = Providers(environment: [:])
    XCTAssertNil(
      providers.credentialToken(
        Data("{\"claudeAiOauth\":{\"accessToken\":\"fixture\",\"expiresAt\":1}}".utf8)))
  }

  private func temporaryDirectory() throws -> URL {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
  }
  private func event(
    percent: Int, minutes: Int = 300, id: String = "codex",
    timestamp: String = "2098-01-01T00:00:00Z", reset: Int = 4_070_908_800
  ) -> String {
    "{\"timestamp\":\"\(timestamp)\",\"payload\":{\"rate_limits\":{\"limit_id\":\"\(id)\",\"primary\":{\"used_percent\":\(percent),\"window_minutes\":\(minutes),\"resets_at\":\(reset)}}}}"
  }
}
