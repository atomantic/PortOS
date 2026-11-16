// Shared, dependency-free text helpers for server-side prose analysis.
//
// Canonical server-side home for `countWords`. `client/src/lib/textUtils.js`
// re-exports `escapeRegExp` from here, so keep this module pure: no Node
// built-in, nothing outside `server/lib`.

/**
 * The one string-type predicate under `server/` (and, via the client mirror, the
 * browser bundle). The "no private string predicate or bounder" guard in
 * `textUtils.test.js` fails the suite when a copy reappears (#6837).
 *
 * @param {unknown} v
 * @returns {v is string}
 */
export const isStr = (v) => typeof v === 'string';

/**
 * `isStr` plus "has visible content": a string whose `trim()` is non-empty.
 * This is the predicate for ids, keys, hosts, model names, and prose fields
 * where a whitespace-only value is already invalid, so it also replaces the
 * looser `v.length > 0` / `!!v` copies (which accepted `'   '`). It does not
 * trim the value it accepts; callers that store the string still `trim()`.
 *
 * @param {unknown} v
 * @returns {v is string}
 */
export const isNonBlankStr = (v) => typeof v === 'string' && v.trim().length > 0;

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

// Smallest share of the budget a sentence-boundary cut may keep. A cut above
// this wins over a mid-sentence clip; below it, gutting the record costs more
// than the ragged edge. Kept low because a single-sentence field (logline,
// ending hook) often has only one terminator, early in the budget.
const SENTENCE_CUT_FLOOR = 0.3;

// A sentence terminator that actually ENDS a sentence: `.`/`!`/`?` plus any
// closing quote or bracket, and then either whitespace or the end of the window.
// The lookahead keeps "Dr. Vey" and "3.5" from reading as breaks; `$` lets a
// terminator flush against the budget edge count (the slice already cut off any
// trailing space).
const SENTENCE_END_RE = /[.!?]["'’”)\]]*(?=\s|$)/g;
const COMMON_ABBREVIATION_RE = /\b(?:dr|etc|jr|mr|mrs|ms|prof|sr|st|vs)\.$/i;

// A clause boundary — the weaker cut used when a short field holds no sentence
// terminator, where the whole-word fallback would leave a dangling half-clause.
// Weaker than a sentence break, so it has to keep more of the field.
const CLAUSE_END_RE = /[,;:—–]/g;
const CLAUSE_CUT_FLOOR = 0.6;

/**
 * Boundary-aware cap for PROSE fields (loglines, synopses, ending hooks). A hard
 * `slice(0, max)` clips mid-word ("...tracing the brand and"), which downstream
 * verify passes flag as "truncated mid-sentence" — and because a resolver then
 * regenerates an over-cap value that gets re-clipped the same way, the
 * verify→resolve loop never converges. When the text fits, it's returned
 * untouched. When it must be clipped, back off to the last sentence terminator
 * (. ! ?) within the budget, provided that cut keeps at least
 * SENTENCE_CUT_FLOOR of it; failing that, to the last clause boundary (, ; : —)
 * keeping at least CLAUSE_CUT_FLOOR; and failing that (a single clause running
 * past the cap, or a break so early that honoring it would gut the field) to the
 * last whitespace boundary so the result still ends on a whole word. Never
 * returns more than `max` chars.
 *
 * Lives here (re-exported by `storyBible.js`) so browser-shared story-model
 * leaves get the cap without importing `storyBible.js`'s Node built-ins.
 */
export function trimToClause(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (s.length <= max) return s;
  const window = s.slice(0, max);
  // Prefer the last real sentence terminator in the window. `end` is the cut
  // point (exclusive) so trailing quotes/brackets ride along with the period.
  let end = -1;
  SENTENCE_END_RE.lastIndex = 0;
  for (let m = SENTENCE_END_RE.exec(window); m; m = SENTENCE_END_RE.exec(window)) {
    if (m[0][0] === '.' && COMMON_ABBREVIATION_RE.test(window.slice(0, m.index + 1))) continue;
    end = m.index + m[0].length;
  }
  if (end >= Math.floor(max * SENTENCE_CUT_FLOOR)) return window.slice(0, end).trim();
  // No usable sentence break — back off to the last clause boundary instead, so
  // the result ends on a complete clause rather than mid-thought. The mark itself
  // is dropped (cut is exclusive) so the value never ends on a hanging comma.
  let clause = -1;
  CLAUSE_END_RE.lastIndex = 0;
  for (let m = CLAUSE_END_RE.exec(window); m; m = CLAUSE_END_RE.exec(window)) clause = m.index;
  if (clause >= Math.floor(max * CLAUSE_CUT_FLOOR)) return window.slice(0, clause).trim();
  // Not even a usable clause break — clip on the last whole word instead of mid-word.
  const space = window.lastIndexOf(' ');
  return (space > 0 ? window.slice(0, space) : window).trim();
}

/**
 * Bound a string to a hard character cap, cutting on a natural boundary.
 *
 * Delegates to `trimToClause` for sentence-aware boundary detection. Returns
 * `{ text, truncated }` so the caller can TELL the user the text was cut — a
 * silent trim reads as the model losing detail on its own. A non-positive/
 * non-finite `max` means "no cap" and passes the text through.
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
  return { text: trimToClause(value, max), truncated: true };
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
 * First non-empty line of a string, trimmed.
 *
 * The CoS task-description headline: `generateTasksMarkdown` flattens a stored
 * description to one line, so every comparison against a multi-line input has to
 * normalize on the first line. Lives in this dependency-free leaf because the
 * goal-fidelity follow-up needs the same headline for its dedup key and cannot
 * import the task store (see server/AGENTS.md "Import scoping");
 * `services/cosTaskStore.js` re-exports it at the address its callers already use.
 */
export const firstLine = (text) => String(text ?? '').split('\n').map(line => line.trim()).find(Boolean) || '';

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

/**
 * Bound a kebab slug to `max` characters WITHOUT cutting mid-word: back off to
 * the last `-` at or before `max`, hard-cut only when no boundary sits in range,
 * and never leave a trailing separator.
 *
 * Lives here beside `kebabCase` because both of its callers are slug builders a
 * human then reads — a PLAN.md `[slug]` id and the app segment of a CoS worktree
 * directory name (`appWorktreeSlug`, lib/worktreeOwnership.js), which somebody
 * scanning `git worktree list` uses to decide whether a tree is safe to reap.
 * NOT `trimTo`: that one trims whitespace and hard-slices, so it reintroduces
 * both the mid-word cut and the trailing hyphen.
 */
export function truncateOnBoundary(slug, max) {
  if (slug.length <= max) return slug;
  const cut = slug.lastIndexOf('-', max);
  return (cut > 0 ? slug.slice(0, cut) : slug.slice(0, max)).replace(/-+$/, '');
}

/**
 * `pluralize(1, 'item')` → "1 item"; `pluralize(2, 'item')` → "2 items".
 * Pass a third arg for an irregular plural: `pluralize(1, 'person', 'people')`.
 *
 * Lives here rather than in the client mirror because the server builds
 * user-facing count prose too (`lib/systemIdle.js`'s activity blockers).
 */
export const pluralize = (count, singular, pluralForm = `${singular}s`) =>
  `${count} ${count === 1 ? singular : pluralForm}`;
