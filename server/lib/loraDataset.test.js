import { describe, it, expect } from 'vitest';
import {
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
      entryId: 'char-1', entryKind: 'characters', ingredientId: 'ing-1', universeId: 'uni-1', name: 'Kessa',
    });
    expect(out.training).toEqual({
      lastJobId: null, lastRunId: null, loraFilename: null, completedAt: null,
    });
  });

  it('preserves object/place subject kind on the compatibility character snapshot', () => {
    const out = sanitizeLoraDataset({
      ...baseRecord(),
      character: { entryId: 'obj-1', entryKind: 'objects', universeId: 'uni-1', name: 'Truthbreaker' },
    });
    expect(out.character).toMatchObject({ entryId: 'obj-1', entryKind: 'objects', name: 'Truthbreaker' });
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
