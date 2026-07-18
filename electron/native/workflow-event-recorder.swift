import Cocoa
import CoreGraphics
import Foundation

// Minimal macOS event tap used by Watch. It records structure, not typed content:
// key codes/modifiers are retained, while text values are deliberately omitted.
// Accessibility permission is required; failure is reported on stderr and exit 2.

func isoNow() -> String {
  let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return f.string(from: Date())
}

var recordFile: String?
if let index = CommandLine.arguments.firstIndex(of: "--record-file"), index + 1 < CommandLine.arguments.count { recordFile = CommandLine.arguments[index + 1] }

func json(_ value: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: value), let line = String(data: data, encoding: .utf8) {
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
    fflush(stdout)
    if let recordFile, let bytes = (line + "\n").data(using: .utf8) {
      if !FileManager.default.fileExists(atPath: recordFile) { FileManager.default.createFile(atPath: recordFile, contents: nil) }
      if let handle = try? FileHandle(forWritingTo: URL(fileURLWithPath: recordFile)) { try? handle.seekToEnd(); try? handle.write(contentsOf: bytes); try? handle.close() }
    }
  }
}

func context() -> [String: Any] {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  // Quartz returns front-to-back order. Prefer the first normal application
  // window; NSWorkspace can remain stale while a window is being rearranged.
  let ignored = Set(["Window Server", "Dock", "Control Centre", "Notification Center"])
  let w = list.first(where: { (($0[kCGWindowLayer as String] as? Int) ?? 99) == 0 && !ignored.contains(($0[kCGWindowOwnerName as String] as? String) ?? "") })
  let pid = (w?[kCGWindowOwnerPID as String] as? Int32) ?? NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
  let app = NSRunningApplication(processIdentifier: pid) ?? NSWorkspace.shared.frontmostApplication
  var result: [String: Any] = ["app": app?.localizedName ?? (w?[kCGWindowOwnerName as String] as? String ?? "Unknown"), "bundleId": app?.bundleIdentifier ?? ""]
  if let w {
    result["windowTitle"] = w[kCGWindowName as String] as? String ?? ""
    if let b = w[kCGWindowBounds as String] as? [String: Any] { result["bounds"] = b }
  }
  return result
}

func emit(_ type: String, _ extra: [String: Any] = [:]) {
  var item: [String: Any] = ["type": type, "at": isoNow()]
  for (k, v) in context() { item[k] = v }
  for (k, v) in extra { item[k] = v }
  json(item)
}

func semanticElement(at point: CGPoint) -> [String: Any] {
  let system = AXUIElementCreateSystemWide()
  var element: AXUIElement?
  guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &element) == .success, let element else { return [:] }
  func inspect(_ node: AXUIElement, depth: Int) -> [String: Any] {
    var result: [String: Any] = [:]
    for (attribute, key) in [(kAXRoleAttribute, "elementRole"), (kAXSubroleAttribute, "elementSubrole"), (kAXTitleAttribute, "elementTitle"), (kAXDescriptionAttribute, "elementDescription"), (kAXHelpAttribute, "elementHelp"), (kAXPlaceholderValueAttribute, "elementPlaceholder")] {
      var value: CFTypeRef?
      if AXUIElementCopyAttributeValue(node, attribute as CFString, &value) == .success, let text = value as? String, !text.isEmpty { result[key] = text }
    }
    guard depth < 4 else { return result }
    var children: CFTypeRef?
    guard AXUIElementCopyAttributeValue(node, kAXChildrenAttribute as CFString, &children) == .success, let list = children as? [AXUIElement] else { return result }
    for child in list {
      let deeper = inspect(child, depth: depth + 1)
      // Chrome sometimes returns an unnamed AXGroup at the hit point while
      // exposing the useful text field/button one or two descendants below it.
      // Keep the nearest role but borrow the first meaningful name/help text.
      for key in ["elementTitle", "elementDescription", "elementHelp", "elementPlaceholder"] where result[key] == nil {
        if let value = deeper[key] { result[key] = value }
      }
      if result["elementRole"] == nil, let role = deeper["elementRole"] { result["elementRole"] = role }
    }
    return result
  }
  return inspect(element, depth: 0)
}

func replayTrace() {
  let data = FileHandle.standardInput.readDataToEndOfFile()
  guard let raw = String(data: data, encoding: .utf8) else { exit(4) }
  var previous = Date()
  for line in raw.split(whereSeparator: { $0 == "\n" || $0 == "\r" }) {
    guard let bytes = line.data(using: .utf8), let event = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any], let type = event["type"] as? String else { continue }
    if let stamp = event["at"] as? String, let date = ISO8601DateFormatter().date(from: stamp) {
      let delay = max(0.02, min(1.5, date.timeIntervalSince(previous))); usleep(useconds_t(delay * 1_000_000)); previous = date
    }
    if type == "mouse.click", let x = event["x"] as? CGFloat, let y = event["y"] as? CGFloat {
      let button = (event["button"] as? String) == "right" ? CGMouseButton.right : CGMouseButton.left
      let down = CGEvent(mouseEventSource: nil, mouseType: button == .right ? .rightMouseDown : .leftMouseDown, mouseCursorPosition: CGPoint(x:x,y:y), mouseButton: button)
      let up = CGEvent(mouseEventSource: nil, mouseType: button == .right ? .rightMouseUp : .leftMouseUp, mouseCursorPosition: CGPoint(x:x,y:y), mouseButton: button)
      down?.post(tap: .cghidEventTap); up?.post(tap: .cghidEventTap)
    } else if type == "key.press", let code = event["keyCode"] as? Int64 {
      let flags = CGEventFlags(rawValue: UInt64(event["modifiers"] as? UInt64 ?? 0))
      let down = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: true)
      let up = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: false)
      down?.flags = flags; up?.flags = flags; down?.post(tap: .cghidEventTap); up?.post(tap: .cghidEventTap)
    }
  }
  emit("replay.stop")
}

if CommandLine.arguments.contains("--replay") { replayTrace(); exit(0) }

emit("session.start", ["version": 1, "textPolicy": "omitted", "accessibilityTrusted": AXIsProcessTrusted()])
var lastApp = ""
var lastWindow = ""
let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .userInteractive))
timer.schedule(deadline: .now(), repeating: .milliseconds(250))
timer.setEventHandler {
  let c = context(); let app = c["bundleId"] as? String ?? ""; let title = c["windowTitle"] as? String ?? ""
  if app != lastApp || title != lastWindow {
    lastApp = app; lastWindow = title
    var x = c; x["previousBundleId"] = app; emit("window.activate", x)
  }
}
timer.resume()

// Some macOS accessibility drivers do not deliver mouse-down events through
// the listen-only tap even when Input Monitoring is enabled. Poll the session
// button state as a fallback so physical clicks still become deterministic
// events; the renderer can de-duplicate a tap and poll event at the same time.
let mousePoll = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .userInteractive))
var lastLeftDown = false
mousePoll.schedule(deadline: .now(), repeating: .milliseconds(25))
mousePoll.setEventHandler {
  let down = CGEventSource.buttonState(.combinedSessionState, button: .left)
  if down && !lastLeftDown, let event = CGEvent(source: nil) {
    let p = event.location
    emit("mouse.click", ["x": p.x, "y": p.y, "button": "left", "capture": "state-poll"] .merging(semanticElement(at: p)) { a, _ in a })
  }
  lastLeftDown = down
}
mousePoll.resume()

let mask = (CGEventMask(1) << CGEventType.leftMouseDown.rawValue) |
  (CGEventMask(1) << CGEventType.rightMouseDown.rawValue) |
  (CGEventMask(1) << CGEventType.keyDown.rawValue)
let callback: CGEventTapCallBack = { _, type, event, _ in
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput { return Unmanaged.passUnretained(event) }
  if type == .leftMouseDown || type == .rightMouseDown {
    let p = event.location; emit("mouse.click", ["x": p.x, "y": p.y, "button": type == .rightMouseDown ? "right" : "left"].merging(semanticElement(at: p)) { a, _ in a })
  } else if type == .keyDown {
    emit("key.press", ["keyCode": event.getIntegerValueField(.keyboardEventKeycode), "modifiers": event.flags.rawValue, "textRedacted": true])
  }
  return Unmanaged.passUnretained(event)
}
guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: callback, userInfo: nil) else {
  fputs("Could not create the macOS event tap. Check Input Monitoring permission.\n", stderr); exit(3)
}
let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
signal(SIGINT) { _ in emit("session.stop"); exit(0) }
signal(SIGTERM) { _ in emit("session.stop"); exit(0) }
CFRunLoopRun()
