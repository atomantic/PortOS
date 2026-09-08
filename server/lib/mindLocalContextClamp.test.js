import { describe, expect, it } from 'vitest';
import {
  MIND_LOCAL_CONTEXT_ABSOLUTE_MIN,
  clampMindLocalContextRequest,
  cpuOnlyContextCeiling,
  freeMemoryContextCeiling,
  resolveMindLocalContextClamp,
} from './mindLocalContextClamp.js';

describe('mindLocalContextClamp', () => {
  it('tiers CPU-only ceilings by installed RAM', () => {
    expect(cpuOnlyContextCeiling(8)).toBe(2048);
    expect(cpuOnlyContextCeiling(15)).toBe(4096);
    expect(cpuOnlyContextCeiling(20)).toBe(8192);
    expect(cpuOnlyContextCeiling(30)).toBe(16384);
  });

  it('reserves PortOS headroom when free RAM is tight', () => {
    expect(freeMemoryContextCeiling({ freeMemoryGb: 6, modelSizeGb: 5 })).toBe(MIND_LOCAL_CONTEXT_ABSOLUTE_MIN);
    expect(freeMemoryContextCeiling({ freeMemoryGb: 20, modelSizeGb: 5 })).toBeGreaterThan(8192);
  });

  it('refuses requests above the safe host ceiling', () => {
    const clamp = resolveMindLocalContextClamp({
      totalMemoryGb: 15,
      freeMemoryGb: 8,
      hasUsableGpu: false,
      modelSizeGb: 5,
    });
    // 15 GB CPU-only tier → 4096; free RAM after headroom+model is tight.
    expect(clamp.max).toBeLessThanOrEqual(4096);
    const refused = clampMindLocalContextRequest(65536, {
      totalMemoryGb: 15,
      freeMemoryGb: 8,
      hasUsableGpu: false,
      modelSizeGb: 5,
    });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/safe ceiling/);
    const ok = clampMindLocalContextRequest(512, {
      totalMemoryGb: 15,
      freeMemoryGb: 8,
      hasUsableGpu: false,
      modelSizeGb: 5,
    });
    expect(ok).toMatchObject({ ok: true, numCtx: 512 });
  });

  it('allows larger windows when a usable GPU has VRAM', () => {
    const clamp = resolveMindLocalContextClamp({
      totalMemoryGb: 64,
      freeMemoryGb: 40,
      hasUsableGpu: true,
      maxVramGb: 24,
      modelSizeGb: 5,
    });
    expect(clamp.max).toBeGreaterThanOrEqual(32768);
  });
});
