/**
 * `PII_PATTERNS`: shared table of machine-identity and PII `{ code, pattern, replacement }` entries used for federation detection and free-text redaction.
 *
 * The one list that `server/services/agent/agentContextMcp.js#redactAgentContextText`, `server/services/agent/agentErrorAnalysis.js#redactFailureSnippet` and `federationSafety.js#federationSafetyFindings` read to recognize a home path, network host, IP/MAC literal, email, phone number or labelled GPS coordinate
 * before it lands in a log line, an LLM prompt or a federated payload (three copies drifted, #7474). DETECTION: `pattern.test(text)` as-is. REPLACEMENT: `text.replace(globalPattern(pattern), replacement)`.
 * Every `pattern` is non-global on purpose: `federationSafetyFindings` calls `.test()` on the SAME regex across many strings, and a global flag makes that stateful (`lastIndex` can silently miss a match); `globalPattern()` derives a fresh global copy for `.replace()`.
 * Its own dependency-free leaf (AGENTS.md "Watch the import budget"), not part of `federationSafety.js`, which also reaches `secretText.js`/`secretKeys.js` for the credential-shaped checks that stay OUTSIDE this table. Pure; reads no environment.
 */

export const PII_PATTERNS = Object.freeze([
  // Home directories, including file URLs in Node stack frames. Keep the rest of the path legible.
  Object.freeze({ code: 'home-path', pattern: /(?<=^|[\s"'`(]|file:\/\/)\/(Users|home)\/[^/\s"'`]+/i, replacement: '/$1/<user>' }),
  // Any Windows drive-absolute path (`C:\Users\<name>\…`, `D:\secrets\…`).
  Object.freeze({ code: 'windows-path', pattern: /\b[A-Za-z]:[\\/](?:Users[\\/])?[^\s"'`]+/, replacement: '<path>' }),
  Object.freeze({
    code: 'ip-literal',
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/,
    replacement: '<ip>',
  }),
  // IPv6, which also matches a MAC and a `14:25:30` clock time: an accepted over-redaction (rare in free text, costs a reader nothing).
  Object.freeze({ code: 'ip-literal', pattern: /\b(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{0,4}\b/, replacement: '<ip>' }),
  // Tailscale MagicDNS / mDNS hostnames: consume ALL leading labels so `machine.tailnet.ts.net` doesn't leak `machine`.
  Object.freeze({ code: 'network-host', pattern: /\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:ts\.net|local)\b/i, replacement: '<host>' }),
  Object.freeze({ code: 'mac-address', pattern: /\b[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}\b/, replacement: '<mac>' }),
  Object.freeze({ code: 'email-address', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, replacement: '<email>' }),
  Object.freeze({ code: 'phone-number', pattern: /\b\+?\d[\d ().-]{8,}\d\b/, replacement: '<phone>' }),
  // Only the LABELLED form (a bare decimal pair is indistinguishable from other numbers); keeps the label so the redaction still reads as a coordinate.
  Object.freeze({ code: 'gps-coordinate', pattern: /\b(latitude|longitude|lat|lon|lng)\s*[:=]\s*-?\d{1,3}(?:\.\d+)?/i, replacement: '$1=[REDACTED]' }),
]);

/**
 * Replacement vocabularies, keyed by pattern `code`. Both redaction consumers share the PATTERNS (the drift #7474 kills) but keep DIFFERENT output text, each an observable contract: `agentContextMcp` emits bracketed `[REDACTED X]` markers pinned by value by the critical
 * `search-redacts-and-omits-fields` case in `test/fixtures/agent-context-eval.json` (and collapses a home path to `~`); `agentErrorAnalysis` emits terse `<x>` placeholders for one-line log snippets. Folding them would silently rewrite every MCP marker (a behavior change a critical privacy eval catches).
 * A code omitted from a vocabulary falls back to the table's own `replacement`, so adding a pattern never silently un-redacts a consumer.
 */
export const PII_REPLACEMENTS = Object.freeze({
  // `agentContextMcp.js#redactAgentContextText` — MCP search/summary payloads.
  bracketed: Object.freeze({
    'home-path': '~',
    'windows-path': '~',
    'ip-literal': '[REDACTED IP]',
    'network-host': '[REDACTED HOST]',
    'mac-address': '[REDACTED MAC]',
    'email-address': '[REDACTED EMAIL]',
    'phone-number': '[REDACTED PHONE]',
  }),
  // `agentErrorAnalysis.js#redactFailureSnippet`: one-line failure snippets; every code takes the table default, so deliberately empty rather than a second copy that could drift.
  terse: Object.freeze({}),
});

/** A global-flagged copy of `pattern`, safe for a `.replace()` caller to reuse. */
export function globalPattern(pattern) {
  return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
}

/** Apply every entry in `PII_PATTERNS` to `text`, in table order, shared by both redaction consumers so table or order changes reach both. `vocabulary` picks the output text (see `PII_REPLACEMENTS`); an unnamed code falls back to the entry's `replacement`. */
export function redactPii(text, vocabulary = PII_REPLACEMENTS.terse) {
  return PII_PATTERNS.reduce(
    (out, { code, pattern, replacement }) => out.replace(globalPattern(pattern), vocabulary[code] ?? replacement),
    text,
  );
}
