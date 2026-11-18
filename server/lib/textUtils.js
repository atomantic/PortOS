// Shared, dependency-free text helpers for server-side prose analysis.
//
// `client/src/lib/textUtils.js` re-exports `escapeRegExp` from here, so keep this pure: no Node built-in, nothing outside `server/lib`.

/**
 * The one string-type predicate under `server/` (and the browser bundle via the client mirror).
 *
 * @param {unknown} v
 * @returns {v is string}
 */
export const isStr = (v) => typeof v === 'string';

/**
 * `isStr` plus a non-empty `trim()`: the predicate for ids, keys, hosts, model names and prose fields where whitespace-only is invalid (replaces looser `v.length > 0` / `!!v`).
 * It does not trim the accepted value; callers that store the string still `trim()`.
 *
 * @param {unknown} v
 * @returns {v is string}
 */
export const isNonBlankStr = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * Count whitespace-separated words (`\S+` matches, so mixed whitespace collapses). Non-strings, null/undefined and blank input return 0 rather than being coerced.
 *
 * @param {unknown} text
 * @returns {number}
 */
export function countWords(text) {
  if (typeof text !== 'string') return 0;
  const matches = text.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

/** Trim a string and cap it to a maximum number of characters; non-strings normalize to `''`. Dependency-free so browser-shared helpers needn't import a server domain module. */
export const trimTo = (value, max) => (
  typeof value === 'string' ? value.trim().slice(0, max) : ''
);

// Smallest share of the budget a sentence-boundary cut may keep (below it, gutting the record costs more than the ragged edge). Low because a single-sentence field often has one terminator, early.
const SENTENCE_CUT_FLOOR = 0.3;

// A terminator that actually ENDS a sentence: `.`/`!`/`?` plus closing quote/bracket, then whitespace or window end (keeps "Dr. Vey" and "3.5" from reading as breaks; `$` lets a flush terminator count).
const SENTENCE_END_RE = /[.!?]["'’”)\]]*(?=\s|$)/g;
const COMMON_ABBREVIATION_RE = /\b(?:dr|etc|jr|mr|mrs|ms|prof|sr|st|vs)\.$/i;

// A clause boundary: the weaker cut for a short field with no sentence terminator; it must keep more of the field.
const CLAUSE_END_RE = /[,;:—–]/g;
const CLAUSE_CUT_FLOOR = 0.6;

/**
 * Boundary-aware cap for PROSE fields (loglines, synopses, ending hooks). A hard `slice` clips mid-word, which verify passes flag as truncated, and the resolver's regenerated value gets re-clipped
 * the same way so verify→resolve never converges. Fits: returned untouched. Otherwise back off to the last sentence terminator (keeping at least SENTENCE_CUT_FLOOR), else the last clause boundary
 * (CLAUSE_CUT_FLOOR), else the last whitespace so the result ends on a whole word. Never exceeds `max`.
 * Re-exported by `storyBible.js`; lives here so browser-shared leaves avoid its Node built-ins.
 */
export function trimToClause(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (s.length <= max) return s;
  const window = s.slice(0, max);
  // Prefer the last real sentence terminator; `end` is exclusive so trailing quotes/brackets ride along.
  let end = -1;
  SENTENCE_END_RE.lastIndex = 0;
  for (let m = SENTENCE_END_RE.exec(window); m; m = SENTENCE_END_RE.exec(window)) {
    if (m[0][0] === '.' && COMMON_ABBREVIATION_RE.test(window.slice(0, m.index + 1))) continue;
    end = m.index + m[0].length;
  }
  if (end >= Math.floor(max * SENTENCE_CUT_FLOOR)) return window.slice(0, end).trim();
  // No sentence break: last clause boundary, mark dropped (exclusive cut) so the value never ends on a hanging comma.
  let clause = -1;
  CLAUSE_END_RE.lastIndex = 0;
  for (let m = CLAUSE_END_RE.exec(window); m; m = CLAUSE_END_RE.exec(window)) clause = m.index;
  if (clause >= Math.floor(max * CLAUSE_CUT_FLOOR)) return window.slice(0, clause).trim();
  // No clause break either: clip on the last whole word.
  const space = window.lastIndexOf(' ');
  return (space > 0 ? window.slice(0, space) : window).trim();
}

/**
 * Bound a string to a hard character cap on a natural boundary (via `trimToClause`), returning `{ text, truncated }` so the caller can TELL the user it was cut. A non-positive/non-finite `max` means no cap.
 * Distinct from the marker-appending cappers (`clampText` in `promptFencing.js`, `truncateForTelegram`): a marker is wrong for text handed BACK to a length-capped renderer, which would count it.
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
 * Escape a string for literal use inside a RegExp. Import this helper when interpolating literal text into a pattern.
 * Non-string input is coerced, not thrown: callers escape user tokens (LoRA triggers, aliases, catalog labels) where a TypeError would be an opaque 500 instead of a non-match.
 */
export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * First non-empty line of a string, trimmed: the CoS task-description headline (`cosTaskStore.addTask` collapses a description to its first line). A dependency-free leaf because the goal-fidelity
 * follow-up needs it for its dedup key and can't import the task store (server/AGENTS.md "Import scoping"); `services/cos/cosTaskStore.js` re-exports it.
 */
export const firstLine = (text) => String(text ?? '').split('\n').map(line => line.trim()).find(Boolean) || '';

/** Lowercase + kebab-case a string, ASCII-only, collapsing other runs to a single `-` and trimming edge hyphens. Non-string input returns `''` so callers can tell "nothing to slug" without a guard. */
export function kebabCase(text) {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Bound a kebab slug to `max` characters WITHOUT cutting mid-word: back off to the last `-` at or before `max`, hard-cut only when no boundary is in range, never leave a trailing separator.
 * Not `trimTo`, which hard-slices (mid-word cut, trailing hyphen); callers are human-read slug builders (PLAN.md `[slug]`, `appWorktreeSlug` in lib/worktreeOwnership.js).
 */
export function truncateOnBoundary(slug, max) {
  if (slug.length <= max) return slug;
  const cut = slug.lastIndexOf('-', max);
  return (cut > 0 ? slug.slice(0, cut) : slug.slice(0, max)).replace(/-+$/, '');
}

/** `pluralize(1, 'item')` → "1 item"; `pluralize(2, 'item')` → "2 items"; a third arg gives an irregular plural. Server-side because it builds count prose too (`lib/systemIdle.js`). */
export const pluralize = (count, singular, pluralForm = `${singular}s`) =>
  `${count} ${count === 1 ? singular : pluralForm}`;
