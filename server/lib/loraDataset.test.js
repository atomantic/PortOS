import { describe, it, expect } from 'vitest';
import {
  buildVariationMatrix,
  captionHasTriggerWord,
  computeDatasetReadiness,
  datasetQualityTier,
  deriveTriggerWord,
  isValidTriggerWord,
  MIN_TRAINING_IMAGES,
  RECOMMENDED_TRAINING_IMAGES,
  prefixCaption,
  sanitizeDatasetImage,
  sanitizeLoraDataset,
  LORA_DATASET_SCHEMA_VERSION,
} from './loraDataset.js';

const baseRecord = () => ({
  id: 'ds-1',
  character: { entryId: 'char-1', ingredientId: 'ing-1', universeId: 'uni-1', name: 'Kessa' },
  triggerWord: 'kessa_brightwater',
  status: 'draft',
  images: [],
  training: {},
});

describe('sanitizeLoraDataset', () => {
  it('stamps schemaVersion and normalizes shape', () => {
    const out = sanitizeLoraDataset(baseRecord());
    expect(out.schemaVersion).toBe(LORA_DATASET_SCHEMA_VERSION);
    expect(out.character).toEqual({
      entryId: 'char-1', ingredientId: 'ing-1', universeId: 'uni-1', name: 'Kessa',
    });
    expect(out.training).toEqual({
      lastJobId: null, lastRunId: null, loraFilename: null, completedAt: null,
    });
  });

  it('rejects records missing identity', () => {
    expect(sanitizeLoraDataset(null)).toBeNull();
    expect(sanitizeLoraDataset({ id: 'x' })).toBeNull();
    expect(sanitizeLoraDataset({ ...baseRecord(), character: { entryId: '', universeId: 'u' } })).toBeNull();
  });

  it('drops invalid trigger words and unknown statuses', () => {
    const out = sanitizeLoraDataset({ ...baseRecord(), triggerWord: 'Has Spaces!', status: 'bogus' });
    expect(out.triggerWord).toBe('');
    expect(out.status).toBe('draft');
  });

  it('filters unrecoverable image entries and clamps captions', () => {
    const out = sanitizeLoraDataset({
      ...baseRecord(),
      images: [
        { id: 'img-1', file: 'img-1.png', caption: 'x'.repeat(3000), source: 'nope', status: 'weird' },
        { id: '', file: 'orphan.png' },
        'not-an-object',
      ],
    });
    expect(out.images).toHaveLength(1);
    expect(out.images[0].caption).toHaveLength(2000);
    expect(out.images[0].source).toBe('upload');
    expect(out.images[0].status).toBe('ready');
  });
});

describe('sanitizeDatasetImage', () => {
  it('normalizes variation and numeric dimensions', () => {
    const out = sanitizeDatasetImage({
      id: 'img-1', file: 'img-1.png',
      variation: { view: ' front view ', pose: '', expression: 'amused' },
      width: 1024, height: -5,
    });
    expect(out.variation).toEqual({ view: 'front view', pose: null, expression: 'amused', outfit: null });
    expect(out.width).toBe(1024);
    expect(out.height).toBeNull();
  });
});

describe('deriveTriggerWord', () => {
  it('slugs names to single lowercase tokens', () => {
    expect(deriveTriggerWord('Kessa Brightwater')).toBe('kessa_brightwater');
    expect(deriveTriggerWord("D'Artagnan-El Niño")).toBe('d_artagnan_el_nino');
  });

  it('suffixes on collision', () => {
    expect(deriveTriggerWord('Kessa', { taken: ['kessa'] })).toBe('kessa2');
    expect(deriveTriggerWord('Kessa', { taken: ['kessa', 'kessa2'] })).toBe('kessa3');
  });

  it('falls back for empty / too-short names', () => {
    expect(deriveTriggerWord('')).toBe('character');
    expect(isValidTriggerWord(deriveTriggerWord('武'))).toBe(true);
  });
});

describe('prefixCaption', () => {
  it('prefixes once and is idempotent', () => {
    const once = prefixCaption('kessa', 'a woman with copper hair');
    expect(once).toBe('kessa, a woman with copper hair');
    expect(prefixCaption('kessa', once)).toBe(once);
  });

  it('re-prefixes when the trigger word changed', () => {
    const out = prefixCaption('kessa_v2', 'kessa, a woman with copper hair', { previousTriggerWord: 'kessa' });
    expect(out).toBe('kessa_v2, a woman with copper hair');
  });

  it('does not amputate a body word that the trigger is a substring-prefix of', () => {
    // `her` prefixes `heroic`; without a token boundary the strip would
    // mangle this to `her, oic stance`.
    expect(prefixCaption('her', 'heroic stance')).toBe('her, heroic stance');
    expect(prefixCaption('her', 'her, heroic stance')).toBe('her, heroic stance');
    // Re-prefix path: renaming away from a substring-prefix trigger keeps the body.
    expect(prefixCaption('hero_v2', 'heroic stance', { previousTriggerWord: 'her' }))
      .toBe('hero_v2, heroic stance');
  });

  it('returns just the trigger word for empty text', () => {
    expect(prefixCaption('kessa', '')).toBe('kessa');
    expect(prefixCaption('kessa', '   ')).toBe('kessa');
  });

  it('passes text through when no trigger word', () => {
    expect(prefixCaption('', 'plain caption')).toBe('plain caption');
  });
});

describe('buildVariationMatrix', () => {
  it('returns exactly count deterministic tuples', () => {
    const a = buildVariationMatrix({ count: 12 });
    const b = buildVariationMatrix({ count: 12 });
    expect(a).toHaveLength(12);
    expect(a).toEqual(b);
    for (const t of a) {
      expect(t.view).toBeTruthy();
      expect(t.pose).toBeTruthy();
      expect(t.expression).toBeTruthy();
      expect(t.outfit).toBeTruthy();
    }
  });

  it('spans all views before repeating', () => {
    const tuples = buildVariationMatrix({ count: 4 });
    expect(new Set(tuples.map((t) => t.view)).size).toBe(4);
  });

  it('uses caller-supplied axes and blank-filters them', () => {
    const tuples = buildVariationMatrix({
      count: 4,
      expressions: [' smug ', ''],
      outfits: ['armor', 'gala dress'],
    });
    expect(tuples.every((t) => t.expression === 'smug')).toBe(true);
    expect(new Set(tuples.map((t) => t.outfit))).toEqual(new Set(['armor', 'gala dress']));
  });

  it('block-assigns outfits contiguously', () => {
    const tuples = buildVariationMatrix({ count: 8, outfits: ['a', 'b'] });
    expect(tuples.slice(0, 4).every((t) => t.outfit === 'a')).toBe(true);
    expect(tuples.slice(4).every((t) => t.outfit === 'b')).toBe(true);
  });

  it('clamps count to [1, 40]', () => {
    expect(buildVariationMatrix({ count: 0 })).toHaveLength(1);
    expect(buildVariationMatrix({ count: 999 })).toHaveLength(40);
    expect(buildVariationMatrix({ count: 1.5 })).toHaveLength(12);
  });
});

describe('computeDatasetReadiness', () => {
  const img = (overrides = {}) => ({
    id: 'i', file: 'i.png', status: 'ready', caption: 'kessa, portrait', ...overrides,
  });

  it('counts ready vs captioned vs rendering', () => {
    const out = computeDatasetReadiness({
      triggerWord: 'kessa',
      images: [
        img(),
        img({ caption: 'no trigger here' }),
        img({ status: 'rendering', caption: '' }),
        img({ status: 'failed' }),
      ],
    });
    expect(out).toMatchObject({ total: 4, ready: 2, captioned: 1, rendering: 1 });
    expect(out.trainable).toBe(false);
  });

  it('flips trainable at MIN_TRAINING_IMAGES captioned images', () => {
    const images = Array.from({ length: MIN_TRAINING_IMAGES }, (_, i) => img({ id: `i${i}` }));
    expect(computeDatasetReadiness({ triggerWord: 'kessa', images }).trainable).toBe(true);
    expect(computeDatasetReadiness({ triggerWord: '', images }).trainable).toBe(false);
  });

  it('reports the recommended target and an advisory quality tier', () => {
    const mk = (n) => computeDatasetReadiness({
      triggerWord: 'kessa',
      images: Array.from({ length: n }, (_, i) => img({ id: `i${i}` })),
    });
    expect(mk(MIN_TRAINING_IMAGES - 1)).toMatchObject({ quality: 'insufficient', trainable: false });
    // Trainable but below the recommended target → 'minimum' (still trainable).
    expect(mk(MIN_TRAINING_IMAGES)).toMatchObject({
      quality: 'minimum', trainable: true, recommended: RECOMMENDED_TRAINING_IMAGES,
    });
    expect(mk(RECOMMENDED_TRAINING_IMAGES)).toMatchObject({ quality: 'good', trainable: true });
  });

  it('reports insufficient quality when there is no trigger word, even with plenty of images', () => {
    // Without a trigger word captionHasTriggerWord counts every caption, so
    // captioned can clear the recommended target while the dataset is NOT
    // trainable. quality must stay 'insufficient' so the UI never turns green
    // "Ready to train" while the train gate rejects the run.
    const images = Array.from({ length: RECOMMENDED_TRAINING_IMAGES + 5 }, (_, i) => img({ id: `i${i}` }));
    const out = computeDatasetReadiness({ triggerWord: '', images });
    expect(out.captioned).toBeGreaterThanOrEqual(RECOMMENDED_TRAINING_IMAGES);
    expect(out).toMatchObject({ trainable: false, quality: 'insufficient' });
  });

  it('datasetQualityTier brackets on the min and recommended thresholds', () => {
    expect(datasetQualityTier(0)).toBe('insufficient');
    expect(datasetQualityTier(MIN_TRAINING_IMAGES - 1)).toBe('insufficient');
    expect(datasetQualityTier(MIN_TRAINING_IMAGES)).toBe('minimum');
    expect(datasetQualityTier(RECOMMENDED_TRAINING_IMAGES - 1)).toBe('minimum');
    expect(datasetQualityTier(RECOMMENDED_TRAINING_IMAGES)).toBe('good');
    expect(datasetQualityTier(RECOMMENDED_TRAINING_IMAGES + 50)).toBe('good');
  });

  it('matches trigger word case-insensitively', () => {
    const out = computeDatasetReadiness({
      triggerWord: 'kessa',
      images: [img({ caption: 'KESSA, shouting' })],
    });
    expect(out.captioned).toBe(1);
  });

  it('counts the trigger as a whole token, not a substring', () => {
    // A short trigger (`ai`) must NOT count captions where it only appears
    // inside other words (`captain`, `train`) — those don't bind the token.
    const out = computeDatasetReadiness({
      triggerWord: 'ai',
      images: [
        img({ id: 'a', caption: 'a captain on a train' }), // substring only → not counted
        img({ id: 'b', caption: 'ai, a portrait' }), // real token → counted
      ],
    });
    expect(out.captioned).toBe(1);
  });
});

describe('captionHasTriggerWord', () => {
  it('matches whole tokens, edges, and underscores; rejects substrings', () => {
    expect(captionHasTriggerWord('ai, portrait', 'ai')).toBe(true);
    expect(captionHasTriggerWord('a captain', 'ai')).toBe(false);
    expect(captionHasTriggerWord('the train station', 'ai')).toBe(false);
    expect(captionHasTriggerWord('kessa_v2 stands tall', 'kessa_v2')).toBe(true);
    expect(captionHasTriggerWord('ends with token: ai', 'ai')).toBe(true);
    expect(captionHasTriggerWord('', 'ai')).toBe(false);
    // No trigger configured → any non-empty caption counts.
    expect(captionHasTriggerWord('anything', '')).toBe(true);
  });
});
