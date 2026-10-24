/**
 * Catalog reference-sheet prompt builders for places and objects, plus the
 * wardrobe look reference for a character.
 *
 * Same contract as the character builders in universeCharacterSheet.js:
 * `(universe, entry) → { prompt, negativePrompt, width, height, modelId }`,
 * pure, no I/O. `universe` may be an empty object (a catalog record with no
 * linked universe). Place/object sheets carry their default style; a look
 * receives explicit visual direction from its renderer.
 */

import { ServerError } from '../lib/errorHandler.js';
import { universeAestheticLine } from '../lib/universeVisualStyle.js';
import { REFERENCE_SHEET_CONSTANTS, extractCharacterPromptCommon } from './universeCharacterSheet.js';

const { DEFAULT_WIDTH, DEFAULT_HEIGHT } = REFERENCE_SHEET_CONSTANTS;

const trim = (s) => (typeof s === 'string' ? s.trim() : '');

export const DEFAULT_ENVIRONMENT_SHEET_STYLE = 'Style: cinematic environment concept art with grounded lighting, readable depth, and a deliberate, cohesive color script.';
export const DEFAULT_PRODUCT_SHEET_STYLE = 'Style: clean industrial-design product rendering with accurate materials, crisp edges, and soft studio lighting.';

function requireEntry(entry, fn) {
  if (!entry || typeof entry !== 'object') {
    throw new ServerError(`${fn}: entry is required`, { status: 400, code: 'VALIDATION_ERROR' });
  }
}

/** Environment sheet for a place: establishing wide, reverse, inserts, palette — no people. */
export function buildEnvironmentSheetPrompt(universe, place) {
  requireEntry(place, 'buildEnvironmentSheetPrompt');
  const styleBits = universeAestheticLine(universe || {});
  const name = trim(place.name) || 'Unnamed place';
  const slugline = trim(place.slugline);
  const description = trim(place.description);
  const palette = trim(place.palette);
  const era = trim(place.era);
  const weather = trim(place.weather);
  const intExt = trim(place.intExt);
  const timeOfDay = trim(place.timeOfDay);
  const recurring = trim(place.recurringDetails);
  const visualPrompt = trim(place.prompt);

  const headerBits = [
    `Location: ${name}.`,
    slugline ? `Slugline: ${slugline}.` : '',
    intExt ? `${intExt === 'INT' ? 'Interior' : 'Exterior'}.` : '',
    timeOfDay ? `Time of day: ${timeOfDay}.` : '',
    era ? `Era: ${era}.` : '',
    weather ? `Weather: ${weather}.` : '',
  ].filter(Boolean).join(' ');

  const promptParts = [
    'ENVIRONMENT REFERENCE SHEET — single location design page laid out in clear panels with thin borders, clean typography, and labeled zones. The location is EMPTY: no people, no characters, no figures anywhere on the sheet.',
    styleBits || DEFAULT_ENVIRONMENT_SHEET_STYLE,
    `Sheet header (top of sheet): ${headerBits}`,
    description ? `Location description: ${description}` : '',
    visualPrompt ? `Visual notes: ${visualPrompt}` : '',
    `Establishing wide shot (large top zone): a wide establishing view of ${name} showing its full layout, scale, and how the space reads at a glance, labeled "ESTABLISHING".`,
    `Reverse angle (middle left): the same location seen from the opposite direction, so the space reads consistently in three dimensions, labeled "REVERSE".`,
    `Detail inserts (middle right): a row of three close-up inserts of characteristic surfaces, fixtures, and textures of ${name}, each labeled.`,
    recurring ? `Recurring details panel: labeled callouts of the details that must stay consistent in every shot — ${recurring}.` : '',
    palette
      ? `Color palette strip (bottom): a row of labeled color swatch chips taken from the location — ${palette}.`
      : `Color palette strip (bottom): a row of five labeled color swatch chips sampled from the location's dominant colors.`,
    'Layout: thin black panel borders on off-white paper. Light grey labels under each zone. The same location, lighting, and architecture across every panel. Render in one consistent style throughout the page — do NOT mix art styles between panels.',
  ].filter(Boolean);

  return {
    prompt: promptParts.join('\n\n'),
    negativePrompt: 'people, person, characters, figures, crowd, faces, text artifacts, watermark, signature, blurry, distorted perspective, inconsistent architecture, low contrast labels',
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    modelId: null,
  };
}

/** Product sheet for an object: orthographic views on a plain backdrop, scale reference, macro detail. */
export function buildProductSheetPrompt(universe, object) {
  requireEntry(object, 'buildProductSheetPrompt');
  const styleBits = universeAestheticLine(universe || {});
  const name = trim(object.name) || 'Unnamed object';
  const aliases = Array.isArray(object.aliases) ? object.aliases.map(trim).filter(Boolean).join(', ') : '';
  const description = trim(object.description);
  const significance = trim(object.significance);
  const visualPrompt = trim(object.prompt);

  const promptParts = [
    'PRODUCT REFERENCE SHEET — single object design page laid out in clear panels with thin borders, clean typography, and labeled views, on a plain seamless light-grey backdrop.',
    styleBits || DEFAULT_PRODUCT_SHEET_STYLE,
    `Sheet header (top of sheet): Object: ${name}.${aliases ? ` Also known as: ${aliases}.` : ''}`,
    description ? `Object description: ${description}` : '',
    significance ? `Significance: ${significance}` : '',
    visualPrompt ? `Visual notes: ${visualPrompt}` : '',
    `Orthographic views (large top zone): four views of ${name} side by side at identical scale — FRONT, SIDE, BACK, TOP — each on the plain backdrop with a soft contact shadow and a caption strip reading "FRONT", "SIDE", "BACK", "TOP".`,
    `Scale reference (lower left): ${name} beside a simple measuring ruler and a neutral reference object so its real-world size reads clearly, labeled "SCALE".`,
    `Macro detail (lower right): two close-up macro shots of the most distinctive material, surface finish, marking, or mechanism of ${name}, each labeled.`,
    'Layout: thin black panel borders, light grey labels under each view. The same object, materials, and proportions in every view. No hands, no people, no busy background. Render in one consistent style throughout the page.',
  ].filter(Boolean);

  return {
    prompt: promptParts.join('\n\n'),
    negativePrompt: 'hands, people, person, busy background, clutter, multiple different objects, text artifacts, watermark, signature, blurry, distorted proportions, inconsistent views, low contrast labels',
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    modelId: null,
  };
}

/**
 * Look reference for a character wearing one of its wardrobes: the same
 * person (identity from the record's own fields) in full-body views using the
 * chosen visual direction, no text. `wardrobe` is a `payload.wardrobes` entry.
 */
export function buildCharacterLookPrompt(universe, character, wardrobe, direction) {
  requireEntry(character, 'buildCharacterLookPrompt');
  requireEntry(wardrobe, 'buildCharacterLookPrompt');
  const { name, age, pronouns, physical, silhouette, posture, special, visualIdentity, visualNotes } =
    extractCharacterPromptCommon(character);
  const lookName = trim(wardrobe.name) || 'Unnamed look';
  const lookDescription = trim(wardrobe.description);

  const identityBits = [
    `Character: ${name}.`,
    age ? `Age: ${age}.` : '',
    pronouns ? `Pronouns: ${pronouns}.` : '',
  ].filter(Boolean).join(' ');

  const promptParts = [
    `LOOK REFERENCE — a costume reference of one character, ${name}, wearing a single outfit, shown as three full-body views side by side at identical scale: FRONT, THREE-QUARTER and BACK, standing in a relaxed neutral pose. Use the visual direction below consistently across every view, including its medium, camera, lighting and environment.`,
    direction?.styleLine || '',
    identityBits,
    physical ? `Physical description: ${physical}` : '',
    silhouette ? `Silhouette: ${silhouette}` : '',
    posture ? `Posture: ${posture}` : '',
    special ? `Special traits: ${special}` : '',
    visualIdentity ? `Visual identity: ${visualIdentity}` : '',
    visualNotes ? `Visual notes: ${visualNotes}` : '',
    `Outfit: ${lookName}.`,
    lookDescription ? `Outfit description: ${lookDescription}` : '',
    `Every view shows the same person with the same face, hair, proportions and the complete outfit from head to toe, including footwear and accessories. Keep the outfit readable within the specified environment. No props beyond what the outfit includes, no other people, no text, no labels, no captions.`,
  ].filter(Boolean);

  return {
    prompt: promptParts.join('\n\n'),
    negativePrompt: 'text, labels, captions, watermark, signature, multiple different characters, busy background, cropped feet, cropped head, inconsistent outfit between views, distorted anatomy, blurry',
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    modelId: null,
  };
}
