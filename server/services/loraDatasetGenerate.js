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

import { copyFile } from 'fs/promises';
import { join, basename } from 'path';
import sharp from 'sharp';
import { PATHS, ensureDir, shortId } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { buildVariationMatrix } from '../lib/loraDataset.js';
import { readSheetPointer, LEGACY_SHEET_VARIANT_ID } from '../lib/storyBible.js';
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

// Load the dataset's live canon subject (generation + slicing both need
// the current canon, not the dataset's snapshot). 409 when the subject
// was deleted from the universe after the dataset was created.
async function loadDatasetSubject(dataset) {
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
  if (activeMode === IMAGE_GEN_MODE.CODEX) {
    const c = settings.imageGen?.codex || {};
    if (!c.enabled) {
      throw new ServerError(
        'Codex Imagegen is disabled — enable it in Settings → Image Gen first',
        { status: 400, code: 'CODEX_IMAGEGEN_DISABLED' },
      );
    }
    return { base: { ...base, codexPath: c.codexPath, model: c.model }, activeMode, modelId: c.model || 'codex' };
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

/**
 * Slice the subject's existing reference-sheet turnaround into a fixed
 * `cols × rows` grid of training crops. Each crop lands as a `ready`
 * dataset image with source 'refsheet-slice' — the user prunes bad crops
 * (label strips, palette swatches) in the grid UI.
 */
export async function sliceReferenceSheet(datasetId, { variant = LEGACY_SHEET_VARIANT_ID, cols = 3, rows = 2 } = {}) {
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
  const cellW = Math.floor(meta.width / cols);
  const cellH = Math.floor(meta.height / rows);
  if (cellW < 64 || cellH < 64) {
    throw new ServerError(
      `Grid ${cols}×${rows} produces cells smaller than 64px on this sheet (${meta.width}×${meta.height})`,
      { status: 400, code: 'VALIDATION_ERROR' },
    );
  }

  await ensureDir(datasetImagesDir(datasetId));
  const entries = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const imageId = uuidv4();
      const file = `${imageId}.png`;
      await sharp(sheetPath)
        .extract({ left: c * cellW, top: r * cellH, width: cellW, height: cellH })
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
        width: cellW,
        height: cellH,
        createdAt: new Date().toISOString(),
      });
    }
  }
  await updateDataset(datasetId, (current) => ({ ...current, images: [...current.images, ...entries] }));
  console.log(`✂️ Dataset ${shortId(datasetId)} ← ${entries.length} crops from ${basename(sheetFilename)} (${cols}×${rows})`);
  return { images: entries, sheet: basename(sheetFilename) };
}
