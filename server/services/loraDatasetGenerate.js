/**
 * LoRA dataset generation — reference-material renders + sheet slicing.
 *
 * Builds single-subject training prompts from a universe bible subject's canon (the
 * inverse of the dense reference-sheet layout: one clean figure on a
 * neutral background per image), enqueues them on the media-job queue, and
 * copies completed renders into the dataset. Also slices an existing
 * reference-sheet turnaround into individual training crops via sharp
 * (fixed grid — the model-generated sheet layout is non-deterministic, so
 * automatic panel detection is deferred; the user prunes bad crops in the
 * dataset grid UI).
 *
 * Mirrors `universeCharacterSheet.js`'s enqueue → single-dispatcher
 * subscribe → copy pattern, including the two-stage queue-wait/run
 * timeout. See that module for the rationale on each piece.
 */

import { copyFile, readFile } from 'fs/promises';
import { join, basename } from 'path';
import sharp from 'sharp';
import { PATHS, ensureDir, shortId } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { buildVariationMatrix } from '../lib/loraDataset.js';
import { extractJson } from '../lib/jsonExtract.js';
import { readSheetPointer, LEGACY_SHEET_VARIANT_ID } from '../lib/storyBible.js';
import { describeImageDataUrlDetailed } from './visionTest.js';
import { resolveCaptionModel, withCaptionVisionLock } from './loraDatasetCaption.js';
import { getSettings } from './settings.js';
import { getUniverse } from './universeBuilder.js';
import { buildStyleClause } from './universeCanon.js';
import {
  extractCharacterPromptCommon,
  resolveSheetModelId,
  REFERENCE_SHEET_CONSTANTS,
} from './universeCharacterSheet.js';
import { getImageModels } from '../lib/mediaModels.js';
import { enqueueJob, mediaJobEvents } from './mediaJobQueue/index.js';
import { IMAGE_GEN_MODE } from './imageGen/modes.js';
import { resolveCloudProviderConfig } from './imageGen/cloudProviderConfig.js';
import {
  datasetImagePath,
  datasetImagesDir,
  getDataset,
  updateDataset,
} from './loraDatasets.js';

// Training images render square — FLUX trains at square resolutions and a
// consistent aspect keeps the latent-precompute path simple.
const DATASET_IMAGE_SIZE = 1024;

const trim = (s) => (typeof s === 'string' ? s.trim() : '');
const normalizeEntryKind = (entryKind) => (
  ['characters', 'objects', 'places'].includes(entryKind) ? entryKind : 'characters'
);
const subjectLabel = (entryKind) => {
  switch (normalizeEntryKind(entryKind)) {
    case 'objects': return 'Object';
    case 'places': return 'Place';
    default: return 'Character';
  }
};

const flattenValue = (value) => {
  if (typeof value === 'string') return trim(value);
  if (Array.isArray(value)) {
    return value.map((v) => {
      if (typeof v === 'string') return trim(v);
      if (v && typeof v === 'object') return trim(v.name || v.label || v.description || v.prompt || '');
      return '';
    }).filter(Boolean).join(', ');
  }
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([key, v]) => `${key}: ${typeof v === 'string' ? trim(v) : trim(v?.name || v?.label || '')}`)
      .filter((part) => !part.endsWith(': '))
      .join(', ');
  }
  return '';
};

/**
 * Pull the subject's INVARIANT signature features — the wardrobe pieces, props,
 * and palette that are present in (nearly) every reference image and therefore
 * belong to the trigger token, not the per-shot caption. Returned as discrete
 * short phrases so the captioner can be told to omit them by name (issue #1320:
 * captioning "red cloak, woven crown, leather armor" in every shot binds the
 * look to those phrases instead of the trigger). Pure; tolerant of the bible's
 * looser object/place shape. Capped + de-duped so the deny-list stays focused.
 */
export function extractSubjectSignaturePhrases(subject, entryKind = 'characters') {
  if (!subject || typeof subject !== 'object') return [];
  const out = [];
  const pushNames = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      const name = trim(item?.name);
      if (name) out.push(name);
    }
  };
  if (normalizeEntryKind(entryKind) === 'characters') {
    pushNames(subject.wardrobes);
    pushNames(subject.props);
    pushNames(subject.colorPalette);
  } else {
    // Objects/places: the recurring details + palette are the invariants. In the
    // looser object/place bible shape both can be a string OR an array, so route
    // them through flattenValue (handles both) rather than the array-only
    // pushNames — a string `palette` would otherwise be dropped entirely.
    for (const raw of [subject.colorPalette || subject.palette, subject.recurringDetails]) {
      const flat = flattenValue(raw);
      if (flat) out.push(...flat.split(',').map((p) => p.trim()));
    }
  }
  const visualIdentity = trim(subject.visualIdentity);
  if (visualIdentity) out.push(visualIdentity);
  const seen = new Set();
  return out
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()))
    .slice(0, 12);
}

/**
 * Build the image-gen prompt + negative prompt for ONE dataset image.
 * Leads with the universe style, then the character identity block, then
 * the variation clause, and hard-bans collage/sheet/text artifacts.
 * Pure — exported for tests.
 */
export function buildDatasetImagePrompt(universe, subject, variation = {}, entryKind = 'characters') {
  const kind = normalizeEntryKind(entryKind);
  const styleClause = buildStyleClause(universe || {});
  const styleBits = styleClause.startsWith('(none provided') ? '' : styleClause;
  if (kind !== 'characters') {
    const name = trim(subject?.name || subject?.slugline) || 'Unnamed';
    const description = flattenValue(subject?.description || subject?.prompt);
    const significance = flattenValue(subject?.significance);
    const palette = flattenValue(subject?.palette || subject?.colorPalette);
    const recurring = flattenValue(subject?.recurringDetails);
    const tags = Array.isArray(subject?.tags) && subject.tags.length ? subject.tags.join(', ') : '';
    const identityBits = [
      `${subjectLabel(kind)}: ${name}.`,
      description ? `Description: ${description}.` : '',
      significance ? `Significance: ${significance}.` : '',
      recurring ? `Recurring details: ${recurring}.` : '',
      palette ? `Palette: ${palette}.` : '',
      tags ? `Tags: ${tags}.` : '',
    ].filter(Boolean).join(' ');

    const view = trim(variation.view) || (kind === 'objects' ? 'three-quarter view' : 'wide establishing view');
    const composition = trim(variation.pose) || (kind === 'objects' ? 'centered presentation' : 'clear establishing composition');
    const lighting = trim(variation.expression) || 'natural lighting';
    const setting = trim(variation.outfit) || (kind === 'objects' ? 'plain studio plinth' : 'signature environment');
    const subjectBits = kind === 'objects'
      ? [
        'Single object only',
        view,
        composition,
        lighting,
        `setting: ${setting}`,
        'full object in frame',
        'unobstructed silhouette',
      ]
      : [
        'Single location focus',
        view,
        composition,
        lighting,
        `environment state: ${setting}`,
        'no prominent characters',
        'clear spatial layout',
      ];

    return {
      prompt: [
        styleBits || 'Style: contemporary illustrated fantasy design with confident line work and saturated, intentional color.',
        identityBits,
        `${subjectBits.filter(Boolean).join(', ')}, no text, no panels, no labels.`,
      ].filter(Boolean).join('\n\n'),
      negativePrompt: kind === 'objects'
        ? 'person, hands covering the object, multiple objects, duplicate object, reference sheet, panel borders, grid, collage, text, labels, watermark, signature, blurry, cropped object, deformed geometry'
        : 'prominent character, crowd, reference sheet, panel borders, grid, collage, text, labels, watermark, signature, blurry, distorted perspective, unreadable layout',
    };
  }

  const {
    name, role, physical, silhouette, posture, special, visualIdentity,
    paletteLine, wardrobeLine, propsLine,
  } = extractCharacterPromptCommon(subject || {});

  const identityBits = [
    `Character: ${name}.`,
    role ? `Role: ${role}.` : '',
    physical ? `Physical description: ${physical}` : '',
    silhouette ? `Silhouette: ${silhouette}` : '',
    posture ? `Posture: ${posture}` : '',
    special ? `Special traits: ${special}` : '',
    visualIdentity ? `Visual identity: ${visualIdentity}` : '',
    paletteLine ? `Color palette: ${paletteLine}.` : '',
  ].filter(Boolean).join(' ');

  const outfitBit = trim(variation.outfit) && variation.outfit !== 'signature outfit'
    ? `wearing ${variation.outfit}`
    : (wardrobeLine ? `wearing their signature wardrobe — ${wardrobeLine}` : 'wearing their signature outfit');

  const variationBits = [
    'Solo subject',
    trim(variation.view) || 'three-quarter view',
    trim(variation.pose) || 'standing relaxed',
    trim(variation.expression) ? `${variation.expression} expression` : '',
    outfitBit,
    'full body in frame',
  ].filter(Boolean).join(', ');

  const promptParts = [
    styleBits || 'Style: contemporary illustrated character design with confident line work and saturated, intentional color.',
    identityBits,
    propsLine ? `Signature props (carry or wear where natural): ${propsLine}.` : '',
    `${variationBits}, plain neutral studio background, even lighting, no text, no panels, no labels.`,
  ].filter(Boolean);

  return {
    prompt: promptParts.join('\n\n'),
    negativePrompt: 'multiple people, reference sheet, panel borders, grid, collage, text, labels, watermark, signature, blurry, distorted anatomy, cropped head, cropped feet',
  };
}

/**
 * Derive the expression/outfit variation axes from character canon.
 * Pure — exported for tests.
 */
export function deriveVariationAxes(character) {
  const kind = normalizeEntryKind(character?.entryKind);
  if (kind === 'objects') {
    return {
      expressions: ['soft studio lighting', 'warm firelight', 'cool moonlight', 'harsh desert sun', 'low dungeon torchlight'],
      outfits: ['plain studio plinth', 'weathered wooden table', 'snow-covered stone', 'sunlit desert sand', 'torchlit dungeon floor'],
    };
  }
  if (kind === 'places') {
    return {
      expressions: ['clear daylight', 'golden hour', 'moonlit night', 'stormy overcast', 'torchlit darkness'],
      outfits: ['signature environment', 'after rainfall', 'dusty dry season', 'busy lived-in state', 'abandoned quiet state'],
    };
  }
  const names = (list) => (Array.isArray(list)
    ? list.map((e) => trim(e?.name)).filter(Boolean)
    : []);
  const expressions = names(character?.expressions);
  const outfits = names(character?.wardrobes);
  return {
    expressions: expressions.length ? expressions : [...REFERENCE_SHEET_CONSTANTS.DEFAULT_EXPRESSIONS],
    outfits: outfits.length ? outfits : ['signature outfit'],
  };
}

/**
 * Live variation axes (expression/outfit for characters; lighting/setting for
 * objects & places) for a dataset's subject — the same vocab the generator
 * defaults to. Exposed so the generate-batch dialog can seed its override
 * chips from the server vocab instead of mirroring the object/place axis
 * constants client-side. Throws 409 when the subject was deleted (mirrors
 * the generate/slice paths); the caller fetches it silently.
 */
export async function getDatasetVariationAxes(datasetId) {
  const dataset = await getDataset(datasetId);
  const { subject } = await loadDatasetSubject(dataset);
  return deriveVariationAxes(subject);
}

// Load the dataset's live canon subject (generation + slicing both need
// the current canon, not the dataset's snapshot). 409 when the subject
// was deleted from the universe after the dataset was created.
// Exported so the captioner can derive the subject's signature-feature
// deny-list without duplicating the universe/entry lookup.
export async function loadDatasetSubject(dataset) {
  const entryKind = normalizeEntryKind(dataset.character.entryKind);
  const universe = await getUniverse(dataset.character.universeId);
  const entries = Array.isArray(universe[entryKind]) ? universe[entryKind] : [];
  const subject = entries.find((entry) => entry.id === dataset.character.entryId);
  if (!subject) {
    throw new ServerError(
      `${subjectLabel(entryKind)} ${dataset.character.entryId} no longer exists in universe ${dataset.character.universeId}`,
      { status: 409, code: 'UNIVERSE_CANON_NOT_FOUND' },
    );
  }
  return { universe, subject: { ...subject, entryKind }, entryKind };
}

// Single-dispatcher subscription on mediaJobEvents — same shape as
// universeCharacterSheet's sheetSubscribers so N pending dataset renders
// attach 3 module-level listeners total instead of 3*N.
const datasetSubscribers = new Map(); // jobId → { onStarted, onCompleted, onFailed }
let _listenersAttached = false;
function ensureDispatchListeners() {
  if (_listenersAttached) return;
  _listenersAttached = true;
  mediaJobEvents.on('started', (job) => datasetSubscribers.get(job?.id)?.onStarted?.(job));
  mediaJobEvents.on('completed', (job) => datasetSubscribers.get(job?.id)?.onCompleted?.(job));
  const onTerminal = (job) => datasetSubscribers.get(job?.id)?.onFailed?.(job);
  mediaJobEvents.on('failed', onTerminal);
  mediaJobEvents.on('canceled', onTerminal);
}
function subscribeToDatasetJob(jobId, handlers) {
  ensureDispatchListeners();
  datasetSubscribers.set(jobId, handlers);
  return () => { datasetSubscribers.delete(jobId); };
}

const QUEUE_WAIT_MS = 4 * 60 * 60 * 1000; // survives queueing behind long video jobs
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

const setImageStatus = (datasetId, imageId, status) =>
  updateDataset(datasetId, (current) => ({
    ...current,
    images: current.images.map((img) => (img.id === imageId ? { ...img, status } : img)),
  })).catch((err) => {
    console.error(`❌ Dataset ${datasetId} image ${imageId} status→${status} failed: ${err?.message}`);
  });

async function onRenderComplete({ datasetId, imageId, file, sourceFilename }) {
  if (!sourceFilename) {
    await setImageStatus(datasetId, imageId, 'failed');
    return;
  }
  await ensureDir(datasetImagesDir(datasetId));
  const srcPath = join(PATHS.images, basename(sourceFilename));
  await copyFile(srcPath, datasetImagePath(datasetId, file));
  await setImageStatus(datasetId, imageId, 'ready');
  console.log(`📸 Dataset ${shortId(datasetId)} ← render ${file}`);
}

/**
 * Resolve the render mode + base job params from current settings — the
 * same mode contract as the reference-sheet renderer (codex and local are
 * first-class; external SD-API is rejected with remediation).
 */
async function resolveRenderParams({ modelId: modelOverride = null } = {}) {
  const settings = await getSettings();
  const activeMode = settings.imageGen?.mode || IMAGE_GEN_MODE.LOCAL;
  const base = {
    mode: activeMode,
    width: DATASET_IMAGE_SIZE,
    height: DATASET_IMAGE_SIZE,
    cleanC2PA: true,
    denoise: false,
  };
  const cloud = resolveCloudProviderConfig(settings, activeMode);
  if (cloud) {
    if (!cloud.enabled) throw cloud.disabledError;
    return { base: { ...base, ...cloud.providerParams }, activeMode, modelId: cloud.modelId };
  }
  if (activeMode === IMAGE_GEN_MODE.LOCAL) {
    const allModels = getImageModels();
    const modelId = resolveSheetModelId({ override: modelOverride, settings, allModels });
    if (!modelId) {
      throw new ServerError(
        'No local image-gen models are registered. Install a model via `bash scripts/setup-image-video.sh` before generating dataset images.',
        { status: 400, code: 'LORA_DATASET_NO_MODEL' },
      );
    }
    return {
      base: { ...base, pythonPath: settings.imageGen?.local?.pythonPath || null, modelId },
      activeMode,
      modelId,
    };
  }
  throw new ServerError(
    `Dataset generation needs codex or local image-gen mode (currently: ${activeMode}). Switch in Settings → Image Gen.`,
    { status: 400, code: 'LORA_DATASET_UNSUPPORTED_MODE' },
  );
}

/**
 * Generate `count` reference images for the dataset's subject. Appends a
 * `rendering` image entry per variation, enqueues each render on the image
 * queue, and flips entries to `ready` (with the file copied in) as jobs
 * complete. Returns `{ images: [{ imageId, jobId, variation }], mode, modelId }`
 * immediately — the client tracks per-image progress by refetching.
 */
export async function generateDatasetImages(datasetId, options = {}) {
  const dataset = await getDataset(datasetId);
  const { universe, subject, entryKind } = await loadDatasetSubject(dataset);

  const axes = deriveVariationAxes(subject);
  const variations = buildVariationMatrix({
    count: options.count,
    views: options.views,
    poses: options.poses,
    expressions: options.expressions || axes.expressions,
    outfits: options.outfits || axes.outfits,
  });

  const { base, activeMode, modelId } = await resolveRenderParams(options);

  const launched = [];
  for (const variation of variations) {
    const imageId = uuidv4();
    const file = `${imageId}.png`;
    const { prompt, negativePrompt } = buildDatasetImagePrompt(universe, subject, variation, entryKind);
    const queued = enqueueJob({ kind: 'image', params: { ...base, prompt, negativePrompt } });
    const jobId = queued.jobId;

    const entry = {
      id: imageId,
      file,
      caption: '',
      captionSource: null,
      captionedAt: null,
      source: 'generated',
      sourceJobId: jobId,
      variation,
      status: 'rendering',
      width: DATASET_IMAGE_SIZE,
      height: DATASET_IMAGE_SIZE,
      createdAt: new Date().toISOString(),
    };
    await updateDataset(datasetId, (current) => ({ ...current, images: [...current.images, entry] }));

    let timeoutHandle = null;
    let unsubscribe = null;
    const armTimeout = (ms, reason) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      timeoutHandle = setTimeout(() => {
        console.log(`⏱️ Dataset render ${reason} [${shortId(jobId)}] — detaching (reconcile heals on next read)`);
        detach();
      }, ms);
      timeoutHandle.unref?.();
    };
    const detach = () => {
      if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    };
    unsubscribe = subscribeToDatasetJob(jobId, {
      onStarted: () => armTimeout(RUN_TIMEOUT_MS, 'exceeded run window'),
      onCompleted: async (job) => {
        detach();
        await onRenderComplete({
          datasetId, imageId, file, sourceFilename: job.result?.filename,
        }).catch((err) => {
          console.error(`❌ Dataset render post-completion failed [${shortId(jobId)}]: ${err?.message}`);
        });
      },
      onFailed: async (job) => {
        detach();
        console.log(`⚠️ Dataset render ${job.status} [${shortId(jobId)}]: ${job.error || 'unknown'}`);
        await setImageStatus(datasetId, imageId, 'failed');
      },
    });
    armTimeout(QUEUE_WAIT_MS, 'queue-wait timeout');

    launched.push({ imageId, jobId, variation });
  }

  console.log(`🎨 Dataset ${shortId(datasetId)} generation batch — ${launched.length} render(s), mode=${activeMode}, model=${modelId}`);
  return { images: launched, mode: activeMode, modelId };
}

// Crops smaller than this on either axis are below FLUX's training floor and
// (for vision proposals) usually a label strip or palette swatch the model
// mistook for a panel — reject them. Mirrors the grid path's 64px guard.
const MIN_CROP_PX = 64;

// Ask the vision model to locate each distinct figure on the turnaround sheet
// and return its bounding box. Normalized [0,1] fractions (not pixels) so the
// model doesn't need to reason about the exact resolution — we scale to pixels
// ourselves. The JSON-only instruction + example keeps the reply parseable by
// extractJson, which already tolerates CLI banners and code fences.
export const CROP_PROPOSAL_PROMPT = [
  'This is a character/object reference sheet — a turnaround grid with several',
  'distinct figures (front, side, back views, expression heads, etc.).',
  'Return a tight bounding box around EACH separate figure so it can be cropped',
  'into its own training image. Ignore label text, color-palette swatches, and',
  'empty background. Reply with ONLY a JSON object of the form',
  '{"boxes":[{"x":0.0,"y":0.0,"w":0.33,"h":0.5}, ...]} where x,y is the',
  'top-left corner and w,h the width/height, all as fractions of the image',
  '(0.0–1.0). No prose, no code fence.',
].join(' ');

/**
 * Validate + clamp the vision model's normalized bounding boxes against the
 * sheet's real pixel dimensions, returning sharp-ready
 * `{ left, top, width, height }` extract rects. Pure — exported for tests.
 *
 * Drops a box when it: isn't a finite {x,y,w,h}; falls fully outside the image;
 * or clamps to a region smaller than `MIN_CROP_PX` on either axis (label strips
 * / swatches the model mistook for a figure). Returns `[]` when nothing
 * survives so the caller can fall back to the fixed grid — an empty/garbage
 * vision reply must never produce zero crops silently.
 *
 * @param {unknown} parsed — the parsed `{ boxes: [...] }` (or a bare array)
 * @param {{width:number,height:number}} dims — the sheet's pixel dimensions
 */
export function normalizeCropProposals(parsed, { width, height } = {}) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];
  const boxes = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.boxes) ? parsed.boxes : null);
  if (!Array.isArray(boxes)) return [];

  const rects = [];
  for (const b of boxes) {
    if (!b || typeof b !== 'object') continue;
    const { x, y, w, h } = b;
    if (![x, y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
    // Clamp the normalized rect into [0,1] before scaling, so a box that
    // overhangs the edge (common — the model rounds generously) is trimmed
    // to the sheet rather than throwing in sharp.extract.
    const left = Math.round(Math.max(0, Math.min(1, x)) * width);
    const top = Math.round(Math.max(0, Math.min(1, y)) * height);
    const right = Math.round(Math.max(0, Math.min(1, x + w)) * width);
    const bottom = Math.round(Math.max(0, Math.min(1, y + h)) * height);
    const cw = right - left;
    const ch = bottom - top;
    if (cw < MIN_CROP_PX || ch < MIN_CROP_PX) continue;
    rects.push({ left, top, width: cw, height: ch });
  }
  return rects;
}

/**
 * Propose per-figure crop rectangles for a reference sheet via a vision model.
 * Returns sharp-ready `{ left, top, width, height }` rects, or `[]` on any
 * failure (no vision model, transport error, unparseable reply, all boxes
 * rejected) so `sliceReferenceSheet` falls back to the fixed grid. Never
 * throws — vision slicing is an optional enhancement over the grid.
 *
 * `describeImage` / `resolveModel` / `readImage` are injectable for tests.
 */
export async function proposeCropRegions(sheetPath, dims, {
  providerId = null, model = null, settings = null,
  describeImage = describeImageDataUrlDetailed,
  resolveModel = resolveCaptionModel,
  readImage = readFile,
} = {}) {
  const resolved = await resolveModel({ providerId, model, settings }).catch((err) => {
    console.log(`⚠️ Vision crop slicing skipped — no vision model: ${err?.message || err}`);
    return null;
  });
  if (!resolved) return [];

  const bytes = await readImage(sheetPath).catch(() => null);
  if (!bytes) return [];
  const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;

  // Funnel the vision call through the SAME mutex the caption loop uses, so a
  // slice-while-captioning can't fire two concurrent requests at a single-GPU
  // local backend (doubled KV-cache VRAM, no throughput win — see the lock's
  // header in loraDatasetCaption.js).
  const result = await withCaptionVisionLock(() => describeImage({
    dataUrl,
    prompt: CROP_PROPOSAL_PROMPT,
    providerId: resolved.providerId,
    model: resolved.model,
    // Boxes are short, but a thinking model needs headroom — match the
    // captioner's reasoning budget rather than the 500-token short default.
    maxTokens: 600,
  })).catch((err) => {
    console.log(`⚠️ Vision crop slicing failed (${resolved.model}): ${err?.message || err}`);
    return null;
  });
  if (!result?.text) return [];

  // The model may answer with the documented `{"boxes":[…]}` OR a bare top-level
  // array `[{…}]`. extractJson defaults to walking `{…}` blocks — for a bare
  // array it would return the first inner box OBJECT (its no-predicate-match
  // fallback), which normalizeCropProposals can't use. So accept the object
  // form only when it actually carries a `boxes` array; otherwise walk for a
  // top-level array block. This keeps a valid bare-array reply from silently
  // falling back to the grid.
  const objValue = extractJson(result.text, {
    shapePredicate: (v) => Array.isArray(v?.boxes),
  }).value;
  const value = Array.isArray(objValue?.boxes)
    ? objValue
    : extractJson(result.text, { blockType: 'array' }).value;
  const rects = normalizeCropProposals(value, dims);
  if (rects.length) {
    console.log(`🔎 Vision proposed ${rects.length} crop region(s) via ${resolved.model}`);
  }
  return rects;
}

/**
 * Slice the subject's existing reference-sheet turnaround into individual
 * training crops. With `useVision` (default), a vision-LLM pass proposes a
 * bounding box per figure (turnaround layouts are model-generated and
 * non-deterministic, so a fixed grid mis-cuts them); the fixed `cols × rows`
 * grid is the fallback when no vision model is available or the pass yields
 * nothing usable. Each crop lands as a `ready` dataset image with source
 * 'refsheet-slice' — the user prunes bad crops (label strips, palette
 * swatches) in the grid UI.
 */
export async function sliceReferenceSheet(datasetId, {
  variant = LEGACY_SHEET_VARIANT_ID, cols = 3, rows = 2, useVision = true,
  captionProviderId = null, captionModel = null,
} = {}) {
  const dataset = await getDataset(datasetId);
  const { subject, entryKind } = await loadDatasetSubject(dataset);
  const sheetFilename = readSheetPointer(subject, variant);
  if (!sheetFilename) {
    throw new ServerError(
      `${subjectLabel(entryKind)} "${subject.name || subject.slugline || dataset.character.entryId}" has no ${variant} reference sheet — render one first`,
      { status: 409, code: 'LORA_DATASET_NO_SHEET' },
    );
  }

  const sheetPath = join(PATHS.imageRefs, basename(sheetFilename));
  const image = sharp(sheetPath);
  const meta = await image.metadata().catch((err) => {
    throw new ServerError(`Reference sheet unreadable: ${err?.message || err}`, {
      status: 422, code: 'INVALID_IMAGE',
    });
  });

  // Vision-proposed boxes first; fall back to the fixed grid when the pass
  // returns nothing usable (no model / error / all boxes rejected).
  let rects = [];
  let method = 'grid';
  if (useVision) {
    const settings = await getSettings();
    rects = await proposeCropRegions(sheetPath, { width: meta.width, height: meta.height }, {
      providerId: captionProviderId, model: captionModel, settings,
    });
    if (rects.length) method = 'vision';
  }

  if (!rects.length) {
    const cellW = Math.floor(meta.width / cols);
    const cellH = Math.floor(meta.height / rows);
    if (cellW < MIN_CROP_PX || cellH < MIN_CROP_PX) {
      throw new ServerError(
        `Grid ${cols}×${rows} produces cells smaller than ${MIN_CROP_PX}px on this sheet (${meta.width}×${meta.height})`,
        { status: 400, code: 'VALIDATION_ERROR' },
      );
    }
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        rects.push({ left: c * cellW, top: r * cellH, width: cellW, height: cellH });
      }
    }
  }

  await ensureDir(datasetImagesDir(datasetId));
  const entries = [];
  for (const rect of rects) {
    const imageId = uuidv4();
    const file = `${imageId}.png`;
    await sharp(sheetPath)
      .extract(rect)
      .png()
      .toFile(datasetImagePath(datasetId, file));
    entries.push({
      id: imageId,
      file,
      caption: '',
      captionSource: null,
      captionedAt: null,
      source: 'refsheet-slice',
      sourceJobId: null,
      variation: null,
      status: 'ready',
      width: rect.width,
      height: rect.height,
      createdAt: new Date().toISOString(),
    });
  }
  await updateDataset(datasetId, (current) => ({ ...current, images: [...current.images, ...entries] }));
  console.log(`✂️ Dataset ${shortId(datasetId)} ← ${entries.length} crops from ${basename(sheetFilename)} (${method}${method === 'grid' ? ` ${cols}×${rows}` : ''})`);
  return { images: entries, sheet: basename(sheetFilename), method };
}
