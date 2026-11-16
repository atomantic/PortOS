/**
 * Line-craft stage names — the prose anti-pattern, adversarial-cut, sensory/white-room,
 * arc-transition and dialogue-subtext stages plus their small constant vocabularies
 * (`CUT_TYPES`, `ON_THE_NOSE_SUBTYPES`).
 */

// Stage prompts ship in data.reference/ (fresh installs) and reach existing installs
// via the numbered migrations below (boot runs migrations but NOT setup-data).

// Cliché / dead-metaphor / overwriting check (migration 101).
export const DEAD_METAPHOR_STAGE = 'pipeline-editorial-dead-metaphor';

// Four LLM prose anti-pattern checks (migrations 103-106).
export const OPENING_START_STAGE = 'pipeline-editorial-opening-start';
export const MIRROR_DESCRIPTION_STAGE = 'pipeline-editorial-mirror-description';
export const DIALOGUE_PLEASANTRIES_STAGE = 'pipeline-editorial-dialogue-pleasantries';
export const KILL_YOUR_DARLINGS_STAGE = 'pipeline-editorial-kill-your-darlings';

// Adversarial cuts: an editor cuts 8-12% of the text (no migration).
export const ADVERSARIAL_CUTS_STAGE = 'pipeline-editorial-adversarial-cuts';

// Cut types ordered by safe-to-auto-apply; the applier defaults to the first two.
export const CUT_TYPES = Object.freeze([
  'OVER-EXPLAIN',
  'REDUNDANT',
  'FAT',
  'GENERIC',
  'TELL',
  'STRUCTURAL',
]);
// The subset that can be auto-applied without manual review.
export const SAFE_CUT_TYPES = Object.freeze(['OVER-EXPLAIN', 'REDUNDANT']);

// Scene-grounding checks (migration 107); like summary-not-scene and interiority-balance
// they use the reverse-outline scene segmentation, else a whole-issue scan.
export const SENSORY_BALANCE_STAGE = 'pipeline-editorial-sensory-balance';
export const WHITE_ROOM_STAGE = 'pipeline-editorial-white-room';

// Dramatizable beats narrated as summary instead of played in-scene (migration 227).
export const SUMMARY_NOT_SCENE_STAGE = 'pipeline-editorial-summary-not-scene';

// Visually dense but emotionally empty scenes (migration 142).
export const INTERIORITY_BALANCE_STAGE = 'pipeline-editorial-interiority-balance';

// Character-arc transition detection; reads manuscript, scene map and authored arcs
// (migration 109).
export const ARC_TRANSITIONS_STAGE = 'pipeline-editorial-arc-transitions';

// Arc regression / circular arc / premature closure, judging the SHAPE of progress
// across the arc (complements arc.transitions; migration 141).
export const ARC_REGRESSION_STAGE = 'pipeline-editorial-arc-regression';

// Telling-not-showing emotion (migration 110).
export const TELLING_EMOTION_STAGE = 'pipeline-editorial-telling-emotion';

// Interiority register: thought rendered in an essayistic voice (migration 230).
export const INTERIORITY_REGISTER_STAGE = 'pipeline-editorial-interiority-register';

// Dialogue craft: on-the-nose dialogue and voice distinctiveness (migrations 112-113).
export const ON_THE_NOSE_STAGE = 'pipeline-editorial-on-the-nose';
export const VOICE_DISTINCTIVENESS_STAGE = 'pipeline-editorial-voice-distinctiveness';

// Decisive utterance delivered as narrated report instead of a quoted line; the
// inverse of ON_THE_NOSE_STAGE (migration 229).
export const REPORTED_SPEECH_STAGE = 'pipeline-editorial-reported-speech';

// Finding subtypes for `dialogue.on-the-nose`; the runner validates the model's value
// against this list and nulls anything off-list.
export const ON_THE_NOSE_SUBTYPES = ['exposition', 'emotion-tell', 'relationship-report'];

