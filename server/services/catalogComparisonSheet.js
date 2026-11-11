/**
 * Comparison sheet: one shared reference sheet for two characters, laid out
 * as two mirrored halves so it cuts cleanly down its vertical centre.
 *
 * The record the render starts from takes the LEFT half and the chosen
 * partner the RIGHT half. Each half carries one large face, a short teeth
 * strip, a headless front view and a back view; the two back views stand
 * nearest the centre line on one floor line, so the pair's relative height
 * reads across the cut. Height labels sit above the back views' heads, and
 * the same ruler stands on each outer edge, so the image model has a scale to
 * draw against and both halves keep one layout and their own ruler.
 *
 * A finished render lands as three images:
 *   - the whole sheet, on BOTH records (`sheet:comparison`);
 *   - the left half on the starting record and the right half on the partner
 *     (`sheet:comparison-solo`), cut in code at the exact centre column.
 */

import sharp from 'sharp';
import { join } from 'node:path';
import { ServerError } from '../lib/errorHandler.js';
import { PATHS } from '../lib/paths.js';
import { universeAestheticLine } from '../lib/universeVisualStyle.js';
import { characterHeightStat } from '../lib/catalogAppearance.js';
import { resolveHeight } from '../lib/characterHeight.js';
import { resolveImageInputPath } from '../lib/pathSafety.js';
import { CATALOG_COMPARISON_VARIANT_ID } from '../lib/catalogValidation.js';
import { DEFAULT_PHOTOGRAPHIC_SHEET_STYLE, extractCharacterPromptCommon } from './universeCharacterSheet.js';

export const COMPARISON_SHEET_VARIANT_ID = CATALOG_COMPARISON_VARIANT_ID;
export const COMPARISON_SHEET_ROLE = `sheet:${COMPARISON_SHEET_VARIANT_ID}`;
export const COMPARISON_HALF_ROLE = `sheet:${COMPARISON_SHEET_VARIANT_ID}-solo`;
/** Canonical images sent per character: two each fits a four-image model. */
export const COMPARISON_IMAGES_PER_CHARACTER = 2;

// Twice as wide as tall, with an even width so the centre falls between two pixel columns.
const COMPARISON_WIDTH = 2048;
const COMPARISON_HEIGHT = 1024;

export const COMPARISON_SHEET_VARIANT = Object.freeze({
  id: COMPARISON_SHEET_VARIANT_ID,
  label: 'Comparison (two characters)',
  description: 'One shared sheet for this character and another: a large face, a teeth strip, a headless front and a back view of each, standing at their true relative height. It is cut down the centre, so both records get the shared sheet and each keeps its own half.',
});

const imageWords = (count) => (count === 1 ? 'image' : 'images');

// "The first 2 attached images show Ana; the next 1 shows Ben."
function imageMapLine(left, right, leftCount, rightCount) {
  if (!leftCount && !rightCount) return '';
  const parts = [];
  if (leftCount) parts.push(`the first ${leftCount} attached ${imageWords(leftCount)} ${leftCount === 1 ? 'shows' : 'show'} ${left}`);
  if (rightCount) parts.push(`the ${leftCount ? 'next' : 'first'} ${rightCount} attached ${imageWords(rightCount)} ${rightCount === 1 ? 'shows' : 'show'} ${right}`);
  return `Reference images: ${parts.join('; ')}. Keep each person's face, hair, skin, build and clothes exactly as their own images show them, and never blend the two people.`;
}

function personBlock(side, person) {
  const { name, age, physical, visualIdentity, special, wardrobeLine, propsLine } = person.common;
  return [
    `${side} HALF: ${name}.`,
    age ? `Age: ${age}, and they look exactly that age.` : '',
    person.height ? `Height: ${person.height.text}.` : '',
    physical ? `Physical description: ${physical}` : '',
    visualIdentity ? `Facial identity: ${visualIdentity}` : '',
    special ? `Distinctive traits: ${special}` : '',
    wardrobeLine ? `Wardrobe, identical in every view: ${wardrobeLine}.` : '',
    propsLine ? `Carried or worn where natural: ${propsLine}.` : '',
  ].filter(Boolean).join(' ');
}

// How the two heights relate, stated in words the model can draw from.
function heightRelationLine(left, right) {
  if (!left.height?.cm || !right.height?.cm) return '';
  const diff = Math.round(Math.abs(left.height.cm - right.height.cm));
  if (diff < 2) return `${left.common.name} and ${right.common.name} are the same height, so the tops of their heads line up.`;
  const [taller, shorter] = left.height.cm > right.height.cm ? [left, right] : [right, left];
  const inches = Math.round(diff / 2.54);
  return `${taller.common.name} is ${diff} cm (about ${inches} in) taller than ${shorter.common.name}: the top of ${shorter.common.name}'s head reaches ${Math.round((shorter.height.cm / taller.height.cm) * 100)}% of ${taller.common.name}'s height. Draw that difference exactly; both stand on the same floor line.`;
}

const describe = (character) => {
  const common = extractCharacterPromptCommon(character);
  return { common, height: resolveHeight(characterHeightStat(character), common.age) };
};

/**
 * The prompt for a shared two-character sheet. `leftCount` / `rightCount` are
 * how many attached images show each character, in that order.
 * Same contract as the other sheet builders: `{ prompt, negativePrompt, width, height, modelId }`.
 */
export function buildCharacterComparisonSheetPrompt(universe, leftCharacter, rightCharacter, { leftCount = 0, rightCount = 0 } = {}) {
  if (!leftCharacter || !rightCharacter) {
    throw new ServerError('buildCharacterComparisonSheetPrompt: two characters are required', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const left = describe(leftCharacter);
  const right = describe(rightCharacter);
  const L = left.common.name;
  const R = right.common.name;
  const heightLabel = (person) => `${person.common.name}${person.height ? ` ${person.height.text}` : ''}`;
  const promptParts = [
    `TWO-CHARACTER COMPARISON REFERENCE SHEET: one wide studio reference page for two real people, ${L} and ${R}, photographed against one plain, even mid-grey seamless backdrop with no gradient, panels of colour or boxes behind the figures.`,
    universeAestheticLine(universe || {}) || DEFAULT_PHOTOGRAPHIC_SHEET_STYLE,
    imageMapLine(L, R, leftCount, rightCount),
    `Layout: the page is exactly twice as wide as it is tall and is split into two equal halves by an imaginary vertical line down the exact centre. The LEFT half belongs only to ${L} and the RIGHT half only to ${R}. The right half is the mirror image of the left half's layout. Nothing crosses or touches the centre line: leave an empty strip of plain backdrop along it, so the page can be cut in two and each half stands alone.`,
    `From the outer edge of each half toward the centre, in this order: (1) FACE, one large head-and-shoulders portrait that fills most of the half's height, showing the whole head with clear space above the hair, the chin, the full neck and the collar, relaxed natural expression, looking at the camera; (2) directly under the face, TEETH, a short wide close-up strip of the same person's mouth in a natural, unposed laugh with ordinary teeth; (3) FRONT, a full-body standing view from the front with the head absent, the figure ending cleanly at the neck inside the collar like a headless display mannequin, with no face and no hair; (4) BACK, a full-body standing view from behind, including the back of the head and hair. So the two BACK views stand nearest the centre line, one on each side of it.`,
    `All four standing figures are drawn to one scale, feet on one shared floor line, arms relaxed at the sides, whole body visible from the top of the hair to the soles. ${heightRelationLine(left, right)}`.trim(),
    `Height marks: above the head of each BACK view, in the clear space over the hair, a short horizontal line at the level of the top of the head with a small caption over it, "${heightLabel(left)}" over ${L} and "${heightLabel(right)}" over ${R}. The line and caption never touch the hair.`,
    `Rulers: one thin vertical ruler stands at the far outer edge of each half, the left ruler at the page's left edge and an identical mirrored ruler at the page's right edge, each in clear backdrop beside the face and touching nothing. Both rise from the shared floor line, zero at the floor, with evenly spaced ticks and small numbers in the same units as the height captions, reaching a little above the taller person. Draw every standing figure against these rulers, so the top of each head sits at that person's stated height. There is no other ruler, scale bar or grid, and nothing at all along the centre line.`,
    `Captions, small plain sans-serif, never covering a person: "${L}" above the left face and "${R}" above the right face; under the feet of each standing view "${L} FRONT", "${L} BACK", "${R} BACK", "${R} FRONT".`,
    personBlock('LEFT', left),
    personBlock('RIGHT', right),
    'The same lighting, exposure, colour and camera height across the whole page. Hands empty unless a carried item is listed above. One face per person and no other faces: no extra angles, no expression rows, no other people. No film borders, light leaks, scratches or frame edges.',
  ].filter(Boolean);
  return {
    prompt: promptParts.join('\n\n'),
    negativePrompt: '',
    width: COMPARISON_WIDTH,
    height: COMPARISON_HEIGHT,
    modelId: null,
  };
}

/**
 * Cut a finished comparison sheet at its exact vertical centre and save each
 * half to the gallery. Returns `{ left, right }` gallery filenames. An odd
 * width gives the extra column to the right half.
 */
async function splitComparisonSheet(filename, { saveImage } = {}) {
  const source = resolveImageInputPath(join(PATHS.images, filename)) || resolveImageInputPath(join(PATHS.imageRefs, filename));
  if (!source) throw new ServerError(`Comparison sheet "${filename}" is not in the image library`, { status: 404, code: 'NOT_FOUND' });
  const { width, height } = await sharp(source).metadata();
  if (!width || !height || width < 2) throw new ServerError('Comparison sheet has no readable size', { status: 422, code: 'UNSUPPORTED_IMAGE' });
  const centre = Math.floor(width / 2);
  const save = saveImage || (await import('./imageGen/local.js')).saveUploadedGalleryImage;
  const half = async (left, w) => {
    const buffer = await sharp(source).extract({ left, top: 0, width: w, height }).png().toBuffer();
    return (await save(buffer.toString('base64'))).filename;
  };
  return { left: await half(0, centre), right: await half(centre, width - centre) };
}

/**
 * File a finished comparison sheet beyond its starting record: the whole sheet
 * on the partner, the left half on the starting record and the right half on
 * the partner. The partner's attach decides: when the sheet is already on the
 * partner the halves were cut before, so a repeated completion adds nothing.
 * Returns `{ partner, left, right }` or null when there was nothing to do.
 */
export async function publishComparisonSheet({ ingredientId, partnerId, filename, metadata = {} }, deps = {}) {
  const db = deps.db || await import('./catalogDB.js');
  if (!partnerId || partnerId === ingredientId || !(await db.getIngredient(partnerId))) return null;
  const withMetadata = Object.keys(metadata).length > 0 ? { metadata } : {};
  const shared = await db.attachGeneratedMedia(partnerId, filename, { kind: 'reference', role: COMPARISON_SHEET_ROLE, ...withMetadata });
  if (!shared.attached) return null;
  const halves = await splitComparisonSheet(filename, deps);
  const library = { derivedFrom: { mediaKey: filename, kind: 'reference' } };
  await db.attachGeneratedMedia(ingredientId, halves.left, { kind: 'reference', role: COMPARISON_HALF_ROLE, library });
  await db.attachGeneratedMedia(partnerId, halves.right, { kind: 'reference', role: COMPARISON_HALF_ROLE, library });
  return { partner: partnerId, ...halves };
}
