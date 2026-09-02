import { describe, expect, it } from 'vitest';
import { CREDENTIALS, CREDENTIAL_IDS, CREDENTIAL_TIERS } from './credentialRegistry.js';
import { INSTANCE_FEATURE_IDS } from './instanceFeatureRegistry.js';

describe('credentialRegistry', () => {
  it('exports unique ids in most-value-first order with a stable huggingface lead', () => {
    expect(CREDENTIAL_IDS[0]).toBe('huggingface');
    expect(new Set(CREDENTIAL_IDS).size).toBe(CREDENTIAL_IDS.length);
  });

  it('requires the documented descriptor fields and a known tier', () => {
    for (const entry of CREDENTIALS) {
      expect(entry.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(entry.label).toBeTruthy();
      expect(entry.unlocks).toBeTruthy();
      expect(CREDENTIAL_TIERS).toContain(entry.tier);
      expect(Array.isArray(entry.envVars)).toBe(true);
      expect(entry.configurePath).toMatch(/^\//);
      if (entry.getUrl != null) expect(entry.getUrl).toMatch(/^https:\/\//);
      if (entry.feature) expect(INSTANCE_FEATURE_IDS).toContain(entry.feature);
    }
  });
});
