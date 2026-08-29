import AppKit
import ApplicationServices
import Foundation

enum State: String { case idle, dialing, connected, ended, unknown }

struct Result: Encodable {
  let ok: Bool
  let command: String
  let state: State
  let authorized: Bool
  let action: String
  let message: String
  let errorCode: String?
}

func emit(_ result: Result, exit: Int32 = 0) -> Never {
  let data = try! JSONEncoder().encode(result)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  Foundation.exit(exit)
}

let arguments = CommandLine.arguments
guard arguments.count == 4, ["probe", "call", "answer", "hangup"].contains(arguments[1]) else {
  emit(Result(ok: false, command: arguments.dropFirst().first ?? "unknown", state: .unknown, authorized: AXIsProcessTrusted(), action: "none", message: "usage: facetime-ax probe|call|answer|hangup <handle> <identity>", errorCode: "invalid-arguments"), exit: 2)
}

let command = arguments[1]
let handle = arguments[2]
let identity = arguments[3]
let authorized = AXIsProcessTrusted()
guard authorized else {
  emit(Result(ok: false, command: command, state: .unknown, authorized: false, action: "none", message: "Accessibility permission is required", errorCode: "accessibility-denied"), exit: 1)
}

// This phase deliberately fails closed. Future phases provide the verified AX
// element traversal; no coordinate click is ever acceptable here.
if command == "probe" {
  emit(Result(ok: true, command: command, state: .idle, authorized: true, action: "probe", message: "Accessibility authorization granted", errorCode: nil))
}

guard let escaped = handle.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
      let url = URL(string: "facetime-audio://\(escaped)") else {
  emit(Result(ok: false, command: command, state: .unknown, authorized: true, action: "none", message: "Invalid FaceTime handle", errorCode: "invalid-handle"), exit: 2)
}

if command == "call" {
  NSWorkspace.shared.open(url)
  emit(Result(ok: false, command: command, state: .dialing, authorized: true, action: "open-url", message: "FaceTime opened; semantic AX confirmation is unavailable", errorCode: "ambiguous-surface"), exit: 1)
}

emit(Result(ok: false, command: command, state: .unknown, authorized: true, action: "none", message: "No unambiguous FaceTime surface naming \(identity) was found", errorCode: "ambiguous-surface"), exit: 1)
