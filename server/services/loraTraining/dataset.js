/**
 * Dataset readiness validation for training launch. Re-checked both at
 * route time (fast 409 before a run record exists) and at run start
 * (defense vs. the dataset being deleted/edited while queued).
 */

import { access } from 'fs/promises';
import { ServerError } from '../../lib/errorHandler.js';
import { captionHasTriggerWord, computeDatasetReadiness } from '../../lib/loraDataset.js';
import { getDataset, datasetImagePath, datasetImagesDir } from '../loraDatasets.js';

/**
 * Load + validate the dataset, returning `{ dataset, manifest }` where
 * manifest is the trainer-facing image list:
 * `{ triggerWord, imagesDir, images: [{ file, path, caption }] }`.
 */
export async function validateDatasetReady(datasetId) {
  const dataset = await getDataset(datasetId);
  const readiness = computeDatasetReadiness(dataset);
  if (!readiness.trainable) {
    throw new ServerError(
      `Dataset is not ready to train — needs ≥${readiness.required} ready images captioned with the trigger word `
      + `(have ${readiness.captioned}/${readiness.required}${readiness.rendering ? `, ${readiness.rendering} still rendering` : ''})`,
      { status: 409, code: 'DATASET_NOT_READY' },
    );
  }
  // Same token-boundary predicate as the readiness gate — share the helper so
  // the manifest can never include a caption the gate counted differently.
  const trainImages = dataset.images.filter(
    (img) => img.status === 'ready' && captionHasTriggerWord(img.caption, dataset.triggerWord),
  );
  // Every file must actually exist on disk — a missing file at trainer
  // start would fail minutes later with an opaque python traceback.
  for (const img of trainImages) {
    const path = datasetImagePath(datasetId, img.file);
    await access(path).catch(() => {
      throw new ServerError(
        `Dataset image missing on disk: ${img.file} — delete it from the dataset and retry`,
        { status: 409, code: 'DATASET_NOT_READY' },
      );
    });
  }
  return {
    dataset,
    manifest: {
      triggerWord: dataset.triggerWord,
      imagesDir: datasetImagesDir(datasetId),
      images: trainImages.map((img) => ({
        file: img.file,
        path: datasetImagePath(datasetId, img.file),
        caption: img.caption.trim(),
      })),
    },
  };
}
