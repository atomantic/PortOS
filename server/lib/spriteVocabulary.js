/**
 * Sprite identifier and direction vocabulary.
 *
 * id pattern, record kinds, the canonical 8-direction order + derived anchor set, `TURNAROUND_ID` and animation provider ids, the alphabets the sprite route schemas enumerate. Kept below validation and the sprite services so `lib/spriteValidation.js` can name a direction or record kind without importing service orchestration (#4901); owning services re-export from here. A leaf module (no imports).
 */

// Sprite record ids: lowercase kebab, 1–64 chars, must start alphanumeric.
export const SPRITE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const SPRITE_RECORD_KINDS = ['character', 'place', 'object', 'props'];

// Canonical 8-direction order (the source pipeline's RUNTIME_DIRECTION_ORDER); atlas row order in later phases depends on it, so keep it stable.
export const SPRITE_DIRECTIONS = [
  'south',
  'south-east',
  'east',
  'north-east',
  'north',
  'north-west',
  'west',
  'south-west',
];

// Directions that get a derived anchor. `south` is never generated — the
// frozen main reference IS the south anchor.
export const ANCHOR_DIRECTIONS = SPRITE_DIRECTIONS.filter((d) => d !== 'south');

export const TURNAROUND_ID = 'turnaround';

export const ANIMATION_PROVIDER_IDS = Object.freeze(['grok', 'local']);
