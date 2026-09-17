/**
 * The harness identity table exists in two places by architecture — the
 * vendored `aiToolkit/` may not import out of its own directory, so it carries
 * its own copy of the `direct` ↔ `null` translation. This pins the two
 * together, as `providerGateways.parity.test.js` does for gateways, so the
 * toolkit can never spell a direct binding differently from the host.
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
  graphHarnessId as toolkitGraphId,
  normalizeHarnessId as toolkitNormalize,
} from './aiToolkit/internal/harnesses.js';

describe('providerHarnesses ↔ aiToolkit/internal/harnesses parity', () => {
  it('names the direct harness the same, and it is a registry row', () => {
    expect(TOOLKIT_DIRECT).toBe(SERVER_DIRECT);
    expect(PROVIDER_HARNESS_IDS).toContain(TOOLKIT_DIRECT);
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
