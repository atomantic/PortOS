// Shared, dependency-free text helpers for server-side prose analysis.
//
// `countWords` was previously re-implemented three times with subtly different
// regexes (`server/services/writersRoom/local.js`, `server/lib/issueLength.js`,
// and the client's `client/src/utils/formatters.js`). They all converge on the
// same intent — count whitespace-delimited tokens — so this is the canonical
// server-side home. The client copy (which cannot import from `server/`) mirrors
// this exact semantics so client and server word counts always agree.

/**
 * Count whitespace-separated words in a string.
 *
 * Non-strings, `null`/`undefined`, and empty/whitespace-only input all return 0.
 * Uses `\S+` matching (equivalent to splitting on `\s+` after a trim) so runs of
 * mixed whitespace — spaces, tabs, newlines — collapse to a single delimiter.
 * Non-string input returns 0 rather than being coerced, so a stray number can't
 * masquerade as a one-word body.
 *
 * @param {unknown} text
 * @returns {number}
 */
export function countWords(text) {
  if (typeof text !== 'string') return 0;
  const matches = text.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}
