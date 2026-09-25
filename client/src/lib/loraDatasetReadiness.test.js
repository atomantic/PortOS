// @vitest-environment node
import { describe, it, expect } from 'vitest';
import * as clientReadiness from './loraDatasetReadiness.js';
import * as serverReadiness from '../../../server/lib/loraDataset.js';

// Cross-runtime contract (#8297): `LoraDatasetDetail.jsx`'s live training
// advisory (readiness summary, Train gate, shared-caption-fragment warning)
// calls these helpers directly instead of a page-local mirror, so a page
// caption/trigger-word edit can never show "Ready to train" while the
// server's `validateDatasetReady` gate (which calls the same
// `computeDatasetReadiness`/`analyzeCaptionInvariants`) would reject the run.
// Two layers of protection:
//   1. Reference identity — the client module is a straight re-export, so a
//      future edit that quietly swaps it for a duplicated implementation
//      (reintroducing the drift issue #8297 fixed) fails here immediately.
//   2. Behavior on the shared fixture matrix (valid / boundary / non-
//      trainable), so the contract is pinned even if the re-export shape
//      changes later.
const EXPORT_NAMES = [
  'MIN_TRAINING_IMAGES',
  'RECOMMENDED_TRAINING_IMAGES',
  'TRAINING_IMAGE_SWEET_SPOT_MAX',
  'INVARIANT_SHARE_THRESHOLD',
  'MIN_CAPTIONS_FOR_INVARIANT_ANALYSIS',
  'isValidTriggerWord',
  'captionHasTriggerWord',
  'datasetQualityTier',
  'computeDatasetReadiness',
  'analyzeCaptionInvariants',
];

const readyImage = (caption) => ({ status: 'ready', caption });
const renderingImage = () => ({ status: 'rendering', caption: '' });

// 10 ready, captioned images naming the trigger — exactly MIN_TRAINING_IMAGES.
const boundaryImages = Array.from(
  { length: 10 },
  (_, i) => readyImage(`subj_x, pose ${i}, studio lighting`),
);

// Same images as boundaryImages, plus a few more so 4 of the captions repeat
// an identical descriptive fragment ("white hair") — enough signal for
// analyzeCaptionInvariants to flag it as a shared identity fragment.
const invariantImages = [
  readyImage('subj_x, white hair, pose a'),
  readyImage('subj_x, white hair, pose b'),
  readyImage('subj_x, white hair, pose c'),
  readyImage('subj_x, white hair, pose d'),
  readyImage('subj_x, pose e'),
];

describe('loraDatasetReadiness (client re-export of server/lib/loraDataset.js)', () => {
  it('re-exports the exact same functions/constants the server owns — no page-local copy', () => {
    for (const name of EXPORT_NAMES) {
      expect(clientReadiness[name]).toBe(serverReadiness[name]);
    }
  });

  it('agrees with the server on a trainable dataset at the sweet spot (valid)', () => {
    const dataset = {
      triggerWord: 'subj_x',
      images: Array.from({ length: 22 }, (_, i) => readyImage(`subj_x, pose ${i}`)),
    };
    const clientResult = clientReadiness.computeDatasetReadiness(dataset);
    const serverResult = serverReadiness.computeDatasetReadiness(dataset);
    expect(clientResult).toEqual(serverResult);
    expect(clientResult).toMatchObject({ trainable: true, quality: 'good', captioned: 22 });
  });

  it('agrees with the server exactly at the MIN_TRAINING_IMAGES boundary', () => {
    const dataset = { triggerWord: 'subj_x', images: boundaryImages };
    const clientResult = clientReadiness.computeDatasetReadiness(dataset);
    const serverResult = serverReadiness.computeDatasetReadiness(dataset);
    expect(clientResult).toEqual(serverResult);
    expect(clientResult).toMatchObject({
      trainable: true,
      quality: 'minimum',
      captioned: clientReadiness.MIN_TRAINING_IMAGES,
    });
  });

  it('agrees with the server on a non-trainable dataset (missing trigger word)', () => {
    const dataset = { triggerWord: '', images: [...boundaryImages, renderingImage()] };
    const clientResult = clientReadiness.computeDatasetReadiness(dataset);
    const serverResult = serverReadiness.computeDatasetReadiness(dataset);
    expect(clientResult).toEqual(serverResult);
    // No trigger word configured: never trainable, quality never reports
    // 'good'/'minimum' even though 10 images are otherwise ready+captioned.
    expect(clientResult).toMatchObject({ trainable: false, quality: 'insufficient', rendering: 1 });
  });

  it('agrees with the server on caption-invariant fragment detection', () => {
    const clientResult = clientReadiness.analyzeCaptionInvariants(invariantImages, 'subj_x');
    const serverResult = serverReadiness.analyzeCaptionInvariants(invariantImages, 'subj_x');
    expect(clientResult).toEqual(serverResult);
    expect(clientResult.analyzable).toBe(true);
    expect(clientResult.sharedFragments.map((f) => f.normalized)).toContain('white hair');
  });

  it('agrees with the server on trigger-word token-boundary matching', () => {
    // "train" contains "ai" as a substring but not as a bounded token.
    expect(clientReadiness.captionHasTriggerWord('a subject in training gear', 'ai'))
      .toBe(serverReadiness.captionHasTriggerWord('a subject in training gear', 'ai'));
    expect(clientReadiness.captionHasTriggerWord('subj_x, wearing ai badge', 'ai'))
      .toBe(serverReadiness.captionHasTriggerWord('subj_x, wearing ai badge', 'ai'));
  });
});
