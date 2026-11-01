/**
 * Universe Character — Reference Sheet Renderer (text-template).
 *
 * Generates a single dense artist reference sheet per universe canon
 * character from a structured TEXT prompt that describes every zone of
 * the sheet (turnaround, expressions, palette, wardrobe, props, gestures).
 * Canonical character images condition likeness when available; the prompt
 * supplies the sheet layout and the record's authored details.
 *
 * The route returns the generation id immediately; this module subscribes
 * to mediaJobEvents to copy the result into data/image-refs/ and stamp
 * `character.referenceSheetImageRef` once the render completes.
 */

import { join, basename } from 'path';
import { randomUUID } from 'node:crypto';
import { PATHS, ensureDir, shortId, assertSafeFilename, copyFileGuarded, unlinkGuarded } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { withBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { getSettings } from './settings.js';
import { getUniverse, updateUniverse } from './universeBuilder.js';
import { purgeReferenceSheetFromAllUniverses } from './universeCanon.js';
import { universeAestheticLine } from '../lib/universeVisualStyle.js';
import { applyImageVisualProfile } from './imageGen/visualProfile.js';
import { resolveUniverseVisualProfile } from '../lib/universeVisualProfile.js';
import { promptAddition } from '../lib/modelInput.js';
import { catalogFamilyRenderContext, familyImagesAddition } from './catalogFamily.js';
import { characterSheetEditBase, characterSheetReferenceCandidates, resolveCharacterSheetReferences } from '../lib/characterSheetReferences.js';
import { characterHeightStat } from '../lib/catalogAppearance.js';
import { runwayImagePreservesSourceFrame } from '../lib/runwayImageModels.js';
import { enqueueJob, getJob, mediaJobEvents } from './mediaJobQueue/index.js';
import { buildUniverseRunTag } from './universeRunTag.js';
import { IMAGE_GEN_MODE } from './imageGen/modes.js';
import { resolveRenderTargetConfig } from './imageGen/cloudProviderConfig.js';
import { selectLocalImageModelFromSettings } from './imageGen/prepareParams.js';
import { RENDER_TARGET, recordRenderPin } from '../lib/renderTargets.js';
import {
  flattenStats, flattenPalette, flattenWardrobes, flattenProps, flattenNamedList,
} from '../lib/canonPrompt.js';
import {
  LEGACY_SHEET_VARIANT_ID, readSheetPointer, applySheetPointerToCharacter,
} from '../lib/storyBible.js';
import {
  claimPendingSheetSlot, getPendingSheetSlot, releasePendingSheetSlot,
} from './universeCharacterSheetSlot.js';

// Local FLUX backend: 2048×1536 keeps panel labels legible while still
// rendering in a single pass on Apple Silicon.
const DEFAULT_WIDTH = 2048;
const DEFAULT_HEIGHT = 1536;

// Codex (gpt-image-2) renders up to 4K. For a character concept sheet with
// annotation callouts + close-up panels + multi-view turnaround, text is
// the legibility bottleneck — annotations need enough pixels per glyph to
// stay readable when the user zooms in. Request 4096×3072 (4:3 landscape,
// same aspect as the FLUX default so the template layout stays consistent
// across backends) so the model has room for the panel grid AND the text.
const CODEX_WIDTH = 4096;
const CODEX_HEIGHT = 3072;

// Resolve the (width, height) hint per backend mode. The prompt builders
// return the FLUX-tuned defaults; the renderer overrides for codex so the
// text annotations land at codex's native hi-res instead of being downsampled
// from a smaller request.
// Codex doubles the template's own size, so a portrait-orientation template (a
// single full-body look) keeps its orientation at codex's resolution too.
function resolveSheetDimensions(mode, builtWidth, builtHeight) {
  const width = builtWidth || DEFAULT_WIDTH;
  const height = builtHeight || DEFAULT_HEIGHT;
  if (mode === IMAGE_GEN_MODE.CODEX) return { width: width * (CODEX_WIDTH / DEFAULT_WIDTH), height: height * (CODEX_HEIGHT / DEFAULT_HEIGHT) };
  return { width, height };
}

// Codex/grok/agy/fal/runway describe the init image's fidelity in words
// (describeFidelity): the default 0.25 tells the model to keep the source's
// composition, which would pin a headshot. 0.6 asks for a strong reference
// the template may restage, while identity is held by the edit-base addition.
const PORTRAIT_EDIT_STRENGTH = 0.6;

const DEFAULT_EXPRESSIONS = Object.freeze([
  'neutral', 'curious', 'worried', 'surprised', 'amused', 'determined', 'relaxed',
]);
const DEFAULT_HAND_GESTURES = Object.freeze([
  'relaxed hand', 'pointing', 'peace sign', 'gripping object', 'adjusting accessory',
]);

const trim = (s) => (typeof s === 'string' ? s.trim() : '');

// Style line a sheet carries when no universe supplies one (a catalog-only
// record). Exported so the catalog renderer can list it as a prompt addition.
export const DEFAULT_CHARACTER_SHEET_STYLE = 'Style: contemporary illustrated character design with confident line work and saturated, intentional color.';
// The photographic sheet's style when no universe supplies one.
export const DEFAULT_PHOTOGRAPHIC_SHEET_STYLE = 'Style: natural studio photography with true-to-life color, real skin texture and soft, even key light.';

// Shared field bag used by every variant's prompt builder. Centralizes the
// trim/flatten calls so a new variant only writes the style-specific layout
// sentences. Pure — caller decides which fields to weave into its prompt.
// Exported for reuse by the LoRA training dataset prompt builder
// (server/lib/loraDataset.js), which needs the same canon field extraction.
export function extractCharacterPromptCommon(character) {
  return {
    name: trim(character.name) || 'Unnamed',
    aliases: Array.isArray(character.aliases) ? character.aliases.filter(Boolean).join(', ') : '',
    role: trim(character.role),
    pronouns: trim(character.pronouns),
    age: trim(character.age),
    personality: trim(character.personality),
    speechAccent: trim(character.speechAccent),
    speechPattern: trim(character.speechPattern),
    coreTheme: trim(character.coreTheme),
    visualNotes: trim(character.visualNotes),
    physical: trim(character.physicalDescription),
    silhouette: trim(character.silhouetteNotes),
    posture: trim(character.postureNotes),
    special: trim(character.specialTraits),
    visualIdentity: trim(character.visualIdentity),
    statsLine: flattenStats(character.stats),
    paletteLine: flattenPalette(character.colorPalette),
    wardrobeLine: flattenWardrobes(character.wardrobes),
    propsLine: flattenProps(character.props),
    expressionsLine: flattenNamedList(character.expressions, DEFAULT_EXPRESSIONS),
    gesturesLine: flattenNamedList(character.handGestures, DEFAULT_HAND_GESTURES),
  };
}

/**
 * Build the prompt + render options for one character's reference sheet.
 * Pure function — does no I/O, doesn't enqueue anything. The route handler
 * combines this with `getUniverse` / the media-job queue to drive the
 * actual render. Pure text — no init image, no multi-reference plumbing.
 *
 * Returns `{ prompt, negativePrompt, width, height, modelId }`. modelId is
 * always null here; the renderer fills it in once the active image-gen
 * mode is known.
 */
export function buildCharacterReferenceSheetPrompt(universe, character) {
  if (!universe || !character) {
    throw new ServerError('buildCharacterReferenceSheetPrompt: universe and character are required', {
      status: 400, code: 'VALIDATION_ERROR',
    });
  }

  const styleBits = universeAestheticLine(universe);

  const {
    name, aliases, role, pronouns, age, personality, speechAccent, speechPattern,
    coreTheme, visualNotes, physical, silhouette, posture, special, visualIdentity,
    statsLine, paletteLine, wardrobeLine, propsLine, expressionsLine, gesturesLine,
  } = extractCharacterPromptCommon(character);

  const headerBits = [
    `Name: ${name}.`,
    aliases ? `Alias: ${aliases}.` : '',
    age ? `Age: ${age}.` : '',
    pronouns ? `Pronouns: ${pronouns}.` : '',
    role ? `Role: ${role}.` : '',
    personality ? `Personality: ${personality}.` : '',
    speechAccent ? `Accent: ${speechAccent}.` : '',
    speechPattern ? `Speech pattern: ${speechPattern}.` : '',
    coreTheme ? `Core theme: ${coreTheme}.` : '',
    visualNotes ? `Visual notes: ${visualNotes}.` : '',
  ].filter(Boolean).join(' ');

  // Order matters: the model honors earliest tokens most reliably, so style +
  // header lead, then the per-zone layout enumeration.
  const promptParts = [
    'CHARACTER REFERENCE SHEET — single dense reference page laid out in clear panels with thin borders, clean typography, and labeled zones.',
    styleBits || DEFAULT_CHARACTER_SHEET_STYLE,
    `Character header (top of sheet): ${headerBits}`,
    physical ? `Physical description: ${physical}` : '',
    statsLine ? `Stats panel (small table, left side of header): ${statsLine}.` : '',
    `Main identity + scale sheet (large left zone): four full-body views of ${name} side by side at consistent scale — FRONT view, 3/4 view, SIDE view, BACK view — standing in a neutral pose with a small height-scale ruler in the margin. All four views must read as the same character with consistent proportions, clothing, color, and silhouette.`,
    silhouette ? `Silhouette notes panel (right of the scale sheet): ${silhouette}` : '',
    posture ? `Posture notes panel: ${posture}` : '',
    special ? `Special traits panel: ${special}` : '',
    visualIdentity ? `Visual identity panel: ${visualIdentity}` : '',
    paletteLine ? `Color palette zone (top right): a row of color swatch chips, each labeled, in order — ${paletteLine}.` : '',
    `Expression progression (right side): a row of seven head-and-shoulders portraits of ${name} showing — ${expressionsLine}.`,
    `Micro-expressions row (below expression progression): a row of five subtle headshot variants of ${name} demonstrating restrained facial nuance.`,
    `Head detail sheet (right side, lower): five small portraits of ${name} from different angles — 3/4 headshot, side headshot, top angle, low angle, three-quarter "elegant angle".`,
    `Neutral baseline + posture variation + close-up pose (lower right): one neutral standing pose, one variant posture (leaning or shifted weight), one close-up dramatic pose.`,
    wardrobeLine ? `Wardrobe / accessories details panel (lower left): labeled close-up cards of distinctive wardrobe pieces — ${wardrobeLine}.` : `Wardrobe / accessories details panel (lower left): labeled close-up cards of the character's signature garments and accessories.`,
    propsLine ? `Prop showcase panel (lower middle): a small still-life of the character's signature props — ${propsLine}.` : '',
    `Hand gestures panel (lower right): a row of five labeled hand close-ups showing the character's habitual gestures — ${gesturesLine}.`,
    'Layout: thin black panel borders on off-white paper. Light grey labels under each zone. Consistent character proportions across every view. Render in the same illustrated style throughout the page — do NOT mix art styles between panels.',
  ].filter(Boolean);

  const prompt = promptParts.join('\n\n');
  const negativePrompt = 'multiple characters in the same panel, photographs, text artifacts, watermark, signature, blurry, distorted anatomy, low contrast labels';

  return {
    prompt,
    negativePrompt,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    // modelId is resolved at render time from current settings — see
    // the shared local model selector. Returned as null here so the prompt builder stays
    // pure (no settings I/O) and the renderer is the single decision point.
    modelId: null,
  };
}

/**
 * Pick the two colors that drive the blueprint sheet's "glowing accents" +
 * "structured base" aesthetic from the character's canonical palette. Prefers
 * the human-readable name (`teal`, `cobalt`) for prompt legibility, falls
 * back to hex when name is missing, and finally to a safe cyan/navy pair so
 * the prompt always has two concrete tokens. Pure — no I/O, no settings.
 *
 * Returned as `{ accent, base }`; both are non-empty strings.
 */
export function pickBlueprintColors(palette) {
  const cleaned = Array.isArray(palette)
    ? palette
      .map((c) => trim(c?.name) || trim(c?.hex))
      .filter(Boolean)
    : [];
  const accent = cleaned[0] || 'cyan';
  // Avoid collapsing the two color tokens onto the same string — if the
  // palette only has one entry, fall back to a contrasting default for the
  // base so the prompt's "glowing X on structured Y" reads as two colors.
  const base = (cleaned[1] && cleaned[1] !== accent) ? cleaned[1] : 'navy';
  return { accent, base };
}

/**
 * Blueprint variant — professional character concept sheet aesthetic.
 *
 * The "blueprint" here is the PRESENTATION (annotation callouts, schematic
 * line drawings, technical labels arranged around the figure), NOT a literal
 * blueprint-paper rendering. The character itself is fully illustrated in
 * the universe's own art style — only the surrounding annotation framework
 * and callout lines pick up the accent/base palette colors. This matches
 * the "professional concept art turnaround" look (fully-illustrated
 * character on a clean white sheet, with technical annotations + close-up
 * studies framing the multi-view turnaround), not a cyanotype.
 */
export function buildCharacterBlueprintSheetPrompt(universe, character) {
  if (!universe || !character) {
    throw new ServerError('buildCharacterBlueprintSheetPrompt: universe and character are required', {
      status: 400, code: 'VALIDATION_ERROR',
    });
  }

  const styleBits = universeAestheticLine(universe);

  const {
    name, role, physical, silhouette, special, visualNotes,
    wardrobeLine, propsLine, paletteLine,
  } = extractCharacterPromptCommon(character);
  const { accent, base } = pickBlueprintColors(character.colorPalette);

  const subject = role ? `${name} — ${role}` : name;
  // Concrete label strings (vs abstract "annotations"): gpt-image-2 renders
  // explicit short tokens much more reliably than invented-on-the-fly text.
  // Mirrors the standard sheet's per-zone enumeration where the canon
  // populates each label literally.
  const turnaroundLabels = '"01 FRONT", "02 THREE-QUARTER", "03 SIDE", "04 BACK"';
  const headStudyLabels = '"FACE FRONT", "PROFILE", "THREE-QUARTER", "EXPRESSION"';

  // Lead with the user's exact prompt template (load-bearing phrasing the
  // model anchors on), then layer in canon details with concrete label
  // strings so the model has explicit text to render verbatim — not vague
  // "labels" that come out as gibberish glyphs.
  const promptParts = [
    `A character concept sheet of ${subject}, featuring detailed front, back, and side views, along with close-up sketches of facial features, costume details, and accessories. Annotated design notes and clearly labeled components are arranged across the layout, rendered in a refined blueprint style with glowing ${accent} accents and a structured ${base} base design, presented on a clean white background with a polished professional character design presentation.`,
    styleBits || DEFAULT_CHARACTER_SHEET_STYLE,
    `Header banner across the top of the sheet reads, in bold legible typography: "${name.toUpperCase()}${role ? ` — ${role.toUpperCase()}` : ''}".`,
    `Main turnaround zone (large, fills the left two-thirds of the sheet): four full-body views of ${name} at consistent scale — FRONT, 3/4, SIDE, BACK — all fully illustrated in the universe's color palette. Each view sits over a small caption strip; the four caption strips read, left to right: ${turnaroundLabels}.`,
    physical ? `Physical description (annotation paragraph next to the turnaround): ${physical}` : '',
    visualNotes ? `Visual notes annotation: ${visualNotes}` : '',
    silhouette ? `Silhouette annotation: ${silhouette}` : '',
    special ? `Special traits annotation: ${special}` : '',
    `Facial feature sketches (top-right zone): four close-up sketches of ${name}'s face from different angles, in a 2×2 grid, each below a caption reading one of: ${headStudyLabels}.`,
    wardrobeLine
      ? `Costume detail sketches (right margin column): labeled close-up sketches of distinctive wardrobe pieces. Caption labels read literally: ${wardrobeLine}.`
      : 'Costume detail sketches (right margin column): three labeled close-up sketches of signature garments. Caption labels read literally: "FABRIC", "FASTENINGS", "LAYERING".',
    propsLine
      ? `Accessory sketches (bottom margin row): labeled close-up sketches of the character's signature props. Caption labels read literally: ${propsLine}.`
      : 'Accessory sketches (bottom margin row): three labeled close-up sketches of signature accessories. Caption labels read literally: "ACCESSORY", "GEAR", "PROP".',
    paletteLine
      ? `Color palette swatch row (under the turnaround captions): horizontal row of color chips, each labeled with its swatch name in legible type — ${paletteLine}.`
      : '',
    `Annotation framework: thin guide lines connect each margin sketch to its detail on the figure. Numbered tags ("01", "02", "03", "04") index the four turnaround captions. Margin sketch captions use bold uppercase typography at large size — readable at a glance without zooming.`,
    `Blueprint accent scope: the "refined blueprint style with glowing ${accent} accents and a structured ${base} base design" applies to the ANNOTATION LAYER — guide lines, caption strips, dimension marks, schematic linework, numbered index tags, and frame borders. The CHARACTER and its costume/props stay rendered in the universe's full color palette in a fully illustrated style. Do NOT render the character as a cyanotype, blueprint-paper line drawing, or monochrome wireframe.`,
    'Typography requirement: every caption, label, and header above is rendered as legible, bold, properly-letterformed text — not abstract scribbles, not faux-Latin gibberish, not blurred glyphs. Treat the caption strings as real text strings the viewer will read.',
  ].filter(Boolean);

  const prompt = promptParts.join('\n\n');
  const negativePrompt = 'cyanotype, blueprint paper background, blue paper background, line-art-only character, monochrome character, wireframe character, multiple different characters in the same panel, photograph, painterly background, watercolor wash, dark background, cluttered background, watermark, signature, blurry, distorted anatomy, illegible text, scribbled labels, faux-latin gibberish, blurred caption text, garbled lettering';

  return {
    prompt,
    negativePrompt,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    modelId: null,
  };
}

/**
 * Photographic variant — a photographed turnaround and expression reference
 * of a real person on a plain studio backdrop, for photoreal universes. It
 * ships NO default negatives: the illustrated sheet's negatives (which ban
 * photographs) fight a photographic look, and an empty negative is the
 * user's stated rule for this kind of render.
 */
function buildCharacterPhotographicSheetPrompt(universe, character) {
  if (!universe || !character) {
    throw new ServerError('buildCharacterPhotographicSheetPrompt: universe and character are required', {
      status: 400, code: 'VALIDATION_ERROR',
    });
  }

  const styleBits = universeAestheticLine(universe);
  const {
    name, role, pronouns, age, visualNotes, physical, silhouette, posture, special, visualIdentity,
    wardrobeLine, propsLine, expressionsLine,
  } = extractCharacterPromptCommon(character);

  const height = characterHeightStat(character);
  const headerBits = [
    age ? `Age: ${age}.` : '',
    height ? `Height: ${height}.` : '',
    pronouns ? `Pronouns: ${pronouns}.` : '',
    visualNotes ? `Visual notes: ${visualNotes}.` : '',
  ].filter(Boolean).join(' ');

  const promptParts = [
    `PHOTOGRAPHIC CHARACTER REFERENCE SHEET — one studio contact page of photographs of ONE real person, ${name}${role ? `, ${role}` : ''}, shot on camera against a plain seamless light grey studio backdrop.`,
    styleBits || DEFAULT_PHOTOGRAPHIC_SHEET_STYLE,
    headerBits,
    physical ? `Physical description: ${physical}` : '',
    `Turnaround row (top half): four full-body photographs of ${name} at the same camera height, distance and focal length — FRONT, 3/4, SIDE profile, BACK — standing relaxed with arms slightly away from the body so build, proportions and clothing read clearly.`,
    `Expression row (bottom half): seven head-and-shoulders portrait photographs of the same person facing the camera, showing — ${expressionsLine}.`,
    silhouette ? `Silhouette: ${silhouette}` : '',
    posture ? `Posture: ${posture}` : '',
    special ? `Distinctive traits: ${special}` : '',
    visualIdentity ? `Facial identity: ${visualIdentity}` : '',
    wardrobeLine ? `Wardrobe, identical in every photograph: ${wardrobeLine}.` : 'Wardrobe: the same everyday outfit in every photograph.',
    propsLine ? `Props held or worn where natural: ${propsLine}.` : '',
    'Layout: thin white gutters between frames and a small plain sans-serif caption under each one (FRONT, 3/4, SIDE, BACK, then each expression name). The same person, lighting, exposure and color in every frame.',
  ].filter(Boolean);

  return {
    prompt: promptParts.join('\n\n'),
    negativePrompt: '',
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    modelId: null,
  };
}

/**
 * Photographic face sheet: a row of five head angles (front, both 3/4s, both
 * profiles) over a row of five expressions, all of the same face. It is the
 * close-up reference a shot uses when a head turns, which a full-body sheet's
 * one small face cannot give. Directions are spelled out against the image's
 * edges ("turned toward the LEFT edge of the image"), since "3/4 left" alone
 * reads either way and image models then repeat one side. Hands stay empty:
 * carried props belong on their own object sheets.
 */
function buildCharacterFaceSheetPrompt(universe, character) {
  if (!universe || !character) {
    throw new ServerError('buildCharacterFaceSheetPrompt: universe and character are required', {
      status: 400, code: 'VALIDATION_ERROR',
    });
  }
  const styleBits = universeAestheticLine(universe);
  const { name, age, physical, special, visualIdentity, expressionsLine } = extractCharacterPromptCommon(character);
  const promptParts = [
    `PHOTOGRAPHIC FACE REFERENCE SHEET — ten head-and-shoulders photographs of ONE real person, ${name}, against a plain seamless dark grey studio backdrop, in two rows of five with thin dark gutters and a small plain caption under each frame.`,
    styleBits || DEFAULT_PHOTOGRAPHIC_SHEET_STYLE,
    age ? `Age: ${age}, and they look exactly that age in every frame.` : '',
    physical ? `Physical description: ${physical}` : '',
    visualIdentity ? `Facial identity: ${visualIdentity}` : '',
    special ? `Distinctive traits: ${special}` : '',
    'Top row, neutral expression, the same camera height and distance: FRONT (facing the camera); 3/4 LEFT (head turned toward the LEFT edge of the image, nose pointing image-left); PROFILE LEFT (full side view looking at the LEFT edge); 3/4 RIGHT (turned toward the RIGHT edge); PROFILE RIGHT (full side view looking at the RIGHT edge). The left-facing and right-facing frames are mirror opposites, never repeats of one side.',
    `Bottom row, front or near-front, five expressions of the same face: ${expressionsLine}.`,
    'The same person, hair, skin, age, lighting and exposure in all ten frames. Ordinary relaxed mouth and natural teeth. Hands empty or out of frame: no props, cameras, phones or held objects. Plain everyday top, identical in every frame.',
  ].filter(Boolean);
  return {
    prompt: promptParts.join('\n\n'),
    negativePrompt: '',
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    modelId: null,
  };
}

// Per-generation filename so re-renders don't trample prior versions; the
// "live" sheet pointer on the character always names the newest, but older
// files stay on disk for rollback. The variant token in the middle keeps
// different-style renders from colliding for the same character + jobId pair.
const sheetFilename = (universeId, characterId, generationId, variantToken = 'sheet') =>
  `universe-${shortId(universeId)}-${shortId(characterId)}-${variantToken}-${shortId(generationId)}.png`;

// Catalog of renderable sheet styles. Adding a new variant = entry here +
// a prompt-builder function. Storage routing (legacy field vs map slot) is
// owned by `applySheetPointerToCharacter` / `readSheetPointer` in storyBible.js
// based on the variant id, so new variants need no schema or routing changes.
const SHEET_VARIANTS = Object.freeze({
  [LEGACY_SHEET_VARIANT_ID]: Object.freeze({
    id: LEGACY_SHEET_VARIANT_ID,
    build: buildCharacterReferenceSheetPrompt,
    filenameToken: 'sheet',
    label: 'Illustrated turnaround',
    description: 'Dense multi-zone reference sheet — front/back/side views, expression progression, color palette, wardrobe + props, hand gestures. Renders in the universe\'s defined illustrated style.',
    collectionCategory: 'character-sheet',
    defaultStyle: DEFAULT_CHARACTER_SHEET_STYLE,
  }),
  photographic: Object.freeze({
    id: 'photographic',
    build: buildCharacterPhotographicSheetPrompt,
    filenameToken: 'photo',
    label: 'Photographic turnaround',
    description: 'Studio photographs of a real person on a plain backdrop — front/3/4/side/back full-body views and a row of expression portraits. No default negatives. For photoreal universes.',
    collectionCategory: 'character-photo-sheet',
    defaultStyle: DEFAULT_PHOTOGRAPHIC_SHEET_STYLE,
  }),
  face: Object.freeze({
    id: 'face',
    build: buildCharacterFaceSheetPrompt,
    filenameToken: 'face',
    label: 'Face sheet',
    description: 'Ten head-and-shoulders photographs of the same face: front, both 3/4 turns and both profiles, then five expressions. The close-up reference that keeps a face the same when a shot turns the head.',
    collectionCategory: 'character-face-sheet',
    defaultStyle: DEFAULT_PHOTOGRAPHIC_SHEET_STYLE,
  }),
  blueprint: Object.freeze({
    id: 'blueprint',
    build: buildCharacterBlueprintSheetPrompt,
    filenameToken: 'blueprint',
    label: 'Blueprint concept sheet',
    description: 'Annotated character concept sheet on a clean white background with glowing accent linework over a structured base color. Both colors auto-pick from the character\'s palette.',
    collectionCategory: 'character-blueprint',
    defaultStyle: DEFAULT_CHARACTER_SHEET_STYLE,
  }),
});

function getVariantConfig(variant = LEGACY_SHEET_VARIANT_ID) {
  // Own-property check so `variant=constructor` / `toString` / `hasOwnProperty`
  // from an unfiltered request body can't return an inherited Object.prototype
  // member and have downstream `.build()` / `.storage` access crash with a 500.
  if (!Object.prototype.hasOwnProperty.call(SHEET_VARIANTS, variant)) {
    throw new ServerError(`Unknown character sheet variant "${variant}"`, {
      status: 400, code: 'VALIDATION_ERROR',
    });
  }
  return SHEET_VARIANTS[variant];
}

/** The prompt builder for one character sheet variant (400 on an unknown id). */
export function getSheetVariantBuilder(variant) {
  return getVariantConfig(variant).build;
}

/** The style a variant's template carries when no universe supplies one. */
export function getSheetVariantDefaultStyle(variant) {
  return getVariantConfig(variant).defaultStyle;
}

// Catalog for the UI — pure, no I/O. The client renders one panel row per
// entry. New entries here become available everywhere without further wiring.
// A photoreal universe (`photographic`) lists the photographic sheet first, so
// a picker that defaults to the first entry starts on it.
export function listSheetVariants({ photographic = false } = {}) {
  const all = Object.values(SHEET_VARIANTS);
  const ordered = photographic
    ? [SHEET_VARIANTS.photographic, ...all.filter((v) => v !== SHEET_VARIANTS.photographic)]
    : all;
  return ordered.map((v) => ({
    id: v.id,
    label: v.label,
    description: v.description,
  }));
}

// Single-dispatcher subscription so N pending sheets don't attach 4*N
// listeners on the global `mediaJobEvents` emitter (Node defaults to a
// 10-listener soft cap before warning). Each render claims an entry by
// jobId; the four module-level listeners route events to the right
// subscriber's handlers via O(1) Map lookup instead of N filters.
const sheetSubscribers = new Map(); // jobId → { onStarted, onCompleted, onFailed }
let _sheetListenersAttached = false;
function ensureSheetDispatchListeners() {
  if (_sheetListenersAttached) return;
  _sheetListenersAttached = true;
  mediaJobEvents.on('started', (job) => sheetSubscribers.get(job?.id)?.onStarted?.(job));
  mediaJobEvents.on('completed', (job) => {
    sheetSubscribers.get(job?.id)?.onCompleted?.(job);
    const tag = job?.params?.characterSheet;
    if (!tag) return;
    // The persisted job owns completion, even after restart or listener expiry.
    void onSheetComplete({ ...tag, jobId: job.id, sourceFilename: job.result?.filename })
      .catch((err) => {
        console.error(`❌ Character sheet post-completion failed [${shortId(job.id)}]: ${err?.message}`);
        return null;
      }).then((result) => {
        releasePendingSheetSlot(tag.universeId, tag.entryId, job.id, tag.variant);
        mediaJobEvents.emit('reference-sheet:changed', {
          universeId: tag.universeId, entryId: tag.entryId, jobId: job.id, variant: tag.variant,
          status: result?.superseded ? 'superseded' : result ? 'ready' : 'failed',
        });
      });
  });
  const onTerminal = (job) => {
    sheetSubscribers.get(job?.id)?.onFailed?.(job);
    const tag = job?.params?.characterSheet;
    if (tag) releasePendingSheetSlot(tag.universeId, tag.entryId, job.id, tag.variant);
  };
  mediaJobEvents.on('failed', onTerminal);
  mediaJobEvents.on('canceled', onTerminal);
}
// Routes import this module before queue recovery starts at boot.
ensureSheetDispatchListeners();

function subscribeToSheetJob(jobId, handlers) {
  ensureSheetDispatchListeners();
  sheetSubscribers.set(jobId, handlers);
  return () => { sheetSubscribers.delete(jobId); };
}

/**
 * The queued image params for a sheet: typed overrides, labeled additions
 * (#11317), size, and the cloud/local model choice. Shared by every sheet
 * renderer AND its preview so what a preview shows is what the render sends.
 *
 * `styleLine` is the style block the template carries; it is listed as
 * `styleChip` only when the template (not a typed override) is sent and the
 * block is actually in it. A typed override is sent exactly as written.
 *
 * `editBaseCandidate` is the record's canonical portrait. On a backend that
 * edits, the render starts from it (`initImagePath`) and the other references
 * follow as identity guides; `built` may then be a function of
 * `{ editFromPortrait }` so a template can pick a layout that suits an edit.
 * `form` ({ label }) is the age or look being rendered: its own image is the
 * edit base (never the canonical portrait), canonical images guide likeness
 * only, and with no image of its own the render generates fresh.
 * Returns `{ params, prompt, negativePrompt, modelId, activeMode, referenceImages, editBase }`.
 */
export async function buildSheetRenderParams({
  built: buildOrBuilt,
  options = {},
  styleLine = '',
  renderPin = {},
  visualProfile,
  styleChip = { id: 'universe-style', label: 'Universe style' },
  negativesLabel = 'Character sheet negatives',
  referenceCandidates = [],
  editBaseCandidate = null,
  form = null,
  sharedIdentity = '',
  family = { additions: [], candidates: [] },
  selfName = '',
}) {
  const settings = await getSettings();
  // Text-template rendering works with any image-gen backend. Route through
  // the media-job queue with the active mode set; codex and local are both
  // first-class. External SD-API has no multi-zone layout support, so it
  // gets a clear remediation rather than a silently-degraded render.
  // Render-target ladder (#3231): the record's persisted pin (Phase 3) →
  // the universe-character-sheet pin in settings.renderDefaults → the install
  // default → local.
  const sheetTarget = resolveRenderTargetConfig(settings, RENDER_TARGET.UNIVERSE_CHARACTER_SHEET, {
    recordMode: renderPin?.mode,
    recordModel: renderPin?.modelId,
    fallbackMode: IMAGE_GEN_MODE.LOCAL,
  });
  const activeMode = sheetTarget.mode;
  const cloud = sheetTarget.cloud;
  if (cloud && !cloud.enabled) throw cloud.disabledError;
  const localModel = !cloud && activeMode === IMAGE_GEN_MODE.LOCAL ? selectLocalImageModelFromSettings(settings, options.modelId) : null;
  const modelId = cloud ? cloud.modelId : localModel?.id || null;
  const references = resolveCharacterSheetReferences([...referenceCandidates, ...family.candidates], activeMode, modelId, localModel, editBaseCandidate);
  if (form) {
    const scopeLabel = { form: form.label, canonical: 'canonical · present story' };
    references.images = references.images.map((image) => (image.scope ? { ...image, source: `${image.source} · ${scopeLabel[image.scope]}` } : image));
    if (references.editBase?.scope) references.editBase = { ...references.editBase, source: `${references.editBase.source} · ${form.label}` };
    if (!references.editBase) {
      references.editBase = {
        status: 'none',
        reason: `${form.label} has no image of its own yet, so the sheet is generated fresh rather than edited from the present-day portrait. Assign a ${form.label} reference in the reference library to edit from it.`,
      };
    }
  }
  const editFromPortrait = !!references.initPath;
  if (editFromPortrait && activeMode === IMAGE_GEN_MODE.RUNWAY
    && runwayImagePreservesSourceFrame(modelId, 1 + references.paths.length)) {
    throw new ServerError('Runway FIBO Edit keeps the portrait’s framing with one image and cannot reliably reframe it for the requested sheet or look. Add another compatible reference image or choose another image model.', {
      status: 400, code: 'CHARACTER_SHEET_PORTRAIT_FRAMING_UNSUPPORTED',
    });
  }
  const built = typeof buildOrBuilt === 'function' ? buildOrBuilt({ editFromPortrait }) : buildOrBuilt;

  const hasPromptOverride = typeof options.overridePrompt === 'string' && !!options.overridePrompt.trim();
  // A blank prompt override means "use the template"; a negative override is
  // the user's choice even when empty, so "" sends no template negatives.
  const hasNegativeOverride = typeof options.overrideNegativePrompt === 'string';
  let prompt = hasPromptOverride ? options.overridePrompt : built.prompt;
  const identityAddition = !hasPromptOverride && sharedIdentity && !prompt.includes(sharedIdentity)
    ? promptAddition('shared-character-identity', 'Shared facial identity', sharedIdentity) : null;
  if (identityAddition) prompt += `\n\nShared facial identity: ${sharedIdentity}`;
  const familyAdditions = hasPromptOverride ? [] : family.additions;
  for (const addition of familyAdditions) prompt += `\n\n${addition.text}`;
  const negativePrompt = hasNegativeOverride ? options.overrideNegativePrompt : built.negativePrompt;

  // Sheet renders hard-code cleanC2PA=true (lossless metadata strip — gpt-image
  // adds a caBX provenance chunk we don't want to ship) and denoise=false
  // (the median+sharpen pass blurs annotation text; sheets ship with their
  // text labels AS the product so that pass is never acceptable here).
  // Other render paths still honor the user's per-mode settings.
  const cleanC2PA = true;
  const denoise = false;
  // Codex's image_gen tool can render up to 4K — asking for FLUX's 2048×1536
  // under-uses the available headroom and pixelates annotation text when the
  // user zooms. resolveSheetDimensions doubles the template size for codex
  // while local FLUX keeps the template's memory-tuned size.
  const { width, height } = resolveSheetDimensions(activeMode, built.width, built.height);
  // The sheet template is PortOS's own text around the record's fields; the
  // style and the sheet negatives it carries are listed on the render's
  // sent-prompt record (#11317). A typed override is sent as written.
  const promptAdditions = [
    identityAddition,
    ...familyAdditions,
    !hasPromptOverride && styleLine && prompt.includes(styleLine.trim()) ? promptAddition(styleChip.id, styleChip.label, styleLine) : null,
    !hasNegativeOverride ? promptAddition('sheet-negatives', negativesLabel, built.negativePrompt) : null,
  ].filter(Boolean);
  const baseParams = {
    mode: activeMode,
    prompt,
    negativePrompt,
    ...(promptAdditions.length ? { promptAdditions } : {}),
    width,
    height,
    cleanC2PA,
    denoise,
  };

  let params;
  if (cloud) {
    params = { ...baseParams, ...cloud.providerParams };
  } else if (activeMode === IMAGE_GEN_MODE.LOCAL) {
    if (!modelId) {
      throw new ServerError(
        'No local image-gen models are registered. Install a model via `bash scripts/setup-image-video.sh` before generating a reference sheet.',
        { status: 400, code: 'UNIVERSE_CHARACTER_SHEET_NO_MODEL' },
      );
    }
    params = { ...baseParams, pythonPath: settings.imageGen?.local?.pythonPath || null, modelId };
  } else {
    throw new ServerError(
      `Character reference sheet rendering needs codex or local image-gen mode (currently: ${activeMode}). External SD-API doesn't support the multi-zone layout this renderer produces — switch in Settings → Image Gen.`,
      { status: 400, code: 'UNIVERSE_CHARACTER_SHEET_UNSUPPORTED_MODE' },
    );
  }
  if (references.paths.length) params.referenceImagePaths = references.paths;
  if (editFromPortrait) {
    params.initImagePath = references.initPath;
    params.initImageStrength = PORTRAIT_EDIT_STRENGTH;
  }
  if (!hasPromptOverride) {
    const guides = references.images.filter((image) => image.status === 'included' && image.role !== 'edit-base');
    const ownGuides = guides.some((image) => !image.relative);
    const added = [];
    const otherAgeLine = form && guides.some((image) => image.scope === 'canonical')
      ? ` Some attached images show this person at another age or look than ${form.label}: take only facial identity from them and render the age, build, hairstyle and wardrobe the description asks for.` : '';
    if (editFromPortrait && form) {
      const guideLine = ownGuides ? ` The other attached images of this character are identity guides for the same person.${otherAgeLine}` : '';
      added.push(promptAddition('form-edit-base', `Edit from the ${form.label} reference`, `Edit the FIRST attached image, this character as ${form.label}, into the image described above. Keep this exact person at this age: the same facial structure, eyes, skin, hair color and distinctive marks. Apply the hairstyle, clothing, pose, framing, setting and layout the description asks for, and do not keep the image’s own clothing, crop or background unless the description asks for them.${guideLine}`));
    } else if (editFromPortrait) {
      const guideLine = ownGuides ? ' The other attached images of this character are identity guides for the same person.' : '';
      added.push(promptAddition('portrait-edit-base', 'Edit from the canonical portrait', `Edit the FIRST attached image, the character’s canonical portrait, into the image described above. Keep this exact person: the same facial structure, eyes, skin, hair color and distinctive marks. Apply the age, hairstyle, clothing, pose, framing, setting and layout the description asks for, and do not keep the portrait’s own clothing, crop or background unless the description asks for them.${guideLine}`));
    } else if (ownGuides && form) {
      added.push(promptAddition('character-identity', `Likeness for ${form.label}`, `Use the attached images of this character as the identity reference. Preserve the facial features, skin, hair color, markings and distinctive likeness across every view.${otherAgeLine || ` Render the age, build and wardrobe the description asks for.`}`));
    } else if (ownGuides) {
      added.push(promptAddition('character-identity', 'Canonical character likeness', 'Use the attached canonical character images as the identity reference. Preserve the character’s facial features, proportions, skin, hair, markings and distinctive likeness across every view. Apply the requested age, wardrobe and visual direction while keeping the same character identity.'));
    }
    // Relatives' images come after the record's own, so its identity keeps priority.
    added.push(familyImagesAddition(selfName || built.name || 'this character', guides.filter((image) => image.relative).map((image) => image.relative)));
    for (const addition of added.filter(Boolean)) {
      prompt += `\n\n${addition.text}`;
      params.promptAdditions = [...(params.promptAdditions || []), addition];
    }
    params.prompt = prompt;
  }
  params = applyImageVisualProfile(params, visualProfile);
  return {
    params, settings, prompt: params.prompt, negativePrompt: params.negativePrompt, modelId, activeMode,
    referenceImages: references.images, editBase: references.editBase,
  };
}

// Relatives' images are optional likeness hints: an unavailable one is shown
// as not sent but never blocks the record's own render.
export function assertSheetReferencesAvailable(referenceImages) {
  referenceImages = referenceImages.filter((ref) => !ref.relative);
  if (referenceImages.some((ref) => ref.status === 'unsupported')) {
    throw new ServerError('Canonical references need FLUX.2 or Qwen Image 2.1 on the local backend, or a cloud image backend. Select a supported sheet render target before generating.', {
      status: 400, code: 'CHARACTER_SHEET_REFERENCES_UNSUPPORTED',
    });
  }
  if (referenceImages.some((ref) => ref.status === 'missing')) {
    throw new ServerError('A canonical reference image is unavailable. Restore it or update the character’s references before generating a sheet.', {
      status: 400, code: 'CHARACTER_SHEET_REFERENCE_MISSING',
    });
  }
}

// Load + guard one universe character and build its sheet params. Shared by
// the render and its preview.
async function prepareCharacterSheet(universeId, entryId, options) {
  const variant = options.variant || LEGACY_SHEET_VARIANT_ID;
  const variantConfig = getVariantConfig(variant);
  const loaded = await getUniverse(universeId);
  const universe = { ...loaded, visualProfile: resolveUniverseVisualProfile(loaded, options.visualProfileOverride) };
  const list = Array.isArray(universe.characters) ? universe.characters : [];
  const character = list.find((c) => c.id === entryId);
  if (!character) {
    throw new ServerError(`Character ${entryId} not found in universe`, {
      status: 404, code: 'UNIVERSE_CANON_NOT_FOUND',
    });
  }
  const built = variantConfig.build(universe, character);
  const media = character.ingredientId
    ? await import('./catalogDB.js').then(({ listMediaForIngredient }) => listMediaForIngredient(character.ingredientId))
    : [];
  const universeStyle = universeAestheticLine(universe);
  const sheet = await buildSheetRenderParams({
    built,
    options,
    styleLine: universeStyle || variantConfig.defaultStyle,
    styleChip: universeStyle
      ? { id: 'universe-style', label: 'Universe style' }
      : { id: 'sheet-default-style', label: 'Default sheet style' },
    renderPin: recordRenderPin(universe), visualProfile: options.visualProfileOverride === undefined ? universe.visualProfile : options.visualProfileOverride,
    referenceCandidates: characterSheetReferenceCandidates(character, media),
    editBaseCandidate: characterSheetEditBase(character, media),
    sharedIdentity: character.visualIdentity,
    family: await catalogFamilyRenderContext(character.ingredientId, character.name),
    selfName: character.name,
  });
  return { variant, variantConfig, universe, character, ...sheet };
}

/** What a universe character's sheet render would send, without queueing it. */
export async function previewCharacterReferenceSheet(universeId, entryId, options = {}) {
  const { params, settings, referenceImages, editBase } = await prepareCharacterSheet(universeId, entryId, options);
  const { previewPreparedImagePrompt } = await import('./imageGen/promptPreview.js');
  return {
    promptAdditions: [],
    ...await previewPreparedImagePrompt({ params, settings }),
    referenceImages,
    ...(editBase ? { editBase } : {}),
  };
}

/**
 * Returns immediately with `{ jobId, generationId, filename, path }`.
 * Deferred copy + character stamp run when imageGenEvents emits 'completed';
 * any failure there is logged (the client tracks the render via SSE).
 *
 * `variant` selects the sheet style ('standard' = illustrated turnaround,
 * 'photographic' = studio photo turnaround, 'blueprint' = annotated concept
 * sheet on white). Defaults to 'standard'
 * so existing callers (and the legacy route) stay unchanged.
 */
export async function renderCharacterReferenceSheet(universeId, entryId, options = {}) {
  const {
    variant, variantConfig, universe, character, params, prompt, modelId, activeMode, referenceImages,
  } = await prepareCharacterSheet(universeId, entryId, options);
  // Same frozen-identity guard the character refine/expand flows enforce —
  // the UI gates this too, but the route is reachable directly so the lock
  // has to be enforced server-side as well. 409 mirrors refineUniverseCharacter.
  // Only the render is guarded: a preview never writes.
  if (character.locked === true) {
    throw new ServerError(
      `Character "${character.name}" is locked — unlock it before rendering a reference sheet`,
      { status: 409, code: 'UNIVERSE_CANON_LOCKED' },
    );
  }
  assertSheetReferencesAvailable(referenceImages);

  // Resolve (or create) the universe's media collection up front, then attach
  // a `universeRun` tag to the job so `universeBuilderCollectionHook` files
  // the rendered gallery filename (`<jobId>.png`, distinct from the
  // /data/image-refs/ copy `onSheetComplete` makes for the character pointer)
  // into the same "Universe: <name>" bucket as the rest of the universe's
  // concept art. Bookkeeping is best-effort — if provisioning fails we still
  // run the render, just without the collection-filing side-effect.
  const universeRun = await buildUniverseRunTag({
    universeId: universe.id,
    universeName: universe.name,
    label: character.name,
    category: variantConfig.collectionCategory,
    errorContext: 'character sheet → universe collection provision failed',
  });
  if (universeRun) {
    params.universeRun = universeRun;
  }

  // Persist intent BEFORE enqueue can dispatch. The serialized universe write
  // establishes ordering without timestamps or a process-local pending slot.
  // Retain the token after completion/failure: an older job must stay superseded.
  const requestId = randomUUID();
  await updateUniverse(universeId, (latest) => {
    const current = latest.characters?.find((entry) => entry.id === entryId);
    if (!current) throw new ServerError('Character not found in universe', { status: 404, code: 'UNIVERSE_CANON_NOT_FOUND' });
    return { characters: latest.characters.map((entry) => entry.id === entryId ? {
      ...entry,
      referenceSheetRequests: { ...entry.referenceSheetRequests, [variant]: requestId },
    } : entry) };
  });
  params.characterSheet = { universeId, entryId, variant, requestId };
  const queued = await enqueueJob({ kind: 'image', params });
  const jobId = queued.jobId;
  const latest = await getUniverse(universeId);
  if (latest.characters?.find((entry) => entry.id === entryId)?.referenceSheetRequests?.[variant] === requestId) {
    claimPendingSheetSlot(universeId, entryId, jobId, variant);
  }

  // Per-request listeners only track pending UI state. Expiry releases that
  // state, while the permanent hook still owns publication from the job tag.
  // Queue wait gets a longer window than active rendering.
  const QUEUE_WAIT_MS = 4 * 60 * 60 * 1000; // 4h — generous; survives chained video jobs.
  // 30min sits comfortably above the codex backend's 20min CODEX_TIMEOUT_MS
  // watchdog and the typical local FLUX.2 ceiling, so a legitimate slow
  // render lands its completion (or watchdog-failure) event before this
  // listener detaches. Bumping further is cheap — the detach is purely a
  // bookkeeping safety net for "queue never emits a terminal event".
  const RUN_TIMEOUT_MS = 30 * 60 * 1000;
  let timeoutHandle = null;
  let unsubscribe = null;
  const armTimeout = (ms, reason) => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    timeoutHandle = setTimeout(() => {
      console.log(`⏱️ ${variantConfig.label} render ${reason} [${shortId(jobId)}] — detaching`);
      detach();
    }, ms);
    timeoutHandle.unref?.();
  };
  const detach = (release = true) => {
    if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (release) releasePendingSheetSlot(universeId, entryId, jobId, variant);
  };
  unsubscribe = subscribeToSheetJob(jobId, {
    onStarted: () => armTimeout(RUN_TIMEOUT_MS, 'exceeded run window'),
    onCompleted: () => detach(false),
    onFailed: (job) => {
      detach();
      console.log(`⚠️ ${variantConfig.label} render ${job.status} [${shortId(jobId)}]: ${job.error || 'unknown'}`);
    },
  });
  armTimeout(QUEUE_WAIT_MS, 'queue-wait timeout');
  // Queue admission starts its worker before resolving. A fast completion or
  // cancellation can precede this subscriber; never leave its terminal job pending.
  const admittedJob = getJob(jobId);
  if (['completed', 'failed', 'canceled'].includes(admittedJob?.status ?? queued.status)) detach();
  else if (admittedJob?.status === 'running') armTimeout(RUN_TIMEOUT_MS, 'exceeded run window');

  // Deterministic destination filename — uses the queue's jobId so the client
  // can correlate the persisted pointer with this particular render.
  // onSheetComplete derives the same filename from the same inputs.
  const destFilename = sheetFilename(universeId, entryId, jobId, variantConfig.filenameToken);
  console.log(`🎨 ${variantConfig.label} render — universe=${shortId(universeId)} entry=${shortId(entryId)} job=${shortId(jobId)} mode=${activeMode} model=${modelId} position=${queued.position}`);
  return {
    jobId,
    // `generationId` retained for client back-compat (older clients keyed
    // SSE attachment on this name); it's now an alias for `jobId`.
    generationId: jobId,
    // Echo the resolved variant so the client can route the post-render
    // callback to the right `referenceSheets[<id>]` slot without parsing the
    // filename. Always set, even for the legacy 'standard' variant.
    variant: variantConfig.id,
    queuePosition: queued.position,
    destFilename,
    destPath: `/data/image-refs/${destFilename}`,
    promptPreview: prompt.slice(0, 800),
  };
}

// The completion listener calls this inside the media queue's `completed`
// fan-out, and admission is taken before the first await, so a backup cut that
// is already draining also waits for the sheet copy AND its character pointer:
// a snapshot never captures the pointer without the bytes it names.
export function onSheetComplete(completion) {
  return withBackupAssetPublication(() => publishCompletedSheet(completion));
}

async function publishCompletedSheet({ universeId, entryId, jobId, sourceFilename, requestId, variant = LEGACY_SHEET_VARIANT_ID }) {
  if (!sourceFilename) return null;
  const variantConfig = getVariantConfig(variant);
  await ensureDir(PATHS.imageRefs);
  const destFilename = sheetFilename(universeId, entryId, jobId, variantConfig.filenameToken);
  const srcPath = join(PATHS.images, basename(sourceFilename));
  const destPath = join(PATHS.imageRefs, destFilename);
  // ALWAYS copy the file — even superseded renders are kept on disk for
  // rollback/comparison (they live at `data/image-refs/<...>-<token>-<job>.png`
  // with a unique per-job filename).
  await copyFileGuarded(srcPath, destPath);
  console.log(`📸 ${variantConfig.label} copied to image-refs: ${destFilename}`);

  // Compare the durable request identity inside the serialized write. An
  // absent character/token is superseded too; deletion must not revive a sheet.
  let stamped = false;
  await updateUniverse(universeId, (latest) => {
    const latestList = Array.isArray(latest.characters) ? latest.characters : [];
    const latestIdx = latestList.findIndex((c) => c.id === entryId);
    if (latestIdx < 0 || !requestId || latestList[latestIdx].referenceSheetRequests?.[variant] !== requestId) return null;
    const nextList = latestList.map((e, i) => (
      i === latestIdx ? applySheetPointerToCharacter(e, variant, destFilename) : e
    ));
    stamped = true;
    return { characters: nextList };
  });
  releasePendingSheetSlot(universeId, entryId, jobId, variant);
  if (!stamped) return { filename: destFilename, path: destPath, superseded: true };
  console.log(`📌 Character ${shortId(entryId)} [${variant}] = ${destFilename}`);
  return { filename: destFilename, path: destPath, variant };
}

export async function getCharacterReferenceSheet(universeId, entryId, { variant = LEGACY_SHEET_VARIANT_ID } = {}) {
  getVariantConfig(variant);
  // Capture before the record read so an older snapshot cannot be paired
  // with a just-released slot and mistaken for a failed publication.
  const pendingJobId = getPendingSheetSlot(universeId, entryId, variant) ?? null;
  const universe = await getUniverse(universeId);
  const character = universe.characters?.find(entry => entry.id === entryId);
  if (!character) throw new ServerError('Character not found in universe', { status: 404, code: 'UNIVERSE_CANON_NOT_FOUND' });
  return {
    filename: readSheetPointer(character, variant),
    pendingJobId,
  };
}

/**
 * Delete a character's reference sheet of the given variant — unlinks the
 * file from `PATHS.imageRefs` and clears the variant's pointer (legacy field
 * OR `referenceSheets` map slot) on every matching character. Returns
 * `{ filename, fileDeleted, cleared }`; a missing file is not an error
 * (the lazy `pruneStaleReferenceSheets` may have already nulled the pointer
 * out-of-band) — `fileDeleted: false` distinguishes that case.
 *
 * Mirrors the renderer's lock check so a locked character's sheet stays
 * delete-protected alongside its other AI-managed fields.
 *
 * `variant` defaults to 'standard' so the existing route + client callers
 * stay unchanged.
 *
 * Admitted before the pointer read and held through the purge, so a backup
 * never captures the unlinked file alongside a pointer that still names it.
 */
export function deleteCharacterReferenceSheet(universeId, entryId, options) {
  return withBackupAssetPublication(() => removeCharacterReferenceSheet(universeId, entryId, options));
}

async function removeCharacterReferenceSheet(universeId, entryId, { variant = LEGACY_SHEET_VARIANT_ID } = {}) {
  const variantConfig = getVariantConfig(variant);
  const universe = await getUniverse(universeId);
  const list = Array.isArray(universe.characters) ? universe.characters : [];
  const character = list.find((c) => c.id === entryId);
  if (!character) {
    throw new ServerError(`Character ${entryId} not found in universe`, {
      status: 404, code: 'UNIVERSE_CANON_NOT_FOUND',
    });
  }
  if (character.locked === true) {
    throw new ServerError(
      `Character "${character.name}" is locked — unlock it before deleting the reference sheet`,
      { status: 409, code: 'UNIVERSE_CANON_LOCKED' },
    );
  }
  const filename = readSheetPointer(character, variant);
  if (!filename) {
    return { filename: null, fileDeleted: false, cleared: 0 };
  }
  // Defense-in-depth: the filename was server-stamped via `sheetFilename()`,
  // but re-validate before passing to `unlink` so a hand-edited universes
  // JSON can't smuggle a traversal segment into the filesystem call.
  assertSafeFilename(filename, { extensions: ['.png'], subject: 'reference sheet filename' });

  const target = join(PATHS.imageRefs, filename);
  // ENOENT is benign — the on-disk file may already be gone (out-of-band
  // cleanup, sample-data reset). The pointer-purge below is the canonical
  // clean and runs regardless.
  let fileDeleted = true;
  await unlinkGuarded(target).catch((err) => {
    if (err?.code === 'ENOENT') { fileDeleted = false; return; }
    throw err;
  });
  const { cleared } = await purgeReferenceSheetFromAllUniverses(filename);
  console.log(`🗑️ Deleted ${variantConfig.label.toLowerCase()} ${filename} (file=${fileDeleted}, pointers cleared=${cleared})`);
  return { filename, fileDeleted, cleared };
}

export const REFERENCE_SHEET_CONSTANTS = Object.freeze({
  DEFAULT_WIDTH, DEFAULT_HEIGHT,
  DEFAULT_EXPRESSIONS, DEFAULT_HAND_GESTURES,
});
