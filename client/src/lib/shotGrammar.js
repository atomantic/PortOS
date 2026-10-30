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
  full: 'Full',
  'medium-wide': 'Medium wide / cowboy',
  medium: 'Medium',
  'medium-close': 'Medium close-up',
  close: 'Close-up',
  'extreme-close': 'Extreme close-up',
  insert: 'Insert',
  'over-the-shoulder': 'Over-the-shoulder',
  'two-shot': 'Two-shot',
  pov: 'POV',
});

// One line on what each framing puts on screen, shown under the framing diagrams.
export const SHOT_TYPE_HINTS = Object.freeze({
  'extreme-wide': 'Tiny figure, the whole place around them',
  wide: 'The setting first, people small but readable',
  full: 'Head to toe, the body fills the frame',
  'medium-wide': 'Knees up',
  medium: 'Waist up',
  'medium-close': 'Chest up',
  close: 'Head and shoulders, the face fills the frame',
  'extreme-close': 'One part of the face: the eyes or lips',
  insert: 'A detail cut in: a hand, an object, a sign',
  'over-the-shoulder': 'Past one person\'s shoulder onto the other',
  'two-shot': 'Two people side by side in one frame',
  pov: 'What the character sees, through their eyes',
});

export const SCREEN_DIRECTION_LABELS = Object.freeze({
  left: 'Faces screen-left',
  right: 'Faces screen-right',
  neutral: 'Head-on / neutral',
});
