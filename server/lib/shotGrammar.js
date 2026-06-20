/**
 * Shot-grammar vocabulary + normalizers (#1315) — the canonical controlled
 * vocabularies for a storyboard shot's camera framing (`shotType`) and on-screen
 * direction (`screenDirection`), plus the normalizers that coerce raw LLM/UI
 * values onto them.
 *
 * Pure and dependency-free (no imports) so it's shared without a cycle by the
 * three layers that touch the shot shape:
 *   - server/lib/sceneExtractor.js  — sanitizes LLM-emitted shots
 *   - server/lib/validation.js      — the Zod enum for the storyboards stage shot schema
 *   - server/lib/editorial/checkRegistry.js — the visual.shot-continuity check
 *     reasons over `shotType` (monotony) + `screenDirection` (180°-rule axis reversal)
 *
 * Both fields default to null ("not captured") everywhere so an older outline or
 * a shot the extractor didn't tag is treated as ABSENT (skipped by the continuity
 * check) rather than mis-classified — the absent-vs-empty rule from CLAUDE.md.
 */

// Camera framing / size. Ordered loosely widest→tightest; the continuity check
// reads the membership only (it doesn't assume the order), so reordering is safe.
export const SHOT_TYPES = Object.freeze([
  'extreme-wide',      // landscape / crowd master where figures are small
  'wide',              // full-figure establishing of the space
  'medium',            // waist/chest framing — the default coverage shot
  'close',             // face/detail framing
  'extreme-close',     // an eye, a hand, an object insert
  'over-the-shoulder', // OTS — frames one subject past another's shoulder
  'two-shot',          // two subjects sharing the frame
  'pov',               // the subject's literal point of view
]);
const SHOT_TYPE_SET = new Set(SHOT_TYPES);

// On-screen direction the subject faces / moves. `neutral` = head-on or
// ambiguous (no axis to cross); `left`/`right` are the screen-relative sides the
// 180°-rule check tracks for axis reversals between continuity-linked shots.
export const SCREEN_DIRECTIONS = Object.freeze(['left', 'right', 'neutral']);
const SCREEN_DIRECTION_SET = new Set(SCREEN_DIRECTIONS);

// Common synonyms the model (or a hand-edit) emits, mapped onto the canonical
// token so a near-miss isn't silently dropped to null. Keys are pre-lowercased.
const SHOT_TYPE_ALIASES = Object.freeze({
  ews: 'extreme-wide', 'extreme wide': 'extreme-wide',
  establishing: 'wide', ws: 'wide', long: 'wide', full: 'wide', 'full-shot': 'wide',
  ms: 'medium', mid: 'medium', 'mid-shot': 'medium',
  cu: 'close', closeup: 'close', 'close-up': 'close',
  ecu: 'extreme-close', 'extreme closeup': 'extreme-close', 'extreme close-up': 'extreme-close',
  insert: 'extreme-close', detail: 'extreme-close',
  ots: 'over-the-shoulder', 'over the shoulder': 'over-the-shoulder',
  two: 'two-shot', '2-shot': 'two-shot', 'two shot': 'two-shot',
  'point of view': 'pov', "subject's pov": 'pov',
});

/**
 * Normalize a raw shot-type value against {@link SHOT_TYPES}. Lowercases + trims
 * so "Wide" / "WIDE " resolve; maps a known synonym via the alias table;
 * otherwise returns null (unknown / non-string / empty → "not captured").
 * @param {*} raw
 * @returns {string|null}
 */
export function normalizeShotType(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (SHOT_TYPE_SET.has(v)) return v;
  return SHOT_TYPE_ALIASES[v] || null;
}

/**
 * Normalize a raw screen-direction value against {@link SCREEN_DIRECTIONS}.
 * Head-on synonyms (center / front / head-on) collapse to `neutral`; unknown /
 * non-string / empty → null.
 * @param {*} raw
 * @returns {string|null}
 */
export function normalizeScreenDirection(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (SCREEN_DIRECTION_SET.has(v)) return v;
  if (v === 'center' || v === 'centre' || v === 'front' || v === 'head-on' || v === 'facing') return 'neutral';
  return null;
}
