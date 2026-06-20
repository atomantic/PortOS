// Client mirror of server/lib/shotGrammar.js (#1315) — the canonical controlled
// vocabularies for a storyboard shot's camera framing (`shotType`) and on-screen
// direction (`screenDirection`). The server module is authoritative (it also
// carries the LLM/UI normalizers); this copy holds only the enums + reader-facing
// labels the storyboards shot-grammar editor (#1468) needs to populate its selects.
// Keep SHOT_TYPES / SCREEN_DIRECTIONS in sync with the server verbatim — the route
// validates against the server enum (storyboardShotSchema), so a drifted client
// value would 400 on save.

// Camera framing / size. Same membership + order as the server SHOT_TYPES.
export const SHOT_TYPES = Object.freeze([
  'extreme-wide',
  'wide',
  'medium',
  'close',
  'extreme-close',
  'over-the-shoulder',
  'two-shot',
  'pov',
]);

// On-screen direction the subject faces / moves.
export const SCREEN_DIRECTIONS = Object.freeze(['left', 'right', 'neutral']);

// Reader-facing labels for the editor selects. Keys are the canonical tokens.
export const SHOT_TYPE_LABELS = Object.freeze({
  'extreme-wide': 'Extreme wide',
  wide: 'Wide / establishing',
  medium: 'Medium',
  close: 'Close',
  'extreme-close': 'Extreme close / insert',
  'over-the-shoulder': 'Over-the-shoulder',
  'two-shot': 'Two-shot',
  pov: 'POV',
});

export const SCREEN_DIRECTION_LABELS = Object.freeze({
  left: 'Faces screen-left',
  right: 'Faces screen-right',
  neutral: 'Head-on / neutral',
});
