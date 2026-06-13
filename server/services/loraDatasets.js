/**
 * LoRA training datasets — collectionStore CRUD + image file management.
 *
 * One dataset per universe character (find-or-create keyed on
 * `(universeId, entryId)`), stored machine-locally at
 * `data/lora-datasets/<id>/index.json` with image bytes at
 * `data/lora-datasets/<id>/images/<imageId>.png`. Datasets never federate
 * — like `data/loras/` itself, they organize artifacts tied to this
 * machine's GPU output (see docs/STORAGE.md).
 *
 * Generation (batch renders via the media-job queue) lives in
 * `loraDatasetGenerate.js`; vision captioning in `loraDatasetCaption.js`;
 * pure helpers in `lib/loraDataset.js`.
 */

import { copyFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import sharp from 'sharp';
import { PATHS, ensureDir } from '../lib/fileUtils.js';
import { assertGalleryFilename } from './imageGen/local.js';
import { createCollectionStore } from '../lib/collectionStore.js';
import {
  LORA_DATASET_SCHEMA_VERSION,
  computeDatasetReadiness,
  deriveTriggerWord,
  isValidTriggerWord,
  prefixCaption,
  sanitizeLoraDataset,
} from '../lib/loraDataset.js';
import { ServerError } from '../lib/errorHandler.js';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { getUniverse } from './universeBuilder.js';
import { getJob } from './mediaJobQueue/index.js';

export const loraDatasetStore = createCollectionStore({
  dir: PATHS.loraDatasets,
  type: 'lora-datasets',
  schemaVersion: LORA_DATASET_SCHEMA_VERSION,
  sanitizeRecord: sanitizeLoraDataset,
});

export const datasetImagesDir = (datasetId) => join(loraDatasetStore.recordDir(datasetId), 'images');
export const datasetImagePath = (datasetId, file) => join(datasetImagesDir(datasetId), file);

const nowIso = () => new Date().toISOString();

const requireDataset = async (id) => {
  const dataset = await loraDatasetStore.loadOne(id);
  if (!dataset) {
    throw new ServerError(`LoRA dataset not found: ${id}`, { status: 404, code: 'NOT_FOUND' });
  }
  return dataset;
};

/**
 * Read-modify-write a dataset inside its per-id write queue so concurrent
 * mutations (caption blur-save + render-completion hook) merge against the
 * freshest persisted record. `mutate` receives the sanitized record and
 * returns the next record (or null to abort without writing).
 */
export async function updateDataset(id, mutate) {
  return loraDatasetStore.queueRecordWrite(id, async () => {
    const current = await loraDatasetStore.loadOne(id);
    if (!current) {
      throw new ServerError(`LoRA dataset not found: ${id}`, { status: 404, code: 'NOT_FOUND' });
    }
    const next = await mutate(current);
    if (!next) return current;
    next.updatedAt = nowIso();
    await loraDatasetStore.saveOneNow(id, next);
    return next;
  });
}

const summarize = (dataset) => ({
  id: dataset.id,
  character: dataset.character,
  triggerWord: dataset.triggerWord,
  status: dataset.status,
  readiness: computeDatasetReadiness(dataset),
  // First few image files for the list page's thumb strip.
  thumbnails: dataset.images
    .filter((img) => img.status === 'ready')
    .slice(0, 4)
    .map((img) => img.file),
  training: dataset.training,
  createdAt: dataset.createdAt,
  updatedAt: dataset.updatedAt,
});

export async function listDatasets({ universeId = null, entryId = null, ingredientId = null } = {}) {
  const all = await loraDatasetStore.loadAll();
  const filtered = all.filter((d) => {
    if (universeId && d.character.universeId !== universeId) return false;
    if (entryId && d.character.entryId !== entryId) return false;
    if (ingredientId && d.character.ingredientId !== ingredientId) return false;
    return true;
  });
  return filtered
    .map(summarize)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function getDataset(id) {
  const dataset = await requireDataset(id);
  return { ...dataset, readiness: computeDatasetReadiness(dataset) };
}

/**
 * Find-or-create the dataset for one universe character. Validates the
 * character exists in the universe and snapshots its identity (entryId +
 * catalog ingredientId + name) into the record. Returns `{ dataset, created }`.
 */
export async function createDataset({ universeId, entryId, triggerWord = null }) {
  const universe = await getUniverse(universeId);
  const characters = Array.isArray(universe.characters) ? universe.characters : [];
  const character = characters.find((c) => c.id === entryId);
  if (!character) {
    throw new ServerError(`Character ${entryId} not found in universe`, {
      status: 404, code: 'UNIVERSE_CANON_NOT_FOUND',
    });
  }

  const existingAll = await loraDatasetStore.loadAll();
  const existing = existingAll.find(
    (d) => d.character.universeId === universeId && d.character.entryId === entryId,
  );
  if (existing) return { dataset: { ...existing, readiness: computeDatasetReadiness(existing) }, created: false };

  if (triggerWord != null && !isValidTriggerWord(triggerWord)) {
    throw new ServerError('Trigger word must be 2-64 chars of [a-z0-9_]', {
      status: 400, code: 'VALIDATION_ERROR',
    });
  }
  const taken = existingAll.map((d) => d.triggerWord).filter(Boolean);
  const resolvedTrigger = triggerWord || deriveTriggerWord(character.name, { taken });

  const id = uuidv4();
  const record = sanitizeLoraDataset({
    schemaVersion: LORA_DATASET_SCHEMA_VERSION,
    id,
    character: {
      entryId,
      ingredientId: character.ingredientId || null,
      universeId,
      name: character.name,
    },
    triggerWord: resolvedTrigger,
    status: 'draft',
    images: [],
    training: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  await loraDatasetStore.saveOne(id, record);
  await ensureDir(datasetImagesDir(id));
  console.log(`🧬 Created LoRA dataset ${id} for character "${character.name}" (trigger=${resolvedTrigger})`);
  return { dataset: { ...record, readiness: computeDatasetReadiness(record) }, created: true };
}

export async function patchDataset(id, { triggerWord } = {}) {
  if (triggerWord !== undefined && !isValidTriggerWord(triggerWord)) {
    throw new ServerError('Trigger word must be 2-64 chars of [a-z0-9_]', {
      status: 400, code: 'VALIDATION_ERROR',
    });
  }
  return updateDataset(id, (current) => {
    if (triggerWord === undefined || triggerWord === current.triggerWord) return null;
    // Re-prefix every captioned image so the binding token follows the
    // rename. Without this, computeDatasetReadiness (which gates `captioned`
    // on the caption containing the trigger word) silently drops every
    // previously-captioned image and any training binds the stale token.
    // Empty captions are left untouched — don't fabricate a caption.
    const prev = current.triggerWord;
    const images = current.images.map((img) => (img.caption
      ? { ...img, caption: prefixCaption(triggerWord, img.caption, { previousTriggerWord: prev }) }
      : img));
    return { ...current, triggerWord, images };
  });
}

export async function deleteDataset(id) {
  await requireDataset(id);
  // deleteOne removes the whole `lora-datasets/<id>/` subtree — record AND
  // the images/ sidecar dir go together.
  await loraDatasetStore.deleteOne(id);
  console.log(`🗑️ Deleted LoRA dataset ${id}`);
  return { ok: true, id };
}

/** Canonical dataset-image entry. One source of truth for the shape so every
 *  image source (upload / gallery import / generation) stamps identical fields. */
const makeImageEntry = ({ imageId, file, source, info, sourceJobId = null }) => ({
  id: imageId,
  file,
  caption: '',
  captionSource: null,
  captionedAt: null,
  source,
  sourceJobId,
  variation: null,
  status: 'ready',
  width: info?.width || null,
  height: info?.height || null,
  createdAt: nowIso(),
});

/**
 * Normalize an uploaded image to PNG inside the dataset's images dir and
 * append its entry. `tmpPath` is the multipart parser's staged temp file —
 * always unlinked, success or failure. The route's mimetype `fileFilter` is
 * only an early reject of obvious non-images (the declared MIME is
 * client-controlled) — `sharp` below is the real gate: it transcodes any
 * format it can decode and 422s anything it can't, so a wrong-extension
 * upload is normalized rather than trusted by its claimed type.
 */
export async function addUploadedImage(id, { tmpPath, originalname = '' }) {
  await requireDataset(id);
  const imageId = uuidv4();
  const file = `${imageId}.png`;
  await ensureDir(datasetImagesDir(id));
  const destPath = datasetImagePath(id, file);
  const cleanup = () => unlink(tmpPath).catch(() => {});
  const info = await sharp(tmpPath).rotate().png().toFile(destPath).catch(async (err) => {
    await cleanup();
    throw new ServerError(
      `"${originalname || 'upload'}" is not a decodable image: ${err?.message || err}`,
      { status: 422, code: 'INVALID_IMAGE' },
    );
  });
  await cleanup();

  const entry = makeImageEntry({ imageId, file, source: 'upload', info });
  await updateDataset(id, (current) => ({ ...current, images: [...current.images, entry] }));
  console.log(`📥 Dataset ${id} ← upload ${file} (${entry.width}×${entry.height})`);
  return entry;
}

/**
 * Import existing gallery images (by basename, e.g. `<jobId>.png`) into a
 * dataset. Each is normalized through sharp into the dataset's images dir —
 * same gate as a fresh upload — so a gallery PNG with odd metadata can't smuggle
 * anything in, and the dataset owns an independent copy (deleting the gallery
 * image later won't strand the dataset). Each call appends a fresh copy (no
 * dedup — same as uploading the same file twice). Returns the appended entries.
 */
export async function importGalleryImages(id, { filenames = [] } = {}) {
  await requireDataset(id);
  if (!Array.isArray(filenames) || !filenames.length) {
    throw new ServerError('No gallery filenames provided', { status: 400, code: 'VALIDATION_ERROR' });
  }
  await ensureDir(datasetImagesDir(id));
  // sharp transcodes are independent CPU/disk work — run them concurrently
  // (single-user trust model; the per-id write queue still serializes the one
  // dataset mutation below). Use allSettled, NOT all: a rejection from all()
  // returns before sibling toFile() calls finish, so files written *after* the
  // first failure would escape cleanup and orphan. allSettled waits for every
  // transcode to land before we either commit them all or unlink them all.
  const written = [];
  const results = await Promise.allSettled(filenames.map(async (filename) => {
    // Reuse the gallery's own path-traversal/extension guard.
    assertGalleryFilename(filename);
    const sourcePath = join(PATHS.images, basename(filename));
    if (!existsSync(sourcePath)) {
      throw new ServerError(`Gallery image not found: ${filename}`, { status: 404, code: 'NOT_FOUND' });
    }
    const imageId = uuidv4();
    const file = `${imageId}.png`;
    const destPath = datasetImagePath(id, file);
    const info = await sharp(sourcePath).rotate().png().toFile(destPath)
      .then((i) => { written.push(destPath); return i; })
      .catch((err) => {
        throw new ServerError(
          `"${filename}" is not a decodable image: ${err?.message || err}`,
          { status: 422, code: 'INVALID_IMAGE' },
        );
      });
    return makeImageEntry({ imageId, file, source: 'gallery', info });
  }));
  const failure = results.find((r) => r.status === 'rejected');
  if (failure) {
    // All transcodes have settled now, so `written` is complete — no late write
    // can re-orphan a file after this cleanup.
    await Promise.all(written.map((p) => unlink(p).catch(() => {})));
    throw failure.reason;
  }
  const entries = results.map((r) => r.value);
  await updateDataset(id, (current) => ({ ...current, images: [...current.images, ...entries] }));
  console.log(`🖼️ Dataset ${id} ← imported ${entries.length} gallery image(s)`);
  return entries;
}

export async function updateImageCaption(id, imageId, caption) {
  const next = await updateDataset(id, (current) => {
    if (!current.images.some((img) => img.id === imageId)) {
      throw new ServerError(`Image ${imageId} not found in dataset`, { status: 404, code: 'NOT_FOUND' });
    }
    return {
      ...current,
      images: current.images.map((img) => (img.id === imageId
        ? { ...img, caption, captionSource: 'manual', captionedAt: nowIso() }
        : img)),
    };
  });
  return next.images.find((img) => img.id === imageId);
}

export async function deleteImage(id, imageId) {
  let removed = null;
  await updateDataset(id, (current) => {
    removed = current.images.find((img) => img.id === imageId) || null;
    if (!removed) {
      throw new ServerError(`Image ${imageId} not found in dataset`, { status: 404, code: 'NOT_FOUND' });
    }
    return { ...current, images: current.images.filter((img) => img.id !== imageId) };
  });
  await unlink(datasetImagePath(id, removed.file)).catch(() => {});
  return { ok: true, imageId };
}

/**
 * Read-time healer for images stuck in `rendering`. The generation hook
 * normally flips them on the media-job 'completed' event, but a server
 * restart drops that in-memory subscription (the queue marks interrupted
 * jobs failed on boot). For each rendering image, consult the job archive:
 * completed → copy the result into the dataset + mark ready; failed /
 * canceled / unknown → mark failed. Returns the (possibly updated) record.
 *
 * `jobLookup` is injectable for tests; defaults to the queue's getJob.
 */
export async function reconcileRenderingImages(id, { jobLookup = getJob } = {}) {
  const dataset = await requireDataset(id);
  const pending = dataset.images.filter((img) => img.status === 'rendering');
  if (!pending.length) return dataset;

  const resolutions = new Map(); // imageId → { status, sourceFilename? , dims? }
  for (const img of pending) {
    const job = img.sourceJobId ? jobLookup(img.sourceJobId) : null;
    if (!job || job.status === 'failed' || job.status === 'canceled') {
      resolutions.set(img.id, { status: 'failed' });
    } else if (job.status === 'completed' && job.result?.filename) {
      resolutions.set(img.id, { status: 'ready', sourceFilename: job.result.filename });
    }
    // queued/running jobs stay 'rendering' — the live hook will land them.
  }
  if (!resolutions.size) return dataset;

  for (const [imageId, res] of resolutions) {
    if (res.status !== 'ready') continue;
    const img = pending.find((p) => p.id === imageId);
    await ensureDir(datasetImagesDir(id));
    // basename() so a hand-edited media-jobs.json filename can't traverse
    // out of the gallery (mirrors onRenderComplete in loraDatasetGenerate).
    await copyFile(join(PATHS.images, basename(res.sourceFilename)), datasetImagePath(id, img.file))
      .catch((err) => {
        console.error(`❌ Dataset ${id} reconcile copy failed [${imageId}]: ${err?.message}`);
        resolutions.set(imageId, { status: 'failed' });
      });
  }

  const updated = await updateDataset(id, (current) => ({
    ...current,
    images: current.images.map((img) => {
      const res = resolutions.get(img.id);
      return res ? { ...img, status: res.status } : img;
    }),
  }));
  const resolved = [...resolutions.values()];
  const readyCount = resolved.filter((r) => r.status === 'ready').length;
  console.log(`🩹 Dataset ${id} reconciled ${resolved.length} rendering image(s) → ${readyCount} ready, ${resolved.length - readyCount} failed`);
  return updated;
}
