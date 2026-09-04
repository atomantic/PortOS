// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  filterHardwareCompatibleModels,
  isHardwareAvailable,
  isHardwareCompatible,
} from './systemCapabilities.js';
import {
  filterHardwareCompatibleProviderModels,
  isProviderHardwareCompatible,
  isProviderModelHardwareCompatible,
} from './providers.js';

describe('system capability selection helpers', () => {
  it('fails open for old servers and unknown probes', () => {
    expect(isHardwareCompatible()).toBe(true);
    expect(isHardwareCompatible({ state: 'unknown' })).toBe(true);
    expect(isHardwareAvailable({})).toBe(true);
    expect(filterHardwareCompatibleModels([
      { id: 'old-server-model' },
      { id: 'probe-unknown', hardwareCompatibility: { state: 'unknown' } },
      { id: 'too-large', hardwareCompatibility: { state: 'unavailable' } },
    ])).toEqual([
      { id: 'old-server-model' },
      { id: 'probe-unknown', hardwareCompatibility: { state: 'unknown' } },
    ]);
  });

  it('can include unavailable entries when an editor needs to explain them', () => {
    const unavailable = { id: 'too-large', hardwareCompatibility: { state: 'unavailable' } };
    expect(filterHardwareCompatibleModels([unavailable], { includeUnavailable: true })).toEqual([unavailable]);
  });

  it('filters provider models only when the provider or model is definitively unavailable', () => {
    const provider = {
      hardwareCompatibility: { state: 'available' },
      modelHardwareCompatibility: {
        small: { state: 'available' },
        large: { state: 'unavailable' },
        uncertain: { state: 'unknown' },
      },
    };
    expect(isProviderHardwareCompatible(provider)).toBe(true);
    expect(isProviderModelHardwareCompatible(provider, 'large')).toBe(false);
    expect(filterHardwareCompatibleProviderModels(['small', 'large', 'uncertain'], provider)).toEqual(['small', 'uncertain']);
    expect(isProviderHardwareCompatible({ hardwareCompatibility: { state: 'unavailable' } })).toBe(false);
  });
});
