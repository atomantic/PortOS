/**
 * Re-exports `escapeRegExp`, `countWords`, `isStr` and `isNonBlankStr` from the server text utilities
 * for client use.
 *
 * `escapeRegExp(value)`, `countWords(text)`, `isStr(v)` and `isNonBlankStr(v)` re-exported from
 * `server/lib/textUtils.js` — the two members the bundle has callers for (the Writers Room editor and
 * exercise panel and the autobiography tab count words with the same `\S+` rule the server stores).
 * Named exports rather than `export *`, so the file stays the list of what the browser actually uses.
 * Also `pluralize(count, singular, pluralForm?)` — the shared "N item/items" phrasing helper for
 * singular/plural counts.
 */

/**
 * Pure prose helpers, from the module that owns them on both sides.
 *
 * `escapeRegExp`, `countWords`, `isStr`, `isNonBlankStr` and `pluralize` are named
 * re-exports of `server/lib/textUtils.js` — imported rather than copied so the
 * two runtimes cannot drift: the word count the Writers Room and autobiography
 * editors show beside a draft is the same `\S+` rule the server stores for it,
 * and the "has text" check the Songs views and FableLoom readiness use is the
 * same non-blank predicate the server's sanitizers apply (#6837). Named rather
 * than `export *` so this file stays the list of what the browser bundle has a
 * caller for; the file itself stays so every `lib/textUtils` import path in the
 * client is unchanged.
 */
export { countWords, escapeRegExp, isStr, isNonBlankStr, pluralize } from '../../../server/lib/textUtils.js';

