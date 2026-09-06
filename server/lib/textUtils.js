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
 * Bound a string to a hard character cap, cutting on a natural boundary.
 *
 * `trimTo` above slices blindly, which is right for a log field and wrong for
 * text a human or a renderer reads: a mid-word cut reads as corruption, and in
 * a render prompt it can change what the final phrase asks for. Cut at the last
 * sentence end when one sits deep enough in the allowance (60%+, so an
 * abbreviation or a decimal near the start can't throw the prompt away), else
 * at the last word boundary, else at the cap.
 *
 * Returns `{ text, truncated }` so the caller can TELL the user the text was
 * cut — a silent trim reads as the model losing detail on its own. A
 * non-positive/non-finite `max` means "no cap" and passes the text through.
 *
 * Distinct from the two capping helpers that append a marker — `clampText`
 * (`promptFencing.js`, `… [truncated]`) and `truncateForTelegram`
 * (`telegramMessage.js`, `…`). A marker is right for text a reader sees and
 * wrong for text handed BACK to a length-capped renderer, which would count
 * it against the same cap.
 *
 * @param {unknown} text
 * @param {number} max
 * @returns {{ text: string, truncated: boolean }}
 */
export function clampToCharLimit(text, max) {
  const value = typeof text === 'string' ? text : '';
  if (!Number.isFinite(max) || max <= 0 || value.length <= max) return { text: value, truncated: false };
  const cut = value.slice(0, max);
  const sentenceEnd = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
  const wordEnd = cut.lastIndexOf(' ');
  const at = sentenceEnd >= max * 0.6 ? sentenceEnd + 1
    : wordEnd > 0 ? wordEnd
      : max;
  return { text: cut.slice(0, at).trim(), truncated: true };
}

/**
 * Escape a string for literal use inside a RegExp.
 *
 * This is the ONE copy — import it, never re-inline the character class. It was
 * hand-rolled privately in a dozen modules before the extraction, and because
 * none of them exported it every new caller copied the nearest one again. The
 * `no private escapeRegExp` guard in textUtils.test.js scans the server tree and
 * fails the build if a private copy reappears.
 *
 * Non-string input is coerced rather than throwing: the callers escape
 * user-supplied tokens (LoRA trigger words, character aliases, catalog type
 * labels) on the way into `new RegExp(...)`, where a TypeError would surface as
 * an opaque 500 instead of a harmless non-match.
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
