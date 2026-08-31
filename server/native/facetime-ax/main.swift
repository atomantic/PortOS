import AppKit
import ApplicationServices
import Foundation

enum State: String, Encodable { case idle, dialing, connected, ended, unknown }

struct Result: Encodable {
  let ok: Bool
  let command: String
  let state: State
  let authorized: Bool
  let action: String
  let message: String
  let errorCode: String?

  enum CodingKeys: String, CodingKey {
    case ok, command, state, authorized, action, message, errorCode
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(ok, forKey: .ok)
    try container.encode(command, forKey: .command)
    try container.encode(state, forKey: .state)
    try container.encode(authorized, forKey: .authorized)
    try container.encode(action, forKey: .action)
    try container.encode(message, forKey: .message)
    if let errorCode {
      try container.encode(errorCode, forKey: .errorCode)
    } else {
      try container.encodeNil(forKey: .errorCode)
    }
  }
}

func emit(_ result: Result, exit: Int32 = 0) -> Never {
  let data = try! JSONEncoder().encode(result)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  Foundation.exit(exit)
}

// AX trees are process-owned and can change between any two reads. Keep a
// bounded, value-only snapshot so classification never follows a stale element
// except for the final, semantically verified AXPress.
struct Node {
  let element: AXUIElement
  let parent: Int?
  let role: String
  let text: [String]
  let actions: Set<String>
}

struct Snapshot {
  let nodes: [Node]
  let truncated: Bool
}

let semanticAttributes: [CFString] = [
  kAXTitleAttribute as CFString,
  kAXDescriptionAttribute as CFString,
  kAXHelpAttribute as CFString,
  kAXValueAttribute as CFString,
  kAXRoleDescriptionAttribute as CFString,
  kAXIdentifierAttribute as CFString,
]

func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name, &value) == .success ? value : nil
}

func stringAttribute(_ element: AXUIElement, _ name: CFString) -> String? {
  attribute(element, name) as? String
}

func childElements(_ element: AXUIElement) -> [AXUIElement] {
  attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
}

func actionNames(_ element: AXUIElement) -> Set<String> {
  var names: CFArray?
  guard AXUIElementCopyActionNames(element, &names) == .success,
        let values = names as? [String] else { return [] }
  return Set(values)
}

func snapshot(_ application: NSRunningApplication) -> Snapshot? {
  let root = AXUIElementCreateApplication(application.processIdentifier)
  var rootAttributes: CFArray?
  guard AXUIElementCopyAttributeNames(root, &rootAttributes) == .success else { return nil }
  var pending: [(AXUIElement, Int?)] = [(root, nil)]
  var nodes: [Node] = []
  var cursor = 0
  let maximumNodes = 2_000

  while cursor < pending.count && nodes.count < maximumNodes {
    let (element, parent) = pending[cursor]
    cursor += 1
    let index = nodes.count
    let values = semanticAttributes.compactMap { stringAttribute(element, $0) }
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
    let role = stringAttribute(element, kAXRoleAttribute as CFString) ?? ""
    let interactiveRoles = [kAXButtonRole as String, kAXMenuButtonRole as String, "AXLink"]
    nodes.append(Node(
      element: element,
      parent: parent,
      role: role,
      text: values,
      actions: interactiveRoles.contains(role) ? actionNames(element) : []
    ))
    pending.append(contentsOf: childElements(element).map { ($0, index) })
  }
  return Snapshot(nodes: nodes, truncated: cursor < pending.count)
}

let faceTimeBundle = "com.apple.FaceTime"

func faceTimeApplications() -> [NSRunningApplication] {
  NSRunningApplication.runningApplications(withBundleIdentifier: faceTimeBundle)
}

func notificationApplications() -> [NSRunningApplication] {
  let running = NSWorkspace.shared.runningApplications
  let notificationCenter = running.filter { application in
    application.bundleIdentifier == "com.apple.notificationcenterui"
      || application.localizedName == "NotificationCenter"
      || application.executableURL?.lastPathComponent == "NotificationCenter"
  }
  if !notificationCenter.isEmpty { return notificationCenter }
  return running.filter { $0.bundleIdentifier == "com.apple.controlcenter" }
}

func containsAny(_ values: [String], _ words: [String]) -> Bool {
  let joined = folded(values.joined(separator: " "))
  return words.contains { containsPhrase(joined, $0) }
}

func ancestors(_ index: Int, nodes: [Node], limit: Int = 5) -> Set<Int> {
  var result: Set<Int> = [index]
  var current = nodes[index].parent
  var remaining = limit
  while let candidate = current, remaining > 0 {
    if nodes[candidate].role == (kAXApplicationRole as String) { break }
    result.insert(candidate)
    current = nodes[candidate].parent
    remaining -= 1
  }
  return result
}

func semanticallyRelated(_ first: Int, _ second: Int, nodes: [Node]) -> Bool {
  let common = ancestors(first, nodes: nodes).intersection(ancestors(second, nodes: nodes))
  return common.contains { index in
    ![kAXApplicationRole as String, kAXWindowRole as String, kAXScrollAreaRole as String]
      .contains(nodes[index].role)
  }
}

func pressable(_ node: Node) -> Bool {
  node.actions.contains(kAXPressAction as String)
}

let answerWords = ["answer", "accept", "answerbutton", "acceptbutton"]
let hangupWords = ["hang up", "hangup", "end call", "end", "hangupbutton", "endcallbutton"]
let dialingWords = ["calling", "dialing", "ringing", "connecting", "cancel call", "cancel", "cancelbutton"]
let connectedWords = ["connected", "mute", "microphone", "add people", "shareplay"]
let endedWords = ["call ended", "ended"]

func matchingControls(nodes: [Node], matcher: IdentityMatcher, words: [String]) -> [Node] {
  let identityIndices = nodes.indices.filter { matcher.matches(nodes[$0].text) }
  return nodes.enumerated().compactMap { (index, node) -> Node? in
    guard pressable(node), containsAny(node.text, words),
          identityIndices.contains(where: { semanticallyRelated(index, $0, nodes: nodes) }) else { return nil }
    return node
  }
}

func identitySurfaceTexts(nodes: [Node], matcher: IdentityMatcher) -> [[String]] {
  let identityIndices = nodes.indices.filter { matcher.matches(nodes[$0].text) }
  return identityIndices.map { identityIndex in
    nodes.indices.filter { semanticallyRelated($0, identityIndex, nodes: nodes) }
      .flatMap { nodes[$0].text }
  }
}

func classifyFaceTime(nodes: [Node], matcher: IdentityMatcher) -> State {
  let surfaces = identitySurfaceTexts(nodes: nodes, matcher: matcher)
  guard !surfaces.isEmpty else { return .idle }
  let states = surfaces.map { surfaceText -> State in
    if containsAny(surfaceText, dialingWords) { return .dialing }
    if containsAny(surfaceText, connectedWords) { return .connected }
    if containsAny(surfaceText, endedWords) { return .ended }
    return .idle
  }
  if states.contains(.connected) { return .connected }
  if states.contains(.dialing) { return .dialing }
  if !matchingControls(nodes: nodes, matcher: matcher, words: hangupWords).isEmpty { return .connected }
  if states.contains(.ended) { return .ended }
  // The configured identity can appear in recents while FaceTime is idle.
  // Identity text alone is not call-state evidence.
  return .idle
}

func faceTimeState(matcher: IdentityMatcher) -> State {
  let states = faceTimeApplications().map { application -> State in
    guard let result = snapshot(application), !result.truncated else { return .unknown }
    return classifyFaceTime(nodes: result.nodes, matcher: matcher)
  }
  if states.contains(.connected) { return .connected }
  if states.contains(.dialing) { return .dialing }
  if states.contains(.ended) { return .ended }
  if states.contains(.unknown) { return .unknown }
  return .idle
}

func incomingAnswerControls(matcher: IdentityMatcher) -> (controls: [Node], incomplete: Bool) {
  var controls: [Node] = []
  var incomplete = false
  for application in notificationApplications() {
    guard let result = snapshot(application), !result.truncated else {
      incomplete = true
      continue
    }
    controls.append(contentsOf: matchingControls(nodes: result.nodes, matcher: matcher, words: answerWords))
  }
  return (controls, incomplete)
}

func probe(matcher: IdentityMatcher) -> State {
  // A matching incoming notification takes precedence over FaceTime's generic
  // idle window. An unmatched notification is intentionally indistinguishable
  // from no notification: do not surface its text, state, or existence.
  let incoming = incomingAnswerControls(matcher: matcher)
  if incoming.controls.count == 1 { return .dialing }
  let state = faceTimeState(matcher: matcher)
  if incoming.controls.count > 1 { return .unknown }
  if state != .idle { return state }
  if incoming.incomplete { return .unknown }
  return state
}

func waitForState(_ expected: Set<State>, matcher: IdentityMatcher, timeout: TimeInterval) -> State? {
  let deadline = Date().addingTimeInterval(timeout)
  while Date() < deadline {
    let state = faceTimeState(matcher: matcher)
    if expected.contains(state) { return state }
    RunLoop.current.run(until: min(deadline, Date().addingTimeInterval(0.3)))
  }
  return nil
}

func ambiguous(_ command: String, state: State = .unknown) -> Never {
  // Never include text read from an AX surface here. In particular, a caller
  // that does not match the configured identity must leave no observable name.
  emit(Result(ok: false, command: command, state: state, authorized: true, action: "none", message: "No single matching FaceTime control was found", errorCode: "ambiguous-surface"), exit: 1)
}

let arguments = CommandLine.arguments
guard arguments.count == 4, ["probe", "call", "answer", "hangup"].contains(arguments[1]) else {
  emit(Result(ok: false, command: arguments.dropFirst().first ?? "unknown", state: .unknown, authorized: AXIsProcessTrusted(), action: "none", message: "usage: facetime-ax probe|call|answer|hangup <handle> <identity>", errorCode: "invalid-arguments"), exit: 2)
}

let command = arguments[1]
let handle = arguments[2]
let identity = arguments[3]
guard AXIsProcessTrusted() else {
  emit(Result(ok: false, command: command, state: .unknown, authorized: false, action: "none", message: "Accessibility permission is required", errorCode: "accessibility-denied"), exit: 1)
}

let matcher = IdentityMatcher(handle: handle, identity: identity)
guard !matcher.phrases.isEmpty || !matcher.phoneNumbers.isEmpty else {
  emit(Result(ok: false, command: command, state: .unknown, authorized: true, action: "none", message: "Configured FaceTime identity is invalid", errorCode: "invalid-identity"), exit: 2)
}

if command == "probe" {
  emit(Result(ok: true, command: command, state: probe(matcher: matcher), authorized: true, action: "probe", message: "FaceTime state inspected", errorCode: nil))
}

if command == "call" {
  guard let escaped = handle.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
        let url = URL(string: "facetime-audio://\(escaped)"),
        NSWorkspace.shared.open(url) else {
    emit(Result(ok: false, command: command, state: .unknown, authorized: true, action: "none", message: "Invalid FaceTime handle", errorCode: "invalid-handle"), exit: 2)
  }
  guard let state = waitForState([.dialing, .connected], matcher: matcher, timeout: 5) else {
    ambiguous(command, state: .dialing)
  }
  emit(Result(ok: true, command: command, state: state, authorized: true, action: "open-url", message: "FaceTime call started", errorCode: nil))
}

if command == "answer" {
  let incoming = incomingAnswerControls(matcher: matcher)
  guard !incoming.incomplete, incoming.controls.count == 1 else {
    ambiguous(command, state: incoming.controls.isEmpty ? .idle : .dialing)
  }
  guard AXUIElementPerformAction(incoming.controls[0].element, kAXPressAction as CFString) == .success else {
    emit(Result(ok: false, command: command, state: .dialing, authorized: true, action: "none", message: "The matching answer control could not be pressed", errorCode: "action-failed"), exit: 1)
  }
  let state = waitForState([.connected], matcher: matcher, timeout: 5) ?? .connected
  emit(Result(ok: true, command: command, state: state, authorized: true, action: "press-notification-action", message: "Answered the incoming call", errorCode: nil))
}

let applications = faceTimeApplications()
let controls = applications.flatMap { application -> [Node] in
  guard let result = snapshot(application), !result.truncated else { return [] }
  return matchingControls(nodes: result.nodes, matcher: matcher, words: hangupWords)
}
guard controls.count == 1 else { ambiguous(command, state: faceTimeState(matcher: matcher)) }
guard AXUIElementPerformAction(controls[0].element, kAXPressAction as CFString) == .success else {
  emit(Result(ok: false, command: command, state: .connected, authorized: true, action: "none", message: "The matching hang-up control could not be pressed", errorCode: "action-failed"), exit: 1)
}
let ended = waitForState([.ended, .idle], matcher: matcher, timeout: 5) ?? .ended
emit(Result(ok: true, command: command, state: ended, authorized: true, action: "press-call-action", message: "FaceTime call ended", errorCode: nil))
