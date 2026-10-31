/**
 * Storyboard shot-grammar display labels, over the controlled vocabularies in
 * `server/lib/shotGrammar.js` (#1315).
 *
 * `SHOT_TYPES` / `SCREEN_DIRECTIONS` are re-exported from the server leaf rather
 * than copied, so a hand-set value in the storyboards editor always matches what
 * `storyboardShotSchema` accepts. The label maps below are client-only
 * presentation, keyed off those two enums.
 */
export { SHOT_ANGLES, SHOT_COMPOSITIONS, SHOT_FACINGS, SHOT_TYPES, SCREEN_DIRECTIONS } from '../../../server/lib/shotGrammar.js';

export const SHOT_TYPE_LABELS = Object.freeze({
  'extreme-wide': 'Extreme wide',
  wide: 'Wide',
  full: 'Full',
  'medium-wide': 'Medium wide',
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
  wide: 'Establishing: the setting first, people small but readable',
  full: 'Head to toe, the body fills the frame',
  'medium-wide': 'Knees up (cowboy shot)',
  medium: 'Waist up',
  'medium-close': 'Chest up',
  close: 'Head and shoulders, the face fills the frame',
  'extreme-close': 'One part of the face: the eyes or lips',
  insert: 'A detail cut in: a hand, an object, a sign',
  'over-the-shoulder': 'Past one person\'s shoulder onto the other',
  'two-shot': 'Two people side by side in one frame',
  pov: 'What the character sees, through their eyes',
});

export const SHOT_ANGLE_LABELS = Object.freeze({
  'eye-level': 'Eye level',
  high: 'High angle',
  low: 'Low angle',
  'birds-eye': "Bird's eye",
  'worms-eye': "Worm's eye",
  dutch: 'Dutch tilt',
});

export const SHOT_ANGLE_HINTS = Object.freeze({
  'eye-level': 'Camera level with their eyes, neutral',
  high: 'Camera above, looking down: they feel smaller',
  low: 'Camera below, looking up: they feel bigger',
  'birds-eye': 'Straight down from overhead',
  'worms-eye': 'From the ground, looking steeply up',
  dutch: 'Camera rolled so the horizon tilts: unease',
});

export const SHOT_FACING_LABELS = Object.freeze({
  front: 'Front',
  'three-quarter': '3/4',
  profile: 'Profile',
  'three-quarter-back': '3/4 back',
  back: 'Back',
});

export const SHOT_FACING_HINTS = Object.freeze({
  front: 'Facing the camera head-on',
  'three-quarter': 'Turned about 45° from the camera',
  profile: 'Side-on to the camera',
  'three-quarter-back': 'Turned mostly away, face barely seen',
  back: 'From behind, facing away',
});

export const SHOT_COMPOSITION_LABELS = Object.freeze({
  center: 'Center',
  'left-third': 'Left third',
  'right-third': 'Right third',
  'cut-left': 'Half off left',
  'cut-right': 'Half off right',
  'low-in-frame': 'Low in frame',
});

export const SHOT_COMPOSITION_HINTS = Object.freeze({
  center: 'Centered, symmetrical',
  'left-third': 'On the left third, open space to the right',
  'right-third': 'On the right third, open space to the left',
  'cut-left': 'At the left edge, partly cut off by the frame',
  'cut-right': 'At the right edge, partly cut off by the frame',
  'low-in-frame': 'Low in the frame, lots of empty space above',
});

export const SCREEN_DIRECTION_LABELS = Object.freeze({
  left: 'Faces screen-left',
  right: 'Faces screen-right',
  neutral: 'Head-on / neutral',
});
