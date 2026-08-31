import Foundation

func folded(_ value: String) -> String {
  value.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: .current)
    .lowercased()
    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    .trimmingCharacters(in: .whitespacesAndNewlines)
}

func digits(_ value: String) -> String {
  value.filter(\.isNumber)
}

func containsPhrase(_ value: String, _ phrase: String) -> Bool {
  let escaped = NSRegularExpression.escapedPattern(for: phrase)
  let pattern = "(^|[^\\p{L}\\p{N}])\(escaped)($|[^\\p{L}\\p{N}])"
  return value.range(of: pattern, options: .regularExpression) != nil
}

struct IdentityMatcher {
  let phrases: [String]
  let phoneNumbers: [String]

  init(handle: String, identity: String) {
    phrases = [identity, handle]
      .map(folded)
      .filter { $0.count >= 2 && !$0.allSatisfy(\.isNumber) }
    phoneNumbers = [handle, identity]
      .map(digits)
      .filter { $0.count >= 10 }
  }

  func matches(_ values: [String]) -> Bool {
    values.contains { raw in
      let value = folded(raw)
      if phrases.contains(where: { containsPhrase(value, $0) }) { return true }
      return phoneNumbers.contains(digits(raw))
    }
  }
}
