/**
  * Is a universe bible entry actually described?
  *
  * The shared per-kind expand-field vocabulary (`BIBLE_EXPAND_FIELDS`, `BIBLE_CORE_FIELDS`) and the `core`/`full` completeness predicates that the describe automation, the character/canon expand services, the image jobs and the quota-burn describe job all measure against. A row with a name and nothing else renders a generic figure; the describe job closes that gap before image quota is spent. Two depths: `core` (minimum to render or be written at all) and `full` (everything the expand prompts can fill; for a character, the sheet a novelist and graphic novelist both need). Pure: shape and predicates only, so the burn job (which must not import the universe store) and the expand services agree on one list. The character lists are the SOURCE for `universeCharacterExpand.js`'s `STRING_FIELDS` / `LIST_FIELDS`: a field the expand prompt fills but this module doesn't know would be invisible to the scan, so they are one list, not two that agree today.
 */

import { BIBLE_KEYS, PSYCHOLOGY_DRIVE_AXES } from './storyBible.js';
import { isEmptyScalar } from './objects.js';

/** Depth vocabulary. `core` = renderable at all; `full` = the whole sheet. */
export const BIBLE_DESCRIBE_DEPTHS = Object.freeze(['core', 'full']);

/** Which entries a describe pass covers: everything, or one canon bucket. Derived from `BIBLE_KEYS` so the job catalog's options and the job's scope→kind table move together (else stored jobs carry a `scope` matching nothing). */
export const BIBLE_DESCRIBE_SCOPES = Object.freeze(['all', ...BIBLE_KEYS]);

/** The three slider axes, all of which must be rated for `sliders` to count as filled; exported so the character expand's merge rates the same three. */
export const SLIDER_AXES = Object.freeze(['proactivity', 'likability', 'competence']);

/** Every field the per-kind expand prompt may fill, grouped by storage so one merge helper handles all kinds: `strings` (blank when empty/whitespace), `lists` (sanitized rows, blank when empty), `enums` (blank when null), `objects` (structured records with their own filled rule). */
export const BIBLE_EXPAND_FIELDS = Object.freeze({
  character: Object.freeze({
    strings: Object.freeze([
      'pronouns', 'age', 'coreTheme', 'speechAccent', 'speechPattern',
      'physicalDescription', 'personality', 'background', 'visualNotes',
      'silhouetteNotes', 'postureNotes', 'specialTraits', 'visualIdentity',
      'motivations', 'likes', 'dislikes', 'mannerisms', 'relationships', 'skills',
      // Character framework (CWQE Phase 10, #2175): Ghost → Wound → Lie → Want → Need; `arcType` and `sliders` are the structured half.
      'ghost', 'wound', 'lie', 'want', 'need',
    ]),
    lists: Object.freeze([
      'stats', 'colorPalette', 'props', 'expressions', 'handGestures',
      'wardrobes', 'secrets',
    ]),
    enums: Object.freeze(['arcType']),
    // `psychology` (#6414): optional theory-of-control + drives profile, merged leaf-by-leaf like `sliders`; `characterPsychologyIsBlank` is its filled rule.
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

/** The `core` set per kind: what an entry needs before it is worth rendering. Deliberately short: it gates the image job's opt-in "skip undescribed entries" filter, and a long list would park a young universe's backlog behind an LLM pass the user may not want. */
export const BIBLE_CORE_FIELDS = Object.freeze({
  character: Object.freeze(['physicalDescription', 'personality', 'background', 'motivations', 'visualNotes']),
  place: Object.freeze(['description']),
  object: Object.freeze(['description']),
});

/** `relationshipLinks` (characters) and `attachments` (objects) are INTENTIONALLY absent from every list: each points at a sibling entry by id, which an expand call can't mint (authored in the UI), so counting them would leave every entry permanently incomplete. */

/** Every field a kind's expand prompt can fill, flattened across the groups generically so a fifth storage shape is one edit. */
export const expandableBibleFields = (kind) => Object.values(BIBLE_EXPAND_FIELDS[kind] || {}).flat();

const requiredFields = (kind, depth) => {
  if (!BIBLE_EXPAND_FIELDS[kind]) return [];
  return depth === 'core' ? (BIBLE_CORE_FIELDS[kind] || []) : expandableBibleFields(kind);
};

/** Whether ONE field is still unfilled: the single blank predicate the completeness scan AND the expand merges share, so deciding an entry needs work can't disagree with doing it. `isEmptyScalar` (objects.js) carries the base rule; the exceptions below are added here. */
export function bibleFieldIsBlank(entry, field) {
  // A character's canonical description lives in `physicalDescription`; migration 019 rewrote the legacy `description` alias but the read fallback stays, so a pre-migration entry must not read blank (it would be re-described over existing text).
  if (field === 'physicalDescription') return isEmptyScalar(entry?.physicalDescription) && isEmptyScalar(entry?.description);
  // `sliders` is always present with axes null until rated, so plain presence would count it filled once the sanitizer materializes it.
  if (field === 'sliders') return SLIDER_AXES.some((axis) => entry?.sliders?.[axis] == null);
  // `psychology` is absent until authored and materializes all three drive slots once any leaf is filled, so it needs its own rule.
  if (field === 'psychology') return characterPsychologyIsBlank(entry?.psychology);
  return isEmptyScalar(entry?.[field]);
}

/** Whether a character's psychology profile (#6414) counts as unassessed. Presence isn't enough (the sanitizer materializes all three drive slots on ANY leaf); an explicit `unknown` / `not-applicable` ruling WITH the author's explanation is a real assessment, letting an opaque or nonhuman character be complete. */
export function characterPsychologyIsBlank(psychology) {
  if (!psychology || typeof psychology !== 'object' || Array.isArray(psychology)) return true;
  if (psychology.assessment === 'unknown' || psychology.assessment === 'not-applicable') {
    return isEmptyScalar(psychology.assessmentNote);
  }
  if (isEmptyScalar(psychology.theoryOfControl)) return true;
  return PSYCHOLOGY_DRIVE_AXES.some((axis) => isEmptyScalar(psychology.drives?.[axis]?.desire)
    || isEmptyScalar(psychology.drives?.[axis]?.fear));
}

/** Normalize an untrusted depth param to a known depth, defaulting to `full`. */
export const normalizeDescribeDepth = (depth) =>
  (BIBLE_DESCRIBE_DEPTHS.includes(depth) ? depth : 'full');

/** The fields still blank on `entry`, in the expand prompt's canonical order; empty means described to that depth. */
export function missingBibleFields(kind, entry, { depth = 'full' } = {}) {
  if (!entry || typeof entry !== 'object') return [];
  return requiredFields(kind, normalizeDescribeDepth(depth)).filter((field) => bibleFieldIsBlank(entry, field));
}

/** Whether `entry` has every field the depth asks for. */
export const bibleEntryIsDescribed = (kind, entry, options) =>
  missingBibleFields(kind, entry, options).length === 0;

/** The gap list plus the size of the sheet it was measured against, which orders the describe job's picks (emptiest FRACTION first, so a kind's longer sheet doesn't permanently outrank another's). */
export function bibleEntryCompleteness(kind, entry, { depth = 'full' } = {}) {
  const required = requiredFields(kind, normalizeDescribeDepth(depth));
  const missing = (entry && typeof entry === 'object')
    ? required.filter((field) => bibleFieldIsBlank(entry, field))
    : [];
  return { required: required.length, missing };
}
