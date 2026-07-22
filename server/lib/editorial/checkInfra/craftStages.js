/**
 * Line-craft stage names (#2842 split of checkInfra.js) — the prose anti-pattern,
 * adversarial-cut, sensory/white-room, arc-transition and dialogue-subtext stages
 * plus their small constant vocabularies (`CUT_TYPES`, `ON_THE_NOSE_SUBTYPES`).
 */

// Stage name for the cliché / dead-metaphor / overwriting LLM check (#1308).
// Ships in data.reference/prompts/stages/ + stage-config.json (fresh installs
// via setup-data.js) and migrates to existing installs via migration 101 (boot
// runs migrations but NOT setup-data, so the migration is required). The
// deterministic siblings (prose.cliches, prose.modifier-stacking) need no stage.
export const DEAD_METAPHOR_STAGE = 'pipeline-editorial-dead-metaphor';

// Stage names for the four LLM prose anti-pattern checks (#1300). Each prompt
// ships in data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migrations 103–106 (boot
// runs migrations but NOT setup-data, so the migration is required — see
// scripts/migrations/103-…js … 106-…js). The deterministic sibling
// (prose.italic-thoughts) needs no stage.
export const OPENING_START_STAGE = 'pipeline-editorial-opening-start';
export const MIRROR_DESCRIPTION_STAGE = 'pipeline-editorial-mirror-description';
export const DIALOGUE_PLEASANTRIES_STAGE = 'pipeline-editorial-dialogue-pleasantries';
export const KILL_YOUR_DARLINGS_STAGE = 'pipeline-editorial-kill-your-darlings';

// Stage name for the adversarial-cuts prose-tightening LLM check (#2168). Ships
// in data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js); new file so no migration needed. Asks a ruthless editor
// persona to cut 8–12% of the text, classifying each cut (FAT, REDUNDANT,
// OVER-EXPLAIN, GENERIC, TELL, STRUCTURAL). Safe types (OVER-EXPLAIN, REDUNDANT)
// can be batch-applied mechanically.
export const ADVERSARIAL_CUTS_STAGE = 'pipeline-editorial-adversarial-cuts';

// The six cut types the adversarial-cuts check returns, ordered by safe-to-auto-
// apply (the first two are the "safe majority" per the design doc). The applier
// defaults to OVER-EXPLAIN + REDUNDANT only; other types require manual review.
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

// Stage names for the two scene-grounding LLM checks (#1309): sensory balance
// (all-visual / sensory-bare scenes) and white-room (ungrounded, setting-less
// scenes). Each prompt ships in data.reference/prompts/stages/ + stage-config.json
// (fresh installs via setup-data.js) and migrates to existing installs via
// migration 107 (boot runs migrations but NOT setup-data, so the migration is
// required). Both consume the reverse-outline scene segmentation as context and
// degrade to a whole-issue manuscript scan when no outline exists.
export const SENSORY_BALANCE_STAGE = 'pipeline-editorial-sensory-balance';
export const WHITE_ROOM_STAGE = 'pipeline-editorial-white-room';

// Stage name for the interiority-balance LLM check (#1623): visually dense but
// emotionally empty scenes — heavy on description, light on POV reaction. Ships
// in data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migration 142 (boot runs
// migrations but NOT setup-data, so the migration is required). Like the two
// scene-grounding checks above it consumes the reverse-outline scene
// segmentation as context and degrades to a whole-issue manuscript scan when no
// outline exists.
export const INTERIORITY_BALANCE_STAGE = 'pipeline-editorial-interiority-balance';

// Stage name for the character-arc transition-detection LLM check (#1293). Ships
// in data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migration 109 (boot runs
// migrations but NOT setup-data, so the migration is required). Reads the
// stitched manuscript plus the reverse-outline scene map and the AUTHORED
// per-character arcs to surface genuine change moments + flat-arc warnings.
export const ARC_TRANSITIONS_STAGE = 'pipeline-editorial-arc-transitions';

// Stage name for the character-arc regression / premature-closure LLM check
// (#1619). Ships in data.reference/prompts/stages/ + stage-config.json (fresh
// installs via setup-data.js) and migrates to existing installs via migration 141
// (boot runs migrations but NOT setup-data, so the migration is required). Reads
// the stitched manuscript plus the reverse-outline scene map and the AUTHORED
// per-character arcs, tracks each character's progress across the issues, and
// flags regression (growth then an unmotivated revert), a circular arc (ends
// where it began), or premature closure (an arc resolved early then flat for the
// rest of the series). Complements arc.transitions (which detects the change
// MOMENTS) by judging the SHAPE of each character's progress across the whole arc.
export const ARC_REGRESSION_STAGE = 'pipeline-editorial-arc-regression';

// Stage name for the telling-not-showing-emotion LLM check (#1306). Ships in
// data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migration 110 (boot runs
// migrations but NOT setup-data, so the migration is required). The deterministic
// copy-edit siblings (prose.filter-words, prose.crutch-words, prose.adverbs,
// prose.passive-voice, prose.repeated-gestures, prose.word-echoes,
// prose.sentence-rhythm) need no stage.
export const TELLING_EMOTION_STAGE = 'pipeline-editorial-telling-emotion';

// Stage names for the two dialogue-craft LLM checks (#1307): on-the-nose /
// subtext-free dialogue, and per-character voice distinctiveness. Each prompt
// ships in data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migrations 112–113 (boot
// runs migrations but NOT setup-data, so the migration is required). The
// deterministic siblings (dialogue.said-bookisms, dialogue.attribution-clarity)
// need no stage.
export const ON_THE_NOSE_STAGE = 'pipeline-editorial-on-the-nose';
export const VOICE_DISTINCTIVENESS_STAGE = 'pipeline-editorial-voice-distinctiveness';

// Finding subtypes for `dialogue.on-the-nose` (#1626) — the stage prompt classifies
// each subtext-free line into *why* it reads on-the-nose so the writer gets specific,
// actionable feedback instead of a flat "on-the-nose" label. Surfaced on the finding
// (and persisted comment) as `subtype`; the runner validates the model's value against
// this allow-list and drops anything off-list (→ null) so a stray label can't leak through.
export const ON_THE_NOSE_SUBTYPES = ['exposition', 'emotion-tell', 'relationship-report'];

