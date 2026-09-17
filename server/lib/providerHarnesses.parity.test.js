/**
 * The harness identity table exists in two places by architecture — the
 * vendored `aiToolkit/` may not import out of its own directory, so it carries
 * its own copy of the ids and the `direct` ↔ `null` translation. This pins the
 * two together, as `providerGateways.parity.test.js` does for gateways, so a
 * harness added to the registry can never be one the toolkit refuses to
 * resolve a composite id for.
 */
import { describe, expect, it } from 'vitest';
import {
  DIRECT_HARNESS_ID as SERVER_DIRECT,
  PROVIDER_HARNESS_IDS,
  graphHarnessId as serverGraphId,
  normalizeHarnessId as serverNormalize,
} from './providerHarnesses.js';
import {
  DIRECT_HARNESS_ID as TOOLKIT_DIRECT,
  HARNESS_IDS,
  graphHarnessId as toolkitGraphId,
  isHarnessId,
  normalizeHarnessId as toolkitNormalize,
} from './aiToolkit/internal/harnesses.js';

describe('providerHarnesses ↔ aiToolkit/internal/harnesses parity', () => {
  it('declares the same ids, in the same order', () => {
    expect(HARNESS_IDS).toEqual(PROVIDER_HARNESS_IDS);
    expect(TOOLKIT_DIRECT).toBe(SERVER_DIRECT);
    for (const id of PROVIDER_HARNESS_IDS) expect(isHarnessId(id)).toBe(true);
  });

  it('translates the direct binding the same way in both directions', () => {
    for (const id of [null, undefined, 'direct', 'claude', 'pi']) {
      expect(toolkitNormalize(id)).toBe(serverNormalize(id));
      expect(toolkitGraphId(id)).toBe(serverGraphId(id));
    }
    expect(serverNormalize(null)).toBe('direct');
    expect(serverGraphId('direct')).toBeNull();
    expect(serverGraphId(serverNormalize(null))).toBeNull();
  });
});
