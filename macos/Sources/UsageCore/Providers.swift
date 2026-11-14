import Foundation
import SQLite3
import Security

enum ProviderError: Error { case message(String) }

private final class NoRedirects: NSObject, URLSessionTaskDelegate {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    // These endpoints do not require redirects. Never forward a login cookie
    // or bearer token to a redirect destination.
    completionHandler(nil)
  }
}

// No credentials or provider response bodies are written to logs or the usage cache.
public final class Providers {
  let home: URL
  let codexHome: URL
  let claudeHome: URL
  let opencodeDB: URL
  let cursorDB: URL
  let session: URLSession
  public init(
    home: URL = FileManager.default.homeDirectoryForCurrentUser,
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) {
    self.home = home
    codexHome =
      environment["CODEX_HOME"].map { URL(fileURLWithPath: $0) }
      ?? home.appendingPathComponent(".codex")
    claudeHome =
      environment["CLAUDE_CONFIG_DIR"].map { URL(fileURLWithPath: $0) }
      ?? home.appendingPathComponent(".claude")
    let dataHome =
      environment["XDG_DATA_HOME"].map { URL(fileURLWithPath: $0) }
      ?? home.appendingPathComponent(".local/share")
    opencodeDB = dataHome.appendingPathComponent("opencode/opencode.db")
    cursorDB = home.appendingPathComponent(
      "Library/Application Support/Cursor/User/globalStorage/state.vscdb")
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 8
    configuration.timeoutIntervalForResource = 12
    configuration.httpShouldSetCookies = false
    session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
  }
  deinit { session.invalidateAndCancel() }

  public func detected(_ config: Config) -> [String] {
    if let sections = config.sections { return sections }
    return Config.providers.filter { provider in
      switch provider {
      case "claude": return exists(claudeHome)  // Avoid requesting Keychain access just for detection.
      case "codex": return exists(codexHome.appendingPathComponent("sessions"))
      case "cursor": return exists(cursorDB)
      case "opencode": return exists(opencodeDB)
      case "copilot": return !config.githubUser.isEmpty && !config.githubToken.isEmpty
      default: return false
      }
    }
  }

  public func fetch(_ provider: String, config: Config) async -> Usage {
    do {
      switch provider {
      case "claude":
        let token = try claudeToken(config)
        return Parsers.claude(
          try await get(
            "https://api.anthropic.com/api/oauth/usage",
            headers: [
              "Authorization": "Bearer \(token)", "anthropic-beta": "oauth-2025-04-20",
            ]))
      case "codex": return try codex()
      case "cursor":
        let db = try Database(cursorDB)
        guard
          let token = try db.query("SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken'")
            .first?["value"] as? String
        else {
          throw ProviderError.message("not logged in")
        }
        let parts = token.split(separator: ".")
        guard parts.count >= 2 else { throw ProviderError.message("auth stale") }
        var encoded = String(parts[1]).replacingOccurrences(of: "-", with: "+")
          .replacingOccurrences(of: "_", with: "/")
        encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
        guard let data = Data(base64Encoded: encoded),
          let jwt = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let sub = jwt["sub"] as? String, let user = sub.split(separator: "|").last
        else { throw ProviderError.message("auth stale") }
        return Parsers.cursor(
          try await get(
            "https://cursor.com/api/usage-summary",
            headers: [
              "Cookie": "WorkosCursorSessionToken=\(user)%3A%3A\(token)"
            ]))
      case "copilot":
        guard !config.githubUser.isEmpty, !config.githubToken.isEmpty else {
          throw ProviderError.message("no token")
        }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-"))
        guard config.githubUser.unicodeScalars.allSatisfy(allowed.contains) else {
          throw ProviderError.message("check user")
        }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let now = Date()
        let components = calendar.dateComponents([.year, .month], from: now)
        let json = try await get(
          "https://api.github.com/users/\(config.githubUser)/settings/billing/ai_credit/usage?year=\(components.year!)&month=\(components.month!)",
          headers: [
            "Authorization": "Bearer \(config.githubToken)",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2026-03-10",
          ])
        guard let items = json["usageItems"] as? [[String: Any]] else {
          throw ProviderError.message("no quota data")
        }
        let used = items.filter { $0["product"] == nil || $0["product"] as? String == "copilot" }
          .reduce(0.0) { $0 + (number($1["grossQuantity"]) ?? 0) }
        return Usage(
          rows: [
            UsageRow(
              "mo", used / config.copilotIncluded * 100,
              calendar.dateInterval(of: .month, for: now)?.end)
          ], updated: now)
      case "opencode": return try openCode()
      default: return Usage(error: "unknown provider")
      }
    } catch ProviderError.message(let message) { return Usage(error: message) } catch {
      return Usage(error: "read failed")
    }
  }

  func exists(_ url: URL) -> Bool { FileManager.default.fileExists(atPath: url.path) }

  func claudeToken(_ config: Config) throws -> String {
    // macOS Claude Code normally uses Keychain; older installs use this file.
    let file = claudeHome.appendingPathComponent(".credentials.json")
    if let data = try? Data(contentsOf: file), let token = credentialToken(data) { return token }
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: config.claudeKeychainService,
      kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecSuccess, let data = result as? Data {
      guard let token = credentialToken(data) else { throw ProviderError.message("auth stale") }
      return token
    }
    // Locally ad-hoc-signed builds may not have direct access to legacy Keychain
    // items. Apple's security reader supports those items and still enforces
    // their normal Keychain access controls. Capture its output only in memory.
    let process = Process()
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
    process.arguments = ["find-generic-password", "-s", config.claudeKeychainService, "-w"]
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    try process.run()
    let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
    DispatchQueue.global().asyncAfter(deadline: .now() + 15, execute: timeout)
    defer { timeout.cancel() }
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
      throw ProviderError.message(
        process.terminationStatus == 44 ? "not logged in" : "keychain locked")
    }
    guard let token = credentialToken(data) else { throw ProviderError.message("auth stale") }
    return token
  }

  func credentialToken(_ data: Data) -> String? {
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let auth = json["claudeAiOauth"] as? [String: Any],
      let token = auth["accessToken"] as? String, !token.isEmpty
    else { return nil }
    // A stale legacy file must not take precedence over a current Keychain login.
    if let expires = number(auth["expiresAt"]), expires / 1000 < Date().timeIntervalSince1970 {
      return nil
    }
    return token
  }

  func get(_ address: String, headers: [String: String]) async throws -> [String: Any] {
    var request = URLRequest(url: URL(string: address)!)
    request.allHTTPHeaderFields = headers
    let data: Data
    let response: URLResponse
    do { (data, response) = try await session.data(for: request) } catch {
      throw ProviderError.message("offline")
    }
    switch (response as? HTTPURLResponse)?.statusCode {
    case 200: break
    case 401: throw ProviderError.message("auth stale")
    case 403: throw ProviderError.message("no permission")
    case 404: throw ProviderError.message("not found")
    case 429: throw ProviderError.message("rate limited")
    default: throw ProviderError.message("offline")
    }
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw ProviderError.message("invalid response")
    }
    return json
  }

  public func codex() throws -> Usage {
    let root = codexHome.appendingPathComponent("sessions")
    guard
      let files = FileManager.default.enumerator(
        at: root, includingPropertiesForKeys: [.contentModificationDateKey],
        options: [.skipsHiddenFiles])
    else {
      return Usage(error: "no session data")
    }
    var candidates: [(URL, Date)] = []
    for case let url as URL in files
    where url.lastPathComponent.hasPrefix("rollout-") && url.pathExtension == "jsonl" {
      candidates.append(
        (
          url,
          (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)
            ?? .distantPast
        ))
    }
    // Session logs can be huge. Scan backwards in bounded chunks, skip a partial
    // final record, and keep looking if a newer event has no usable limits.
    var latest: Usage?
    for (url, modified) in candidates.sorted(by: { $0.1 > $1.1 }).prefix(20) {
      guard let handle = try? FileHandle(forReadingFrom: url) else { continue }
      defer { try? handle.close() }
      var offset = try handle.seekToEnd()
      var remainder = Data()
      var scanned = 0
      var found: Usage?
      while offset > 0 && scanned < 8 * 1024 * 1024 && found == nil {
        let count = min(Int(offset), 64 * 1024)
        offset -= UInt64(count)
        scanned += count
        try handle.seek(toOffset: offset)
        var chunk = try handle.read(upToCount: count) ?? Data()
        chunk.append(remainder)
        let lines = chunk.split(separator: 10, omittingEmptySubsequences: false)
        for line in lines.dropFirst(offset > 0 ? 1 : 0).reversed() {
          if let usage = Parsers.codexLine(String(decoding: line, as: UTF8.self)) {
            found = usage
            break
          }
        }
        remainder = offset > 0 ? Data(lines.first ?? Data.SubSequence()) : Data()
      }
      if var result = found {
        result.updated = result.updated ?? modified
        if latest == nil || result.updated! > (latest?.updated ?? .distantPast) { latest = result }
      }
    }
    guard var result = latest else { return Usage(error: "no session data") }
    if result.rows.contains(where: { ($0.resets ?? .distantFuture) <= Date() }) {
      result.error = "awaiting new session data"
    }
    return result
  }

  func openCode() throws -> Usage {
    let db = try Database(opencodeDB)
    let start =
      Calendar.current.dateInterval(of: .month, for: Date())!.start.timeIntervalSince1970 * 1000
    let rows = try db.query(
      "SELECT COALESCE(SUM(cost),0) AS total, COALESCE(SUM(CASE WHEN time_created >= \(Int64(start)) THEN cost ELSE 0 END),0) AS month, COALESCE(SUM(tokens_input + tokens_output),0) AS tokens FROM session"
    )
    guard let row = rows.first else { return Usage(error: "no data") }
    return Usage(
      text: [
        String(format: "mo $%.2f spent", number(row["month"]) ?? 0),
        String(
          format: "all $%.2f / %.1fM tok", number(row["total"]) ?? 0,
          (number(row["tokens"]) ?? 0) / 1e6),
      ], updated: Date())
  }
}

final class Database {
  var pointer: OpaquePointer?
  init(_ url: URL) throws {
    guard sqlite3_open_v2(url.path, &pointer, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
      sqlite3_close(pointer)
      pointer = nil
      throw ProviderError.message("database unavailable")
    }
    sqlite3_busy_timeout(pointer, 1000)
  }
  deinit { sqlite3_close(pointer) }
  func query(_ sql: String) throws -> [[String: Any]] {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(pointer, sql, -1, &statement, nil) == SQLITE_OK else {
      throw ProviderError.message("unsupported database")
    }
    defer { sqlite3_finalize(statement) }
    var rows: [[String: Any]] = []
    var code = sqlite3_step(statement)
    while code == SQLITE_ROW {
      var row: [String: Any] = [:]
      for i in 0..<sqlite3_column_count(statement) {
        let name = String(cString: sqlite3_column_name(statement, i))
        switch sqlite3_column_type(statement, i) {
        case SQLITE_INTEGER, SQLITE_FLOAT: row[name] = sqlite3_column_double(statement, i)
        case SQLITE_TEXT: row[name] = String(cString: sqlite3_column_text(statement, i))
        default: break
        }
      }
      rows.append(row)
      code = sqlite3_step(statement)
    }
    guard code == SQLITE_DONE else { throw ProviderError.message("database busy") }
    return rows
  }
}
