/**
 * Prompt builders for a Blender model's reference images: the overall sheet
 * (the catalog product sheet drawn from six directions) and one close-up plate
 * per mechanism. Pure, no I/O, the contract of catalogSheetPrompts.js plus
 * `additions`: every block PortOS adds around the user's words. `words` is sent
 * exactly as typed, after the template.
 */
import { promptAddition } from '../../lib/modelInput.js';
import { REFERENCE_SHEET_CONSTANTS } from '../universeCharacterSheet.js';
import { buildSixViewProductSheetPrompt } from './catalogSheetPrompts.js';

const withWords = (blocks, words) => [...blocks.map((block) => block.text), ...(words.trim() ? [words] : [])].join('\n\n');

/** The whole object from six directions at one scale, with its real size stated. */
export function buildModelOverallSheetPrompt(object, { words = '', hasReferences = false } = {}) {
  const sheet = buildSixViewProductSheetPrompt({}, object);
  const additions = [
    promptAddition('model-overall-sheet', 'Six-view product sheet', sheet.prompt),
    hasReferences ? promptAddition('model-source-images', 'Source images', 'The attached images show this exact object. Keep its shape, proportions, materials, colors and markings in every view; do not redesign it.') : null,
  ].filter(Boolean);
  return { ...sheet, prompt: withWords(additions, words), additions };
}

/** One mechanism, square-on and from the side. The first attached image is the approved overall sheet. */
export function buildModelCloseupPrompt(object, { mechanism, words = '' }) {
  const name = object.name?.trim() || 'the object';
  const additions = [
    promptAddition('model-closeup-plate', 'Close-up plate', [
      `MECHANISM REFERENCE PLATE — one mechanism of ${name}, "${mechanism}", on a plain seamless light-grey backdrop.`,
      'Two views side by side at identical scale: left, SQUARE-ON (looking straight at the mechanism); right, SIDE (the same mechanism turned 90 degrees). No perspective distortion. Each view has a caption strip reading "SQUARE-ON" or "SIDE".',
      'Show how it is put together: every separate part, its edges, fasteners, gaps, pivots and thickness, with enough of the surrounding body to place it. Even studio light, accurate materials, crisp edges.',
      'The same parts, materials and proportions in both views. No hands, no people, no busy background, no dimension lines over the object.',
    ].join('\n\n')),
    promptAddition('model-closeup-references', 'Approved sheet', `The first attached image is the approved overall reference sheet of ${name}. Match its shape, proportions, materials and colors exactly; any other attached image shows the same object.`),
  ];
  return {
    prompt: withWords(additions, words), additions,
    negativePrompt: 'hands, people, person, busy background, clutter, multiple different objects, text artifacts, watermark, signature, blurry, distorted proportions, inconsistent views',
    width: REFERENCE_SHEET_CONSTANTS.DEFAULT_WIDTH, height: REFERENCE_SHEET_CONSTANTS.DEFAULT_HEIGHT, modelId: null,
  };
}
