import { describe, it, expect } from 'vitest';
import * as catalog from './modelCatalog.js';
import * as local from './local.js';

describe('video model catalog leaf', () => {
  it('is the same surface the local facade re-exports', () => {
    expect(local.listVideoModels).toBe(catalog.listVideoModels);
    expect(local.resolveVideoModel).toBe(catalog.resolveVideoModel);
    expect(local.defaultVideoModelId).toBe(catalog.defaultVideoModelId);
  });

  it('no longer exposes the import-time VIDEO_MODELS snapshot', () => {
    expect('VIDEO_MODELS' in local).toBe(false);
  });

  it('decorates every listed model with runtime capabilities and resolves by id from the live registry', () => {
    const models = catalog.listVideoModels();
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) expect(m).toHaveProperty('supportsWarmBatch');
    expect(catalog.resolveVideoModel(models[0].id)?.id).toBe(models[0].id);
    expect(catalog.resolveVideoModel('no-such-model')).toBeNull();
  });
});
