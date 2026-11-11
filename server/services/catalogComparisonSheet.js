/**
 * Comparison sheet: one shared reference sheet for two characters, laid out
 * as two mirrored halves so it cuts cleanly down its vertical centre.
 *
 * The record the render starts from takes the LEFT half and the chosen
 * partner the RIGHT half. Each half carries one large face, a short teeth
 * strip, a headless front view and a back view; the two back views stand
 * nearest the centre line on one floor line, so the pair's relative height
 * reads across the cut. Height labels sit above the back views' heads, and
 * each half has a ruler between its portraits and its standing figures (so it
 * reads as measuring the bodies, not the face), giving the image model a scale
 * to draw against while both halves keep one layout and their own ruler.
 *
 * A finished sheet can be refined as a whole (refineComparisonSheet); the
 * edited version lands the same way, so both records get the new sheet and
 * each gets a new half.
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
import { createKeyCachedQueue } from '../lib/createKeyCachedQueue.js';
import { DEFAULT_PHOTOGRAPHIC_SHEET_STYLE, extractCharacterPromptCommon } from './universeCharacterSheet.js';

export const COMPARISON_SHEET_VARIANT_ID = CATALOG_COMPARISON_VARIANT_ID;
export const COMPARISON_SHEET_ROLE = `sheet:${COMPARISON_SHEET_VARIANT_ID}`;
export const COMPARISON_HALF_ROLE = `sheet:${COMPARISON_SHEET_VARIANT_ID}-solo`;
/** Canonical images sent per character: two each fits a four-image model. */
export const COMPARISON_IMAGES_PER_CHARACTER = 2;

// Twice as wide as tall, with an even width so the centre falls between two pixel columns.
const COMPARISON_WIDTH = 2048;
const COMPARISON_HEIGHT = 1024;
const publicationQueue = createKeyCachedQueue();

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

const IMPERIAL_HEIGHT = /\d\s*(?:ft|feet|foot|'|’)|\d\s*(?:in|inch|inches)\b/i;
const feetAndInches = (inches) => `${Math.floor(inches / 12)} ft${inches % 12 ? ` ${inches % 12} in` : ''}`;
const intervals = (value) => String(Math.round(value * 10) / 10);

// The rulers' range and marks, worked out in code: an image model asked for
// "evenly spaced ticks reaching a little above" draws uneven marks that end
// level with the taller head, then stretches the figures past them. A ruler
// that runs well past the taller person, cut into whole equal intervals, plus
// where each head falls on it, gives the figures a fixed scale to be drawn to.
// Units follow the height captions: feet when any height is stated in feet or
// inches, else centimetres.
function rulerScaleLine(people) {
  const measured = people.filter((person) => Number.isFinite(person.height?.cm));
  if (!measured.length) return 'Every ruler interval is the same length, numbered in the units of the height captions, and the ruler runs well above the taller person. Draw every standing figure against these rulers.';
  const tallest = Math.max(...measured.map((person) => person.height.cm));
  if (people.some((person) => IMPERIAL_HEIGHT.test(person.height?.text || ''))) {
    const top = Math.ceil((tallest / 2.54 + 6) / 12);
    const marks = Array.from({ length: top + 1 }, (_, foot) => (foot ? `${foot} ft` : '0')).join(', ');
    const heads = measured.map((person) => {
      const inches = Math.round(person.height.cm / 2.54);
      return `${person.common.name}'s head top sits at ${feetAndInches(inches)}, ${intervals(inches / 12)} of the ${top} intervals up from the floor`;
    });
    return `Each ruler runs from 0 at the floor line to ${top} ft, well above the taller person's head, and is divided into ${top} one-foot intervals of exactly equal length, the first (0 to 1 ft) the same as every other. A long tick and a small number mark every foot (${marks}), and one shorter tick marks each half foot exactly midway between them; no other ticks. The figures are drawn to this scale: ${heads.join('; ')}.`;
  }
  const top = Math.ceil((tallest + 15) / 50) * 50;
  const heads = measured.map((person) => `${person.common.name}'s head top sits at ${Math.round(person.height.cm)} cm, ${intervals(person.height.cm / 50)} of the ${top / 50} intervals up from the floor`);
  return `Each ruler runs from 0 at the floor line to ${top} cm, well above the taller person's head, and is divided into ${top / 50} intervals of 50 cm, all exactly equal in length, the first (0 to 50 cm) the same as every other. A long tick and a small number mark every 50 cm (${Array.from({ length: top / 50 + 1 }, (_, i) => (i ? `${i * 50} cm` : '0')).join(', ')}), and a shorter tick marks every 10 cm between them; no other ticks. The figures are drawn to this scale: ${heads.join('; ')}.`;
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
    `Each half is a tight grid that uses the whole page with no unused margins. From the outer edge of each half toward the centre, in this order: (1) a portrait column that runs the full page height: FACE, one large head-and-shoulders portrait filling everything above the teeth strip, as big as the column allows, showing the whole head with a little space above the hair, the chin, the full neck and the collar, relaxed natural expression, looking at the camera; and TEETH, a short wide close-up strip of the same person's mouth in a natural, unposed laugh with ordinary teeth, flush with the bottom edge directly under the face; (2) the ruler (below); (3) FRONT, a full-body standing view from the front with the head absent, the figure ending cleanly at the neck inside the collar like a headless display mannequin, with no face and no hair; (4) BACK, a full-body standing view from behind, including the back of the head and hair. So the two BACK views stand nearest the centre line, one on each side of it.`,
    `The standing figures and rulers also use the full page height: one shared floor line near the bottom edge, leaving only a thin strip under the feet for their captions, and the tops of the rulers near the top edge, so the taller person's head sits a little below them with room above for the height caption. All four standing figures are drawn to one scale, feet on that floor line, arms relaxed at the sides, whole body visible from the top of the hair to the soles. ${heightRelationLine(left, right)}`.trim(),
    `Height marks: above the head of each BACK view, in the clear space over the hair, a short horizontal line level with the top of the head and with that person's height on the ruler, with a small caption over it, "${heightLabel(left)}" over ${L} and "${heightLabel(right)}" over ${R}. The line and caption never touch the hair.`,
    `Rulers: in each half one thin vertical ruler stands in clear backdrop between the portrait column and the FRONT view, on the inner side of the portraits and right beside the standing figures, so it reads as measuring the bodies and never the face. The right half's ruler mirrors the left half's at the same distance from the centre line. Each ruler touches nothing and rises from the shared floor line with zero at the floor. ${rulerScaleLine([left, right])} There is no other ruler, scale bar or grid, and nothing at all along the centre line.`,
    `Captions, small plain sans-serif, never covering a person: "${L}" in the top outer corner of the left face panel and "${R}" in the top outer corner of the right face panel; under the feet of each standing view "${L} FRONT", "${L} BACK", "${R} BACK", "${R} FRONT".`,
    personBlock('LEFT', left),
    personBlock('RIGHT', right),
    'Before finishing, check the page against the rulers: every head top level with its own height on its ruler and its height line, never above it, and every ruler interval the same length.',
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
async function splitComparisonSheet(filename, { saveImage, existing = {} } = {}) {
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
  return { left: existing.left || await half(0, centre), right: existing.right || await half(centre, width - centre) };
}

/**
 * File a finished comparison sheet beyond its starting record: the whole sheet
 * on the partner, the left half on the starting record and the right half on
 * the partner. Existing halves are found by their source lineage, so a retry
 * after a failed split or attach finishes the missing pieces without duplicates.
 * Returns `{ partner, left, right }` or null when there was nothing to do.
 */
export async function publishComparisonSheet({ ingredientId, partnerId, filename, metadata = {}, derivedFrom = null }, deps = {}) {
  return publicationQueue(`${ingredientId}:${partnerId}:${filename}`, async () => {
    const db = deps.db || await import('./catalogDB.js');
    if (!partnerId || partnerId === ingredientId || !(await db.getIngredient(partnerId))) return null;
    const withMetadata = Object.keys(metadata).length > 0 ? { metadata } : {};
    // An edited sheet keeps its lineage on the partner's copy too.
    const withLineage = derivedFrom?.mediaKey ? { library: { derivedFrom } } : {};
    const shared = await db.attachGeneratedMedia(partnerId, filename, { kind: 'reference', role: COMPARISON_SHEET_ROLE, ...withMetadata, ...withLineage });
    const [leftMedia, rightMedia] = await Promise.all([db.listMediaForIngredient(ingredientId), db.listMediaForIngredient(partnerId)]);
    const existingHalf = (rows) => rows.find((row) => row.role === COMPARISON_HALF_ROLE && row.library?.derivedFrom?.mediaKey === filename)?.mediaKey;
    const existing = { left: existingHalf(leftMedia), right: existingHalf(rightMedia) };
    if (!shared.attached && existing.left && existing.right) return null;
    const halves = existing.left && existing.right ? existing : await splitComparisonSheet(filename, { ...deps, existing });
    const library = { derivedFrom: { mediaKey: filename, kind: 'reference' } };
    await db.attachGeneratedMedia(ingredientId, halves.left, { kind: 'reference', role: COMPARISON_HALF_ROLE, library });
    await db.attachGeneratedMedia(partnerId, halves.right, { kind: 'reference', role: COMPARISON_HALF_ROLE, library });
    return { partner: partnerId, ...halves };
  });
}

/**
 * Edit a finished comparison sheet as a new version, from either record's copy.
 * The edit sends the whole sheet as the init image and lands like a fresh
 * render (tagged for the same pair and sides), so the attach hook files it on
 * both records and cuts new halves. The left record is the copy that names its
 * partner (`library.comparedWith`); the partner's copy finds it by that link.
 */
export async function refineComparisonSheet(item, source, input, { preview = false } = {}, deps = {}) {
  const db = deps.db || { ...await import('./catalogDB/ingredients.js'), ...await import('./catalogDB/media.js') };
  const refine = deps.refine || await import('./catalogMediaRefinement.js');
  const partnerOf = source.library?.comparedWith;
  const leftId = partnerOf ? item.id
    : (await db.listMediaHoldersByKey(source.mediaKey, COMPARISON_SHEET_ROLE)).find((row) => row.library?.comparedWith === item.id)?.ingredientId;
  const rightId = partnerOf || item.id;
  const [left, right] = leftId ? await Promise.all([db.getIngredient(leftId), db.getIngredient(rightId)]) : [];
  if (!left || !right || left.id === right.id) {
    throw new ServerError('The other character on this comparison sheet is no longer in the catalog', { status: 409, code: 'COMPARISON_PARTNER_MISSING' });
  }
  // From the partner's copy, the edit lands first on the left record, which the caller has not checked.
  if (left.id !== item.id) {
    const { assertCatalogIdentityWritable } = await import('./catalogDB/identityAccess.js');
    await assertCatalogIdentityWritable(left.id);
    if (left.payload?.locked === true) throw new ServerError(`"${left.name}" is locked: unlock it before refining this comparison sheet`, { status: 409 });
  }
  const dimensions = await refine.readEditSourceDimensions(source.mediaKey);
  const target = await refine.resolveCatalogImageTarget(left.id);
  const { promptAddition } = await import('../lib/modelInput.js');
  const additions = [
    promptAddition('reference-guidance-heading', 'Editing guidance heading', 'Editing guidance:'),
    promptAddition('comparison-edit', 'Comparison sheet refinement', `Refine the attached two-character comparison sheet as a new version: ${left.name} on the LEFT half, ${right.name} on the RIGHT half. Change only what the editing guidance asks. Keep everything else exactly as it is: both people's faces, hair, bodies, clothes and relative heights, the mirrored layout of the two halves, and the empty strip of plain backdrop down the exact vertical centre that nothing crosses, so the page still cuts cleanly into two halves. Keep any rulers' intervals equal and every head level with its own height on its ruler. No watermark.`),
    promptAddition('reference-style', 'Universe visual style', target.universe ? universeAestheticLine(target.universe) : ''),
  ].filter(Boolean);
  const body = {
    ...refine.catalogImageBackend(target),
    prompt: [additions[0].text, input.feedback, ...additions.slice(1).map((a) => a.text)].join('\n\n'), promptAdditions: additions,
    initImageFile: source.mediaKey, referenceImageFiles: [],
    ...dimensions,
  };
  if (preview) {
    const { previewImagePrompt } = await import('./imageGen/promptPreview.js');
    return previewImagePrompt(body);
  }
  return refine.enqueueCatalogImage(body, { ...target, catalogAttach: {
    ingredientId: left.id, kind: 'reference', role: COMPARISON_SHEET_ROLE, inspect: true,
    comparison: { partnerId: right.id },
    library: { comparedWith: right.id, derivedFrom: { mediaKey: source.mediaKey, kind: source.kind } },
  } });
}
