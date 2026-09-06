/**
 * "Is this bible entry actually described?" — the one field vocabulary the
 * describe automation, the character/canon expand services, and the image jobs
 * all measure completeness against.
 *
 * A universe bible entry can be *present* without being *usable*: a character
 * row with a name and nothing else renders a generic figure, and a place with a
 * blank description renders whatever the model felt like. The quota-burn
 * describe job exists to close that gap before any image quota is spent on it,
 * which needs a definition of "described" that does not live in the job.
 *
 * Two depths, because the two questions are different:
 *   - `core`   — the minimum for the entry to render or be written at all.
 *   - `full`   — the whole sheet: everything the expand prompts can fill, which
 *                for a character is the character-sheet field set a novelist +
 *                graphic novelist both need.
 *
 * Pure module: shape and predicates only, no storage and no provider I/O, so the
 * burn job (which must not import the universe store to answer "how many are
 * missing"), the expand services, and the tests all agree on one list. The
 * character lists are the SOURCE for `universeCharacterExpand.js`'s
 * `STRING_FIELDS` / `LIST_FIELDS` — a field the expand prompt fills but this
 * module doesn't know about would be permanently invisible to the completeness
 * scan, so the two are deliberately one list rather than two that agree today.
 */

import { BIBLE_KEYS, isBlank, PSYCHOLOGY_DRIVE_AXES } from './storyBible.js';

/** Depth vocabulary. `core` = renderable at all; `full` = the whole sheet. */
export const BIBLE_DESCRIBE_DEPTHS = Object.freeze(['core', 'full']);

/**
 * Which entries a describe pass covers: everything, or one canon bucket. Derived
 * from `BIBLE_KEYS` so the job catalog's option list and the job's own scope→kind
 * table move together — a renamed or added canon kind that reached only one of
 * them would leave stored jobs carrying a `scope` that matches nothing.
 */
export const BIBLE_DESCRIBE_SCOPES = Object.freeze(['all', ...BIBLE_KEYS]);

/**
 * The three slider axes, all of which must be rated for `sliders` to count as
 * filled. Exported so the character expand's merge rates the same three.
 */
export const SLIDER_AXES = Object.freeze(['proactivity', 'likability', 'competence']);

/**
 * Every field the per-kind expand prompt may fill, grouped by how it is stored.
 * The grouping is what lets one merge helper handle all three kinds:
 *   - `strings` — plain prose, blank when empty/whitespace
 *   - `lists`   — arrays of sanitized rows, blank when empty
 *   - `enums`   — a single constrained token, blank when unset (null)
 *   - `objects` — structured records with their own "is it filled" rule
 */
export const BIBLE_EXPAND_FIELDS = Object.freeze({
  character: Object.freeze({
    strings: Object.freeze([
      'pronouns', 'age', 'coreTheme', 'speechAccent', 'speechPattern',
      'physicalDescription', 'personality', 'background', 'visualNotes',
      'silhouetteNotes', 'postureNotes', 'specialTraits', 'visualIdentity',
      'motivations', 'likes', 'dislikes', 'mannerisms', 'relationships', 'skills',
      // Character framework (CWQE Phase 10, #2175) — the Ghost → Wound → Lie →
      // Want → Need chain. `arcType` and `sliders` are the structured half.
      'ghost', 'wound', 'lie', 'want', 'need',
    ]),
    lists: Object.freeze([
      'stats', 'colorPalette', 'props', 'expressions', 'handGestures',
      'wardrobes', 'secrets',
    ]),
    enums: Object.freeze(['arcType']),
    // `psychology` (#6414) — the optional theory-of-control + drives profile.
    // Structured, so it merges leaf-by-leaf like `sliders` rather than as one
    // opaque string; `characterPsychologyIsBlank` below is its filled rule.
    objects: Object.freeze(['sliders', 'psychology']),
  }),
  place: Object.freeze({
    strings: Object.freeze(['description', 'palette', 'era', 'weather', 'recurringDetails']),
    lists: Object.freeze([]),
    enums: Object.freeze(['intExt', 'timeOfDay']),
    objects: Object.freeze([]),
  }),
  object: Object.freeze({
    strings: Object.freeze(['description', 'significance']),
    lists: Object.freeze([]),
    enums: Object.freeze([]),
    objects: Object.freeze([]),
  }),
});

/**
 * The `core` set per kind — what an entry needs before it is worth rendering.
 *
 * Deliberately short. `core` gates the image job's opt-in "skip entries nobody
 * has described yet" filter, and a long core list there would park most of a
 * young universe's backlog behind an LLM pass the user may not want.
 */
export const BIBLE_CORE_FIELDS = Object.freeze({
  character: Object.freeze(['physicalDescription', 'personality', 'background', 'motivations', 'visualNotes']),
  place: Object.freeze(['description']),
  object: Object.freeze(['description']),
});

/**
 * `relationshipLinks` (characters) and `attachments` (objects) are INTENTIONALLY
 * absent from every list above: each row points at a sibling entry by id, which
 * an expand call has no way to mint. They are authored in the UI, so counting
 * them as "missing" would make every entry permanently incomplete.
 */

/**
 * Every field a kind's expand prompt can fill, flattened across the groups.
 * Reads the groups generically so adding a fifth storage shape is one edit here
 * rather than one at every flatten site.
 */
export const expandableBibleFields = (kind) => Object.values(BIBLE_EXPAND_FIELDS[kind] || {}).flat();

const requiredFields = (kind, depth) => {
  if (!BIBLE_EXPAND_FIELDS[kind]) return [];
  return depth === 'core' ? (BIBLE_CORE_FIELDS[kind] || []) : expandableBibleFields(kind);
};

/**
 * Whether ONE field on an entry is still unfilled — the single blank predicate
 * the completeness scan AND the expand merges both call, so the code that
 * decides an entry needs work can't disagree with the code that does it.
 * `isBlank` (storyBible) carries the base string/array rule; the two exceptions
 * below are what this wrapper adds.
 */
export function bibleFieldIsBlank(entry, field) {
  // A character's canonical description lives in `physicalDescription`; migration
  // 019 rewrites the legacy `description` alias forward but the read-side fallback
  // stays, so a pre-migration entry must not read as blank here — it would be
  // re-described on top of text it already has.
  if (field === 'physicalDescription') return isBlank(entry?.physicalDescription) && isBlank(entry?.description);
  // `sliders` is an always-present object whose axes are individually null until
  // rated, so plain presence would report it filled the moment the sanitizer
  // materialized it.
  if (field === 'sliders') return SLIDER_AXES.some((axis) => entry?.sliders?.[axis] == null);
  // `psychology` is absent entirely until authored, and materializes all three
  // drive slots the moment any leaf is filled — so it needs its own rule too.
  if (field === 'psychology') return characterPsychologyIsBlank(entry?.psychology);
  return isBlank(entry?.[field]);
}

/**
 * Whether a character's psychology profile (#6414) still counts as unassessed.
 *
 * Presence alone is not enough (same reason `sliders` needs a rule): the
 * sanitizer materializes all three drive slots as soon as ANY leaf is authored.
 * An explicit `unknown` / `not-applicable` ruling WITH the author's
 * explanation is a real assessment, not a gap — that is what lets a
 * deliberately opaque or nonhuman character be complete without inventing a
 * human interior for it.
 */
export function characterPsychologyIsBlank(psychology) {
  if (!psychology || typeof psychology !== 'object' || Array.isArray(psychology)) return true;
  if (psychology.assessment === 'unknown' || psychology.assessment === 'not-applicable') {
    return isBlank(psychology.assessmentNote);
  }
  if (isBlank(psychology.theoryOfControl)) return true;
  return PSYCHOLOGY_DRIVE_AXES.some((axis) => isBlank(psychology.drives?.[axis]?.desire)
    || isBlank(psychology.drives?.[axis]?.fear));
}

/** Normalize an untrusted depth param to a known depth, defaulting to `full`. */
export const normalizeDescribeDepth = (depth) =>
  (BIBLE_DESCRIBE_DEPTHS.includes(depth) ? depth : 'full');

/**
 * The fields still blank on `entry`, in the canonical order the expand prompt
 * lists them. Empty array means the entry is described to that depth.
 */
export function missingBibleFields(kind, entry, { depth = 'full' } = {}) {
  if (!entry || typeof entry !== 'object') return [];
  return requiredFields(kind, normalizeDescribeDepth(depth)).filter((field) => bibleFieldIsBlank(entry, field));
}

/** Whether `entry` has every field the depth asks for. */
export const bibleEntryIsDescribed = (kind, entry, options) =>
  missingBibleFields(kind, entry, options).length === 0;

/**
 * The gap list plus the size of the sheet it was measured against — what orders
 * the describe job's picks (emptiest FRACTION first, so one kind's much longer
 * sheet doesn't permanently outrank another's).
 */
export function bibleEntryCompleteness(kind, entry, { depth = 'full' } = {}) {
  const required = requiredFields(kind, normalizeDescribeDepth(depth));
  const missing = (entry && typeof entry === 'object')
    ? required.filter((field) => bibleFieldIsBlank(entry, field))
    : [];
  return { required: required.length, missing };
}
