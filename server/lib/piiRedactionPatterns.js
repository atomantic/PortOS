/**
 * Shared machine-identity / PII pattern table for free text — the pieces
 * `server/services/agentContextMcp.js#redactAgentContextText`,
 * `server/services/agentErrorAnalysis.js#redactFailureSnippet`, and
 * `federationSafety.js#federationSafetyFindings` each need to recognize a
 * home path, network host, IP/MAC literal, email, phone number, or labelled
 * GPS coordinate before it lands in a log line, an LLM prompt, or a
 * federated payload. Three copies of this table drifted independently
 * (#7474) — a fix to one (a multi-label host, a Windows path, IPv6) never
 * reached the others. This is now the one list all three read.
 *
 * Two ways to use an entry:
 *  - DETECTION (`federationSafety.js`): `pattern.test(text)` as-is.
 *  - REPLACEMENT (the two services): `text.replace(globalPattern(pattern),
 *    replacement)` to rewrite every match before the text is emitted.
 *
 * Every `pattern` here is intentionally non-global — `federationSafetyFindings`
 * calls `.test()` on the SAME regex object across many strings in one walk,
 * and a global flag makes that stateful: a later call can silently miss a
 * match because `lastIndex` didn't reset to 0. `globalPattern()` derives a
 * fresh global copy for a `.replace()` caller instead of mutating the shared
 * regex object.
 *
 * Deliberately its own dependency-free leaf (see AGENTS.md "Watch the import
 * budget") rather than living inside `federationSafety.js`: that module also
 * reaches `secretText.js`/`secretKeys.js` for the credential-shaped/-named
 * checks that stay OUTSIDE this table, and this leaf must not become the
 * vehicle that pulls those into every free-text redactor in the tree. Pure;
 * reads no environment.
 */

export const PII_PATTERNS = Object.freeze([
  // `/Users/<name>/…`, `/home/<name>/…` — the OS username by another name.
  // Matches ONLY the leading path segment (not the rest of the path), so a
  // caller can drop the username in place while keeping the rest legible.
  Object.freeze({ code: 'home-path', pattern: /(?<=^|[\s"'`(])\/(Users|home)\/[^/\s"'`]+/i, replacement: '/$1/<user>' }),
  // Any Windows drive-absolute path (`C:\Users\<name>\…`, `D:\secrets\…`).
  Object.freeze({ code: 'windows-path', pattern: /\b[A-Za-z]:[\\/](?:Users[\\/])?[^\s"'`]+/, replacement: '<path>' }),
  Object.freeze({
    code: 'ip-literal',
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/,
    replacement: '<ip>',
  }),
  // IPv6, which also matches a MAC and a `14:25:30` clock time — an accepted
  // over-redaction: the shape is rare enough in free text that collapsing it
  // to `<ip>` costs nothing a reader needs.
  Object.freeze({ code: 'ip-literal', pattern: /\b(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{0,4}\b/, replacement: '<ip>' }),
  // Tailscale MagicDNS / mDNS hostnames — consume ALL leading labels so a
  // multi-label name like `machine.tailnet.ts.net` doesn't leak `machine`.
  Object.freeze({ code: 'network-host', pattern: /\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:ts\.net|local)\b/i, replacement: '<host>' }),
  Object.freeze({ code: 'mac-address', pattern: /\b[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}\b/, replacement: '<mac>' }),
  Object.freeze({ code: 'email-address', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, replacement: '<email>' }),
  Object.freeze({ code: 'phone-number', pattern: /\b\+?\d[\d ().-]{8,}\d\b/, replacement: '<phone>' }),
  // Only the LABELLED form: a bare decimal pair is indistinguishable from any
  // other two numbers. Keeps the label so the redaction still reads as a
  // coordinate rather than an unexplained placeholder.
  Object.freeze({ code: 'gps-coordinate', pattern: /\b(latitude|longitude|lat|lon|lng)\s*[:=]\s*-?\d{1,3}(?:\.\d+)?/i, replacement: '$1=[REDACTED]' }),
]);

/** A global-flagged copy of `pattern`, safe for a `.replace()` caller to reuse. */
export function globalPattern(pattern) {
  return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
}

/**
 * Apply every `{ pattern, replacement }` entry in `PII_PATTERNS` to `text`, in
 * table order. Shared by both redaction consumers so a correction to the
 * table (or the order patterns apply in) reaches both without a second copy
 * of this loop.
 */
export function redactPii(text) {
  return PII_PATTERNS.reduce((out, { pattern, replacement }) => out.replace(globalPattern(pattern), replacement), text);
}
