import AppKit
import UsageCore

final class OverlayView: NSView {
  var entries: [(String, Usage)] = []
  var movable = false
  var configError: String?
  var desiredHeight: CGFloat {
    48 + (configError == nil ? 0 : 24)
      + (entries.isEmpty
        ? 42
        : entries.reduce(0) { total, entry in
          total + 34 + CGFloat(max(1, entry.1.rows.count + entry.1.text.count)) * 23
            + (entry.1.error == nil ? 0 : 18)
        })
  }
  override var isFlipped: Bool { true }
  override func mouseDown(with event: NSEvent) {
    guard movable else { return }
    window?.performDrag(with: event)
  }
  func label(
    _ text: String, x: CGFloat, y: CGFloat, size: CGFloat = 11,
    color: NSColor = .white, weight: NSFont.Weight = .regular, width: CGFloat = 270
  ) {
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineBreakMode = .byTruncatingTail
    (text as NSString).draw(
      in: NSRect(x: x, y: y, width: width, height: 19),
      withAttributes: [
        .font: NSFont.monospacedSystemFont(ofSize: size, weight: weight),
        .foregroundColor: color, .paragraphStyle: paragraph,
      ])
  }
  override func draw(_ dirtyRect: NSRect) {
    NSColor(calibratedWhite: 0.075, alpha: 0.94).setFill()
    NSBezierPath(roundedRect: bounds, xRadius: 12, yRadius: 12).fill()
    label("USAGE", x: 16, y: 15, size: 12, weight: .bold)
    label(
      movable ? "DRAG TO MOVE" : "CLICK-THROUGH", x: 170, y: 16, size: 9,
      color: movable ? .systemOrange : .lightGray)
    var y: CGFloat = 42
    if let configError {
      label(configError, x: 16, y: y, size: 9, color: .systemOrange)
      y += 24
    }
    if entries.isEmpty { label("No supported tools detected", x: 16, y: y, color: .lightGray) }
    for (name, usage) in entries {
      label(
        name == "opencode" ? "OPENCD" : name.uppercased(), x: 16, y: y, size: 10, color: .lightGray,
        weight: .semibold)
      if let date = usage.updated {
        let age = max(0, Int(Date().timeIntervalSince(date) / 60))
        let text =
          age < 1
          ? "just now"
          : age < 60 ? "\(age)m ago" : age < 1440 ? "\(age / 60)h ago" : "\(age / 1440)d ago"
        label(text, x: 220, y: y, size: 9, color: .gray, width: 70)
      }
      y += 21
      for row in usage.rows {
        let color: NSColor =
          usage.error != nil
          ? .systemOrange
          : row.percent >= 85 ? .systemRed : row.percent >= 60 ? .systemOrange : .systemGreen
        label(row.label, x: 16, y: y, color: .lightGray, width: 34)
        let track = NSRect(x: 53, y: y + 4, width: 88, height: 6)
        NSColor(calibratedWhite: 0.25, alpha: 1).setFill()
        NSBezierPath(roundedRect: track, xRadius: 3, yRadius: 3).fill()
        color.setFill()
        NSBezierPath(
          roundedRect: NSRect(
            x: track.minX, y: track.minY, width: track.width * min(100, max(0, row.percent)) / 100,
            height: track.height), xRadius: 3, yRadius: 3
        ).fill()
        label(String(format: "%3.0f%%", row.percent), x: 150, y: y, color: color, width: 45)
        label(countdown(row.resets), x: 203, y: y, size: 10, color: .lightGray, width: 85)
        y += 23
      }
      for text in usage.text {
        label(text, x: 16, y: y, color: usage.error == nil ? .white : .systemOrange)
        y += 23
      }
      if usage.rows.isEmpty && usage.text.isEmpty {
        label("--", x: 16, y: y, color: .gray)
        y += 23
      }
      if let error = usage.error {
        label(error, x: 16, y: y, size: 9, color: .systemOrange)
        y += 18
      }
      y += 13
    }
  }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(
    ".config/usage-overlay")
  let providers = Providers()
  var config = Config()
  var enabled: [String] = []
  var cache: [String: Usage] = [:]
  var panel: NSPanel!
  var overlay = OverlayView()
  var status: NSStatusItem!
  var timer: Timer?
  var tick = 0
  var fetching = false
  var pendingRefresh = false
  var moveItem: NSMenuItem!
  var visibilityItem: NSMenuItem!
  var restorePosition = true

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    do {
      try FileManager.default.createDirectory(
        at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      let url = directory.appendingPathComponent("config.json")
      if !FileManager.default.fileExists(atPath: url.path),
        let example = Bundle.main.url(forResource: "config.example", withExtension: "json")
      {
        try FileManager.default.copyItem(at: example, to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
      }
      if let data = try? Data(contentsOf: directory.appendingPathComponent("macos-cache.json")),
        let saved = try? JSONDecoder().decode([String: Usage].self, from: data)
      {
        cache = saved.mapValues { value in
          var value = value
          value.error = "refreshing cached data"
          return value
        }
      }
    } catch { overlay.configError = "Could not create config folder" }
    panel = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: 304, height: 180),
      styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.title = "Usage Overlay"
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.backgroundColor = .clear
    panel.isOpaque = false
    panel.hasShadow = true
    panel.hidesOnDeactivate = false
    panel.ignoresMouseEvents = true
    panel.isMovableByWindowBackground = false
    panel.contentView = overlay
    panel.delegate = self
    status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    status.button?.image = NSImage(
      systemSymbolName: "chart.bar.fill", accessibilityDescription: "Usage Overlay")
    status.button?.toolTip = "Usage Overlay"
    let menu = NSMenu()
    add("Refresh now", #selector(refreshNow), to: menu)
    visibilityItem = add("Hide overlay", #selector(toggleVisibility), to: menu)
    moveItem = add("Move overlay", #selector(toggleMove), to: menu)
    add("Reset position", #selector(resetPosition), to: menu)
    menu.addItem(.separator())
    add("Open configuration folder", #selector(openConfiguration), to: menu)
    add("Reload configuration", #selector(reloadConfiguration), to: menu)
    add("Legend", #selector(legend), to: menu)
    menu.addItem(.separator())
    add("Quit Usage Overlay", #selector(quit), to: menu, key: "q")
    status.menu = menu
    NotificationCenter.default.addObserver(
      self, selector: #selector(screenChanged),
      name: NSApplication.didChangeScreenParametersNotification, object: nil)
    NSWorkspace.shared.notificationCenter.addObserver(
      self, selector: #selector(refreshNow), name: NSWorkspace.didWakeNotification, object: nil)
    reloadConfiguration()
    panel.orderFrontRegardless()
  }

  @discardableResult func add(
    _ title: String, _ action: Selector, to menu: NSMenu, key: String = ""
  ) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
    item.target = self
    menu.addItem(item)
    return item
  }

  @objc func reloadConfiguration() {
    do {
      let data = try Data(contentsOf: directory.appendingPathComponent("config.json"))
      guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw CocoaError(.fileReadCorruptFile)
      }
      config = Config(json)
      overlay.configError = nil
    } catch {
      config = Config()
      overlay.configError = "Invalid config; using defaults"
    }
    enabled = providers.detected(config)
    timer?.invalidate()
    timer = Timer.scheduledTimer(withTimeInterval: config.refreshSeconds, repeats: true) {
      [weak self] _ in
      Task { @MainActor in self?.refresh() }
    }
    tick = 0
    render()
    refreshNow()
  }

  @objc func refreshNow() { refresh(force: true) }
  func refresh(force: Bool = false) {
    guard !fetching else {
      pendingRefresh = pendingRefresh || force
      return
    }
    fetching = true
    let remote = force || tick % 3 == 0
    tick += 1
    let selected = enabled.filter { remote || ["codex", "opencode"].contains($0) }
    let configuration = config
    let source = providers
    Task {
      let results = await Task.detached(priority: .utility) {
        await withTaskGroup(of: (String, Usage).self, returning: [String: Usage].self) { group in
          for name in selected {
            group.addTask { (name, await source.fetch(name, config: configuration)) }
          }
          var results: [String: Usage] = [:]
          for await (name, usage) in group { results[name] = usage }
          return results
        }
      }.value
      for (name, result) in results {
        // An expired Codex snapshot is still newer than a cached snapshot.
        cache[name] =
          result.rows.isEmpty && result.text.isEmpty
          ? result.retainingLastGood(cache[name]) : result
      }
      if let data = try? JSONEncoder().encode(cache) {
        let url = directory.appendingPathComponent("macos-cache.json")
        try? data.write(to: url, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
      }
      fetching = false
      render()
      if pendingRefresh {
        pendingRefresh = false
        refresh(force: true)
      }
    }
  }

  func render() {
    overlay.entries = enabled.map { ($0, cache[$0] ?? Usage(error: "loading")) }
    overlay.setAccessibilityElement(true)
    overlay.setAccessibilityRole(.group)
    overlay.setAccessibilityLabel(
      "Usage Overlay. "
        + overlay.entries.map { name, usage in
          name.capitalized + ": "
            + (usage.rows.map {
              "\($0.label) \(Int($0.percent)) percent used, \(countdown($0.resets))"
            } + usage.text + (usage.error.map { [$0] } ?? [])).joined(separator: ", ")
        }.joined(separator: ". "))
    let old = panel.frame
    let height = overlay.desiredHeight
    var point = NSPoint(x: old.minX, y: old.maxY - height)
    let defaults = UserDefaults.standard
    if restorePosition {
      if defaults.object(forKey: "overlayX") != nil {
        point = NSPoint(
          x: defaults.double(forKey: "overlayX"), y: defaults.double(forKey: "overlayTop") - height)
      } else if let screen = NSScreen.main {
        let frame = screen.visibleFrame
        point.x =
          config.corner.hasSuffix("left")
          ? frame.minX + config.marginX : frame.maxX - 304 - config.marginX
        point.y =
          config.corner.hasPrefix("top")
          ? frame.maxY - height - config.marginY : frame.minY + config.marginY
      }
      restorePosition = false
    }
    let proposed = NSRect(origin: point, size: NSSize(width: 304, height: height))
    let screen = NSScreen.screens.max { a, b in
      let ai = a.visibleFrame.intersection(proposed)
      let bi = b.visibleFrame.intersection(proposed)
      return (ai.isNull ? 0 : ai.width * ai.height) < (bi.isNull ? 0 : bi.width * bi.height)
    }
    if let frame = screen?.visibleFrame {
      point.x = min(max(point.x, frame.minX), max(frame.minX, frame.maxX - 304))
      point.y = min(max(point.y, frame.minY), max(frame.minY, frame.maxY - height))
    }
    panel.setFrame(NSRect(origin: point, size: proposed.size), display: true)
    overlay.needsDisplay = true
    status.button?.toolTip = enabled.map { name in
      let usage = cache[name]
      let percent = usage?.rows.map(\.percent).max().map { String(format: " %.0f%%", $0) } ?? ""
      return name.capitalized + percent + (usage?.error.map { " (\($0))" } ?? "")
    }.joined(separator: "\n")
  }

  func windowDidMove(_ notification: Notification) {
    guard overlay.movable else { return }
    UserDefaults.standard.set(panel.frame.minX, forKey: "overlayX")
    UserDefaults.standard.set(panel.frame.maxY, forKey: "overlayTop")
  }
  @objc func screenChanged() { render() }
  @objc func toggleMove() {
    overlay.movable.toggle()
    panel.ignoresMouseEvents = !overlay.movable
    moveItem.title = overlay.movable ? "Lock overlay (click-through)" : "Move overlay"
    overlay.needsDisplay = true
  }
  @objc func toggleVisibility() {
    if panel.isVisible {
      panel.orderOut(nil)
      visibilityItem.title = "Show overlay"
    } else {
      panel.orderFrontRegardless()
      visibilityItem.title = "Hide overlay"
    }
  }
  @objc func resetPosition() {
    UserDefaults.standard.removeObject(forKey: "overlayX")
    UserDefaults.standard.removeObject(forKey: "overlayTop")
    restorePosition = true
    render()
  }
  @objc func openConfiguration() { NSWorkspace.shared.open(directory) }
  @objc func legend() {
    let alert = NSAlert()
    alert.messageText = "Usage Overlay"
    alert.informativeText =
      "Bars show quota used: green below 60%, amber from 60%, red from 85%. Times show the next reset. Claude's spnd row is the percentage of its spending limit used.\n\nOn errors, the last good reading stays amber with its age. Codex is a snapshot from local session logs; use Codex to update it. OpenCode shows locally tracked spend, not a quota.\n\nChoose Move overlay to drag it, then Lock overlay to restore click-through. Quit and refresh are in this menu."
    NSApp.activate(ignoringOtherApps: true)
    alert.runModal()
  }
  @objc func quit() { NSApp.terminate(nil) }
}

@main
struct UsageOverlayApp {
  @MainActor static func main() {
    if CommandLine.arguments.contains("--diagnose") {
      // Only sanitized usage values, never source credentials, appear in this output.
      Task {
        let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(
          ".config/usage-overlay/config.json")
        let json =
          (try? Data(contentsOf: directory)).flatMap {
            try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
          } ?? [:]
        let config = Config(json)
        let source = Providers()
        var results: [String: Usage] = [:]
        for name in source.detected(config) {
          results[name] = await source.fetch(name, config: config)
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        if let data = try? encoder.encode(results), let text = String(data: data, encoding: .utf8) {
          print(text)
        }
        exit(0)
      }
      dispatchMain()
    } else {
      let application = NSApplication.shared
      if let id = Bundle.main.bundleIdentifier,
        NSRunningApplication.runningApplications(withBundleIdentifier: id).contains(where: {
          $0.processIdentifier != ProcessInfo.processInfo.processIdentifier
        })
      {
        exit(0)
      }
      let delegate = AppDelegate()
      application.delegate = delegate
      application.run()
    }
  }
}
