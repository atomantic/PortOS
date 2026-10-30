/**
 * Storyboard shot-grammar display labels, over the controlled vocabularies in
 * `server/lib/shotGrammar.js` (#1315).
 *
 * `SHOT_TYPES` / `SCREEN_DIRECTIONS` are re-exported from the server leaf rather
 * than copied, so a hand-set value in the storyboards editor always matches what
 * `storyboardShotSchema` accepts. The label maps below are client-only
 * presentation, keyed off those two enums.
 */
export { SHOT_TYPES, SCREEN_DIRECTIONS } from '../../../server/lib/shotGrammar.js';

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

// One line on what each framing puts on screen, shown under the framing diagrams.
export const SHOT_TYPE_HINTS = Object.freeze({
  'extreme-wide': 'Tiny figure, the whole place around them',
  wide: 'Head to toe, with the room or setting',
  medium: 'Waist up',
  close: 'Head and shoulders, the face fills the frame',
  'extreme-close': 'One detail: the eyes, a hand, an object',
  'over-the-shoulder': 'Past one person\'s shoulder onto the other',
  'two-shot': 'Two people side by side in one frame',
  pov: 'What the character sees, through their eyes',
});

export const SCREEN_DIRECTION_LABELS = Object.freeze({
  left: 'Faces screen-left',
  right: 'Faces screen-right',
  neutral: 'Head-on / neutral',
});
