/**
 * Universe Character — Reference Sheet Renderer (text-template).
 *
 * Generates a single dense artist reference sheet per universe canon
 * character from a structured TEXT prompt that describes every zone of
 * the sheet (turnaround, expressions, palette, wardrobe, props, gestures).
 * No init image or multi-reference input is required — the rich prompt
 * itself is the "template", so the renderer works equally well across
 * any image-gen backend (codex, local, future nano-banana).
 *
 * The route returns the generation id immediately; this module subscribes
 * to mediaJobEvents to copy the result into data/image-refs/ and stamp
 * `character.referenceSheetImageRef` once the render completes.
 */

import { copyFile, unlink } from 'fs/promises';
import { join, basename } from 'path';
import { PATHS, ensureDir, shortId, assertSafeFilename } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { getSettings } from './settings.js';
import { getUniverse, updateUniverse } from './universeBuilder.js';
import { buildStyleClause, purgeReferenceSheetFromAllUniverses } from './universeCanon.js';
import { getImageModels } from '../lib/mediaModels.js';
import { enqueueJob, mediaJobEvents } from './mediaJobQueue/index.js';
import { buildUniverseRunTag } from './universeRunTag.js';
import { IMAGE_GEN_MODE, CODEX_IMAGEGEN_DEFAULT_MODEL } from './imageGen/modes.js';
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
function resolveSheetDimensions(mode, builtWidth, builtHeight) {
  if (mode === IMAGE_GEN_MODE.CODEX) return { width: CODEX_WIDTH, height: CODEX_HEIGHT };
  return { width: builtWidth || DEFAULT_WIDTH, height: builtHeight || DEFAULT_HEIGHT };
}

// Resolve the local-mode model id. With pure text-template rendering we no
// longer depend on FLUX.2-specific init-image / multi-ref flags, so any
// registered model is fair game. Order:
//   1. Explicit override (when it matches a registered model).
//   2. settings.imageGen.local.modelId.
//   3. First available local model.
// Returns null when nothing is registered; caller surfaces the 400.
export function resolveSheetModelId({ override, settings, allModels }) {
  const findById = (id) => (typeof id === 'string' ? allModels.find((m) => m.id === id) : null);
  const trimmedOverride = typeof override === 'string' ? override.trim() : '';
  return findById(trimmedOverride)?.id
    ?? findById(settings?.imageGen?.local?.modelId)?.id
    ?? allModels[0]?.id
    ?? null;
}

const DEFAULT_EXPRESSIONS = Object.freeze([
  'neutral', 'curious', 'worried', 'surprised', 'amused', 'determined', 'relaxed',
]);
const DEFAULT_HAND_GESTURES = Object.freeze([
  'relaxed hand', 'pointing', 'peace sign', 'gripping object', 'adjusting accessory',
]);

const trim = (s) => (typeof s === 'string' ? s.trim() : '');

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

  const styleClause = buildStyleClause(universe);
  const styleBits = styleClause.startsWith('(none provided') ? '' : styleClause;

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
    styleBits || 'Style: contemporary illustrated character design with confident line work and saturated, intentional color.',
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
    // resolveSheetModelId. Returned as null here so the prompt builder stays
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

  const styleClause = buildStyleClause(universe);
  const styleBits = styleClause.startsWith('(none provided') ? '' : styleClause;

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
    styleBits || 'Style: contemporary illustrated character design with confident line work and saturated, intentional color.',
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
  }),
  blueprint: Object.freeze({
    id: 'blueprint',
    build: buildCharacterBlueprintSheetPrompt,
    filenameToken: 'blueprint',
    label: 'Blueprint concept sheet',
    description: 'Annotated character concept sheet on a clean white background with glowing accent linework over a structured base color. Both colors auto-pick from the character\'s palette.',
    collectionCategory: 'character-blueprint',
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

// Catalog for the UI — pure, no I/O. The client renders one panel row per
// entry. New entries here become available everywhere without further wiring.
export function listSheetVariants() {
  return Object.values(SHEET_VARIANTS).map((v) => ({
    id: v.id,
    label: v.label,
    description: v.description,
  }));
}

// `(universeId, characterId) → latest generationId requested` is owned by
// `./universeCharacterSheetSlot.js` (extracted so universeBuilder.js can
// clear slots on delete without an import cycle). The supersede-aware
// contract is unchanged: a render claims the slot at enqueue, the
// completion handler only stamps `referenceSheetImageRef` when the slot
// still holds its jobId, and a newer render overwrites the slot so the
// older one sees itself as superseded.

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
  mediaJobEvents.on('completed', (job) => sheetSubscribers.get(job?.id)?.onCompleted?.(job));
  const onTerminal = (job) => sheetSubscribers.get(job?.id)?.onFailed?.(job);
  mediaJobEvents.on('failed', onTerminal);
  mediaJobEvents.on('canceled', onTerminal);
}
function subscribeToSheetJob(jobId, handlers) {
  ensureSheetDispatchListeners();
  sheetSubscribers.set(jobId, handlers);
  return () => { sheetSubscribers.delete(jobId); };
}

/**
 * Returns immediately with `{ jobId, generationId, filename, path }`.
 * Deferred copy + character stamp run when imageGenEvents emits 'completed';
 * any failure there is logged (the client tracks the render via SSE).
 *
 * `variant` selects the sheet style ('standard' = illustrated turnaround,
 * 'blueprint' = annotated concept sheet on white). Defaults to 'standard'
 * so existing callers (and the legacy route) stay unchanged.
 */
export async function renderCharacterReferenceSheet(universeId, entryId, options = {}) {
  const variant = options.variant || LEGACY_SHEET_VARIANT_ID;
  const variantConfig = getVariantConfig(variant);
  const universe = await getUniverse(universeId);
  const list = Array.isArray(universe.characters) ? universe.characters : [];
  const character = list.find((c) => c.id === entryId);
  if (!character) {
    throw new ServerError(`Character ${entryId} not found in universe`, {
      status: 404, code: 'UNIVERSE_CANON_NOT_FOUND',
    });
  }
  // Same frozen-identity guard the character refine/expand flows enforce —
  // the UI gates this too, but the route is reachable directly so the lock
  // has to be enforced server-side as well. 409 mirrors refineUniverseCharacter.
  if (character.locked === true) {
    throw new ServerError(
      `Character "${character.name}" is locked — unlock it before rendering a reference sheet`,
      { status: 409, code: 'UNIVERSE_CANON_LOCKED' },
    );
  }

  const built = variantConfig.build(universe, character);

  const prompt = typeof options.overridePrompt === 'string' && options.overridePrompt.trim()
    ? options.overridePrompt.trim()
    : built.prompt;
  const negativePrompt = typeof options.overrideNegativePrompt === 'string' && options.overrideNegativePrompt.trim()
    ? options.overrideNegativePrompt.trim()
    : built.negativePrompt;

  const settings = await getSettings();
  // Text-template rendering works with any image-gen backend. Route through
  // the media-job queue with the active mode set; codex and local are both
  // first-class. External SD-API has no multi-zone layout support, so it
  // gets a clear remediation rather than a silently-degraded render.
  const activeMode = settings.imageGen?.mode || IMAGE_GEN_MODE.LOCAL;
  // Sheet renders hard-code cleanC2PA=true (lossless metadata strip — gpt-image
  // adds a caBX provenance chunk we don't want to ship) and denoise=false
  // (the median+sharpen pass blurs annotation text; sheets ship with their
  // text labels AS the product so that pass is never acceptable here).
  // Other render paths still honor the user's per-mode settings.
  const cleanC2PA = true;
  const denoise = false;
  // Codex's image_gen tool can render up to 4K — asking for FLUX's 2048×1536
  // under-uses the available headroom and pixelates annotation text when the
  // user zooms. resolveSheetDimensions bumps codex up to 4K landscape while
  // local FLUX keeps its memory-tuned 2048×1536 defaults.
  const { width, height } = resolveSheetDimensions(activeMode, built.width, built.height);
  const baseParams = {
    mode: activeMode,
    prompt,
    negativePrompt,
    width,
    height,
    cleanC2PA,
    denoise,
  };

  let modelId = null;
  let params;
  if (activeMode === IMAGE_GEN_MODE.CODEX) {
    const c = settings.imageGen?.codex || {};
    if (!c.enabled) {
      throw new ServerError(
        'Codex Imagegen is disabled — enable it in Settings → Image Gen first',
        { status: 400, code: 'CODEX_IMAGEGEN_DISABLED' },
      );
    }
    modelId = c.model || CODEX_IMAGEGEN_DEFAULT_MODEL;
    params = { ...baseParams, codexPath: c.codexPath, model: c.model, effort: c.effort };
  } else if (activeMode === IMAGE_GEN_MODE.LOCAL) {
    const allModels = getImageModels();
    modelId = resolveSheetModelId({ override: options.modelId, settings, allModels });
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

  // Enqueue through mediaJobQueue so the render serializes through the right
  // backend lane alongside Image Gen / Universe Builder renders. The queue
  // dispatches by `params.mode` (codex → codex lane, local → GPU lane).
  const queued = enqueueJob({ kind: 'image', params });
  const jobId = queued.jobId;
  // Claim the latest-pending slot for this character + variant. onSheetComplete
  // checks it before stamping — guards against an older-but-slower render
  // finishing after a newer one and overwriting the newer pointer. The variant
  // key keeps standard and blueprint slots independent so a blueprint render
  // can't be superseded by an illustrated one or vice versa.
  claimPendingSheetSlot(universeId, entryId, jobId, variant);

  // Subscribe to the queue's completion bus via the shared sheet
  // dispatcher (NOT imageGenEvents directly — the queue mediates the
  // imageGen lifecycle and re-emits on mediaJobEvents with the full job
  // record). The shared dispatcher caps listeners at 4 regardless of how
  // many sheets are pending (see `subscribeToSheetJob` above), so a user
  // running 10+ parallel character renders won't trip
  // MaxListenersExceededWarning on the global emitter.
  //
  // Two-stage timeout: a generous queue-wait window covers the pre-start
  // gap (so a sheet queued behind a long video / first-run-download
  // doesn't detach mid-queue), then the `started` event resets the timer
  // to the tighter run window. Without the reset, a sheet waiting 30+
  // minutes behind a video job would lose its bookkeeping listener
  // before onSheetComplete had a chance to run — file copy + character
  // pointer stamp lost.
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
  const detach = () => {
    if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  };
  unsubscribe = subscribeToSheetJob(jobId, {
    onStarted: () => armTimeout(RUN_TIMEOUT_MS, 'exceeded run window'),
    onCompleted: async (job) => {
      detach();
      const sourceFilename = job.result?.filename;
      await onSheetComplete({ universeId, entryId, jobId, sourceFilename, variant }).catch((err) => {
        console.error(`❌ ${variantConfig.label} post-completion failed [${shortId(jobId)}]: ${err?.message}`);
      });
    },
    onFailed: (job) => {
      detach();
      // Release the slot so a retry render doesn't get superseded by this dead one.
      releasePendingSheetSlot(universeId, entryId, jobId, variant);
      console.log(`⚠️ ${variantConfig.label} render ${job.status} [${shortId(jobId)}]: ${job.error || 'unknown'}`);
    },
  });
  armTimeout(QUEUE_WAIT_MS, 'queue-wait timeout');

  // Deterministic destination filename — uses the queue's jobId so the client
  // can patch optimistically on SSE completion without a universe refetch.
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

export async function onSheetComplete({ universeId, entryId, jobId, sourceFilename, variant = LEGACY_SHEET_VARIANT_ID }) {
  if (!sourceFilename) return null;
  const variantConfig = getVariantConfig(variant);
  await ensureDir(PATHS.imageRefs);
  const destFilename = sheetFilename(universeId, entryId, jobId, variantConfig.filenameToken);
  const srcPath = join(PATHS.images, basename(sourceFilename));
  const destPath = join(PATHS.imageRefs, destFilename);
  // ALWAYS copy the file — even superseded renders are kept on disk for
  // rollback/comparison (they live at `data/image-refs/<...>-<token>-<job>.png`
  // with a unique per-job filename).
  await copyFile(srcPath, destPath);
  console.log(`📸 ${variantConfig.label} copied to image-refs: ${destFilename}`);

  // If a newer render has been started for this character+variant while ours
  // was in flight (OR the character was deleted, which clears all variants'
  // slots), the slot no longer holds our jobId. Skip the stamp — the newer
  // render will stamp its own filename when it finishes, and a deleted
  // character would re-introduce an orphaned pointer. Without this, an
  // older-but-slower render could overwrite a newer-but-finished pointer.
  if (getPendingSheetSlot(universeId, entryId, variant) !== jobId) {
    console.log(`⏭️ ${variantConfig.label} [${shortId(jobId)}] superseded by newer render — file saved, pointer not stamped`);
    return { filename: destFilename, path: destPath, superseded: true };
  }
  // Stamp ONLY the variant's pointer (legacy field OR `referenceSheets` map
  // slot) inside the write queue against the freshest persisted universe so
  // a concurrent user edit (or sibling render landing close in time) can't
  // clobber unrelated character fields. The sheet file lives in
  // data/image-refs/, distinct from `imageRefs[]` (gallery, /data/images/) —
  // polluting imageRefs would 404 the CanonCard thumbnail.
  let stamped = false;
  await updateUniverse(universeId, (latest) => {
    const latestList = Array.isArray(latest.characters) ? latest.characters : [];
    const latestIdx = latestList.findIndex((c) => c.id === entryId);
    if (latestIdx < 0) return null;
    const nextList = latestList.map((e, i) => (
      i === latestIdx ? applySheetPointerToCharacter(e, variant, destFilename) : e
    ));
    stamped = true;
    return { characters: nextList };
  });
  // Release the slot only after a successful stamp AND only if it still
  // belongs to us — between the supersede check and this delete, a newer
  // render could have started, claimed the slot, and arrived here in
  // parallel. An unconditional delete would wipe the newer render's slot
  // and cause its onSheetComplete to see "superseded" (slot empty ≠ jobId)
  // and skip its own stamp — leaving the older filename persisted. A
  // failed stamp leaves the slot owned by us so the next render-start
  // cleanly overwrites it.
  releasePendingSheetSlot(universeId, entryId, jobId, variant);
  if (!stamped) {
    console.log(`⚠️ Character ${entryId} not found post-render — ${variantConfig.label.toLowerCase()} saved but not linked`);
    return null;
  }
  console.log(`📌 Character ${shortId(entryId)} [${variant}] = ${destFilename}`);
  return { filename: destFilename, path: destPath, variant };
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
 */
export async function deleteCharacterReferenceSheet(universeId, entryId, { variant = LEGACY_SHEET_VARIANT_ID } = {}) {
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
  await unlink(target).catch((err) => {
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
