import CoreFoundation
import Foundation

public struct UsageRow: Codable, Equatable {
  public let label: String
  public let percent: Double
  public let resets: Date?
  public init(_ label: String, _ percent: Double, _ resets: Date? = nil) {
    self.label = label
    self.percent = percent
    self.resets = resets
  }
}

public struct Usage: Codable, Equatable {
  public var rows: [UsageRow] = []
  public var text: [String] = []
  public var error: String?
  public var updated: Date?
  public init(
    rows: [UsageRow] = [], text: [String] = [], error: String? = nil, updated: Date? = nil
  ) {
    self.rows = rows
    self.text = text
    self.error = error
    self.updated = updated
  }
  public func retainingLastGood(_ previous: Usage?) -> Usage {
    guard error != nil, let previous, !previous.rows.isEmpty || !previous.text.isEmpty else {
      return self
    }
    var result = previous
    result.error = error
    return result
  }
}

public struct Config {
  public static let providers = ["claude", "codex", "cursor", "copilot", "opencode"]
  public var corner = "top-right"
  public var marginX: Double = 14
  public var marginY: Double = 14
  public var refreshSeconds: Double = 60
  public var sections: [String]?
  public var githubUser = ""
  public var githubToken = ""
  public var copilotIncluded: Double = 200
  public var claudeKeychainService = "Claude Code-credentials"
  public init(_ json: [String: Any] = [:]) {
    if let corner = json["corner"] as? String,
      ["top-right", "top-left", "bottom-right", "bottom-left"].contains(corner)
    {
      self.corner = corner
    }
    if let n = number(json["marginX"]) { marginX = max(0, n) }
    if let n = number(json["marginY"]) { marginY = max(0, n) }
    if let n = number(json["refreshSeconds"]) { refreshSeconds = max(15, n) }
    if let sections = json["sections"] as? [String] {
      self.sections = Self.providers.filter { sections.contains($0) }
    }
    githubUser = json["githubUser"] as? String ?? ""
    githubToken = json["githubToken"] as? String ?? ""
    if let n = number(json["copilotIncluded"]), n > 0 { copilotIncluded = n }
    if let service = json["claudeKeychainService"] as? String, !service.isEmpty {
      claudeKeychainService = service
    }
  }
}

func number(_ value: Any?) -> Double? {
  guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else {
    return nil
  }
  let n = value.doubleValue
  return n.isFinite ? n : nil
}

public func parseDate(_ value: Any?) -> Date? {
  if let n = number(value), n > 0 { return Date(timeIntervalSince1970: n) }
  guard let text = value as? String else { return nil }
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text)
}

public func countdown(_ date: Date?, now: Date = Date()) -> String {
  guard let date else { return "" }
  let seconds = max(0, date.timeIntervalSince(now))
  if seconds == 0 { return "reset due" }
  let minutes = Int(ceil(seconds / 60))
  if minutes >= 1440 { return "\(minutes / 1440)d \((minutes % 1440) / 60)h" }
  if minutes >= 60 { return "\(minutes / 60)h \(minutes % 60)m" }
  return "\(minutes)m"
}

public enum Parsers {
  public static func claude(_ json: [String: Any]) -> Usage {
    var rows: [UsageRow] = []
    for (key, label) in [
      ("five_hour", "5h"), ("seven_day", "wk"),
      ("seven_day_sonnet", "son"), ("seven_day_opus", "opus"),
    ] {
      if let window = json[key] as? [String: Any], let pct = number(window["utilization"]) {
        rows.append(UsageRow(label, pct, parseDate(window["resets_at"])))
      }
    }
    for limit in json["limits"] as? [[String: Any]] ?? [] {
      guard limit["kind"] as? String == "weekly_scoped",
        let scope = limit["scope"] as? [String: Any], let model = scope["model"] as? [String: Any],
        let name = model["display_name"] as? String, let pct = number(limit["percent"])
      else { continue }
      let label = String(name.lowercased().prefix(3))
      if !rows.contains(where: { $0.label == label }) {
        rows.append(UsageRow(label, pct, parseDate(limit["resets_at"])))
      }
    }
    // Some team/credit plans expose spending usage but no 5h or weekly windows.
    // Keep this distinct from subscription quota and do not invent a reset date.
    if let extra = json["extra_usage"] as? [String: Any], extra["is_enabled"] as? Bool == true,
      let pct = number(extra["utilization"])
    {
      rows.append(UsageRow("spnd", pct))
    } else if let spend = json["spend"] as? [String: Any], spend["enabled"] as? Bool == true,
      let pct = number(spend["percent"])
    {
      rows.append(UsageRow("spnd", pct))
    }
    return rows.isEmpty ? Usage(error: "no quota data") : Usage(rows: rows, updated: Date())
  }

  public static func codexLine(_ line: String) -> Usage? {
    guard line.contains("\"rate_limits\""), let data = line.data(using: .utf8),
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let payload = json["payload"] as? [String: Any],
      let limits = payload["rate_limits"] as? [String: Any]
    else { return nil }
    // Model-specific limits are separate quotas, not the account-wide Codex bar.
    if let id = limits["limit_id"] as? String, id != "codex" { return nil }
    var rows: [UsageRow] = []
    for (key, fallback) in [("primary", "5h"), ("secondary", "wk")] {
      guard let window = limits[key] as? [String: Any], let pct = number(window["used_percent"])
      else { continue }
      var label = fallback
      if let minutes = number(window["window_minutes"]), minutes > 0 {
        if minutes == 10080 {
          label = "wk"
        } else if minutes.truncatingRemainder(dividingBy: 1440) == 0 {
          label = "\(Int(minutes / 1440))d"
        } else if minutes.truncatingRemainder(dividingBy: 60) == 0 {
          label = "\(Int(minutes / 60))h"
        } else {
          label = "\(Int(minutes))m"
        }
      }
      rows.append(UsageRow(label, pct, parseDate(window["resets_at"])))
    }
    return rows.isEmpty ? nil : Usage(rows: rows, updated: parseDate(json["timestamp"]))
  }

  public static func cursor(_ json: [String: Any]) -> Usage {
    guard let usage = json["individualUsage"] as? [String: Any],
      let plan = usage["plan"] as? [String: Any]
    else {
      return Usage(error: "no quota data")
    }
    let reset = parseDate(json["billingCycleEnd"])
    let rows = [("apiPercentUsed", "api"), ("totalPercentUsed", "tot")].compactMap { key, label in
      number(plan[key]).map { UsageRow(label, $0, reset) }
    }
    return rows.isEmpty ? Usage(error: "no quota data") : Usage(rows: rows, updated: Date())
  }
}
