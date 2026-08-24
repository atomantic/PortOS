/**
 * FableLoom scene formats — how a loom's scene text is WRITTEN, and therefore
 * how every generative stage is told to write it.
 *
 * A loom is either narrated prose (second-person interactive fiction) or a
 * teleplay (sluglines, action lines, character cues). The choice is one field
 * on the record, and each stage that produces scene text renders the matching
 * contract into its prompt — so the format lives here once rather than as
 * three near-duplicate paragraphs across the templates.
 *
 * A leaf module (no imports): the validation schemas, the sanitizer, and the
 * weave service all read from it without pulling in the service graph.
 */

export const LOOM_FORMATS = Object.freeze(['prose', 'teleplay']);
export const LOOM_FORMAT_DEFAULT = 'prose';

export const isLoomFormat = (value) => LOOM_FORMATS.includes(value);

/** Normalize a stored/incoming format, falling back to the default. */
export const asLoomFormat = (value) => (isLoomFormat(value) ? value : LOOM_FORMAT_DEFAULT);

// What each stage is told about the `prose` field it generates. Written as
// prompt bullets: the templates render them under their own heading.
const SCENE_CONTRACTS = Object.freeze({
  prose: [
    "Each scene's `prose` is 100–250 words of second-person present-tense narration that ends at a decision point (except endings, which resolve).",
    'Write flowing narrative paragraphs — no sluglines, no character cues, no screenplay formatting.',
  ].join('\n'),
  teleplay: [
    "Each scene's `prose` is a teleplay fragment in standard screenplay format, 120–250 words, ending at a decision point (except endings, which resolve).",
    'Open with a slugline in caps (`INT. HOLDING CELL - NIGHT`). Action lines are present tense, third person, no camera directions.',
    'Character cues are ALL CAPS on their own line above the dialogue; parentheticals go on their own line in lowercase. Introduce a character with their name in caps the first time they appear in an action line.',
    'Use `\\n` line breaks between every slugline, action block, cue, and dialogue block — the text is rendered as written.',
  ].join('\n'),
});

// How the narrator answers a reader mid-scene, in the loom's format.
const NARRATION_CONTRACTS = Object.freeze({
  prose: '1–3 short paragraphs of second-person present-tense prose.',
  teleplay: 'a short teleplay fragment — action lines in present tense, plus a character cue and dialogue when someone speaks. No slugline unless the location changes.',
});

export const sceneFormatContract = (format) => SCENE_CONTRACTS[asLoomFormat(format)];
export const narrationFormatContract = (format) => NARRATION_CONTRACTS[asLoomFormat(format)];

/** Human label for the format, used in prompts and error copy. */
export const loomFormatLabel = (format) => (asLoomFormat(format) === 'teleplay' ? 'teleplay / screenplay' : 'narrated prose');
