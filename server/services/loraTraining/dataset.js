/**
 * Dataset readiness validation for training launch. Re-checked both at
 * route time (fast 409 before a run record exists) and at run start
 * (defense vs. the dataset being deleted/edited while queued).
 */

import { access } from 'fs/promises';
import { ServerError } from '../../lib/errorHandler.js';
import {
  analyzeCaptionInvariants, captionHasTriggerWord, computeDatasetReadiness,
} from '../../lib/loraDataset.js';
import { getDataset, datasetImagePath, datasetImagesDir } from '../loraDatasets.js';

/**
 * Load + validate the dataset, returning `{ dataset, manifest }` where
 * manifest is the trainer-facing image list:
 * `{ triggerWord, imagesDir, images: [{ file, path, caption }] }`.
 *
 * `acknowledgeCaptionLeak` skips the identity-leak gate (below) — set by the
 * resume path (the run already cleared it once) and by an explicit
 * "train anyway" from the UI.
 */
export async function validateDatasetReady(datasetId, { acknowledgeCaptionLeak = false } = {}) {
  const dataset = await getDataset(datasetId);
  const readiness = computeDatasetReadiness(dataset);
  if (!readiness.trainable) {
    throw new ServerError(
      `Dataset is not ready to train — needs ≥${readiness.required} ready images captioned with the trigger word `
      + `(have ${readiness.captioned}/${readiness.required}${readiness.rendering ? `, ${readiness.rendering} still rendering` : ''})`,
      { status: 409, code: 'DATASET_NOT_READY' },
    );
  }
  // Backstop the caption omit-list: if the same identity fragments still repeat
  // across most captions, the look is binding to the phrases instead of the
  // trigger word — the LoRA renders a generic subject. Block (with the offending
  // fragments) rather than train silently, so the user strips them or opts in.
  if (!acknowledgeCaptionLeak) {
    const { total, sharedFragments } = analyzeCaptionInvariants(dataset.images, dataset.triggerWord);
    if (sharedFragments.length) {
      const preview = sharedFragments.slice(0, 6).map((f) => f.fragment).join(', ');
      throw new ServerError(
        `Identity is leaking into the captions — "${preview}"${sharedFragments.length > 6 ? '…' : ''} repeat across most images, `
        + 'so the trigger word would learn a generic subject. Strip the shared identity from the captions, or train anyway to override.',
        { status: 409, code: 'CAPTION_IDENTITY_LEAK', context: { sharedFragments, total } },
      );
    }
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
