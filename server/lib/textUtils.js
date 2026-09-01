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

/**
 * Trim a string and cap it to a maximum number of characters.
 *
 * Kept in this dependency-free module so browser-consumed shared helpers do
 * not have to import a larger server domain module just for string bounding.
 * Non-string values normalize to the empty string rather than being coerced.
 */
export const trimTo = (value, max) => (
  typeof value === 'string' ? value.trim().slice(0, max) : ''
);

/**
 * Escape a string for literal use inside a RegExp.
 *
 * Exported because this was hand-rolled privately in seven other modules
 * (markedSection, loraTriggers, loraDataset, scenePrompt, assetMounts,
 * editorial/cutApplier, editorial/proseTics) — none of them exported it, so the
 * eighth caller copied it too. This is the one to import.
 */
export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Lowercase + kebab-case a string, ASCII-only, collapsing runs of anything else
 * to a single `-` and trimming leading/trailing hyphens.
 *
 * Lives here, beside `escapeRegExp`, for the same reason: it was private to
 * `planIds.js` (PLAN.md `[slug]` ids) and the next caller that needed the same
 * transform — `normalizePlannerId`, which slugs a model id into a `planner:`
 * label — could only re-inline the regex chain. Non-string input returns the
 * empty string rather than being coerced, so a caller distinguishes "nothing to
 * slug" from a real slug without a separate guard.
 */
export function kebabCase(text) {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
