import { describe, expect, it } from 'vitest';
import { IMAGE_RUNTIME, imageRuntimeFor, isSelfManagedLocalImageModelId } from './imageRuntimeRemedies.js';
import { DEFAULT_REGISTRY } from './mediaModels/catalogDefaults.js';

describe('isSelfManagedLocalImageModelId', () => {
  it.each(DEFAULT_REGISTRY.image)('matches the shipped runtime for $id', (model) => {
    expect(isSelfManagedLocalImageModelId(model.id))
      .toBe(imageRuntimeFor(model) !== IMAGE_RUNTIME.MFLUX_PYTHON);
  });
});
