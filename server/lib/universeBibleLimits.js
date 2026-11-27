/**
 * Shared Universe Builder field limits, vocabulary, and image batch caps.
 *
 * A universe bible field that must
 * carry distinct economies, jurisdictions, travel rules, route logistics,
 * and several sites can legitimately need well beyond 8k; these remain
 * runaway-payload guards, not instructions to crush readable prose.
 */

import { BIBLE_LIMITS } from './bibleLimits.js';
import { BIBLE_KEYS, BIBLE_KIND } from './universeCanon.js';

export const LOGLINE_MAX = 500;
export const PREMISE_MAX = 20000;
export const STYLE_NOTES_MAX = 4000;
export const INFLUENCE_ENTRY_MAX = 120;
export const INFLUENCES_PER_LIST_MAX = 30;
export const STYLE_REFERENCES_MAX = 20;

export const LOCKABLE_FIELDS = Object.freeze([
  'starterPrompt',
  'logline',
  'premise',
  'styleNotes',
  'influencesEmbrace',
  'influencesAvoid',
]);

// Per-template input bounds shared by request validation and sanitization.
export const CATEGORY_KINDS = Object.freeze([...BIBLE_KEYS, 'other']);
export const COMPOSITE_PROMPT_MAX = 4000;
export const COMPOSITE_SHEETS_MAX = 50;
export const COMPOSITE_SHEET_KINDS = Object.freeze([
  'reference_sheet',
  'world_pitch_poster',
]);
// Keep render histories for variations/sheets within the existing canon cap.
export const IMAGE_REFS_PER_ENTRY_MAX = BIBLE_LIMITS.IMAGE_REFS_PER_ENTRY_MAX;
export const IMAGE_REF_FILENAME_MAX = BIBLE_LIMITS.IMAGE_REF_MAX;
export const MOOD_BOARD_ID_MAX = 80;
export const NAME_MAX_LENGTH = 100;
export const PROMPT_FRAGMENT_MAX = 2000;
// Allows both one-line pitches and multi-page treatments.
export const STARTER_PROMPT_MAX = 200_000;
export const STYLE_REFERENCE_PROMPT_MAX = 4000;
export const STYLE_REFERENCE_TITLE_MAX = 120;
export const VARIATIONS_PER_CATEGORY_MAX = 50;
export const VARIATION_LABEL_MAX = 120;
export const WORLD_CATEGORY_COUNT_MAX = 30;
export const WORLD_CATEGORY_KEY_MAX = 64;

export const DESC_LIMIT = Object.freeze({
  [BIBLE_KIND.CHARACTER]: BIBLE_LIMITS.PHYSICAL_DESCRIPTION_MAX,
  [BIBLE_KIND.PLACE]: BIBLE_LIMITS.PLACE_DESCRIPTION_MAX,
  [BIBLE_KIND.OBJECT]: BIBLE_LIMITS.OBJECT_DESCRIPTION_MAX,
});

// The vision runner embeds each image in the request, so cap the batch size.
export const VISION_MAX_IMAGES = 8;
export const VISION_EXPAND_MAX_IMAGES = 8;
