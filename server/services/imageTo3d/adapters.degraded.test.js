import { describe, expect, it, vi } from 'vitest';

// Only the module probe is stubbed — the projection under test is the real thing.
vi.mock('./pixal3dCuda.js', async (importOriginal) => ({
  ...(await importOriginal()),
  probePixal3dModules: vi.fn(),
}));

import { TARGET_ADAPTERS } from './adapters.js';
import { probePixal3dModules, PIXAL3D_NAF_FALLBACK_HELP } from './pixal3dCuda.js';

const describeState = () => TARGET_ADAPTERS.pixal3dCuda.describeInstallState();

describe('pixal3dCuda degraded-state projection', () => {
  it('reports an incomplete install when a REQUIRED extension did not build', async () => {
    // `setup.sh` is sourced and can exit 0 with a failed extension build, and the
    // install's `verify` hook only checks the interpreter + entrypoint. So this
    // projection is the ONLY thing standing between a half-built install and a card
    // that reads plain "Ready" until the first render dies in the GLB exporter.
    probePixal3dModules.mockResolvedValueOnce({ naf: 'available', missing: ['o_voxel'] });
    const state = await describeState();
    expect(state.fields.degraded).toMatchObject({ label: 'incomplete install', repairable: true });
    expect(state.fields.degraded.help).toContain('o_voxel');
    expect(state.warnings).toHaveLength(1);
  });

  it('names every missing extension, not just the first', async () => {
    probePixal3dModules.mockResolvedValueOnce({ naf: 'available', missing: ['o_voxel', 'flex_gemm'] });
    const state = await describeState();
    expect(state.fields.degraded.help).toContain('o_voxel and flex_gemm');
  });

  it('lets an incomplete install outrank a NAF fallback', async () => {
    // Both are repairable by the same action, so reporting the milder one would
    // understate the problem.
    probePixal3dModules.mockResolvedValueOnce({
      naf: 'unavailable', missing: ['o_voxel'], help: PIXAL3D_NAF_FALLBACK_HELP,
    });
    const state = await describeState();
    expect(state.fields.degraded.label).toBe('incomplete install');
  });

  it('reports the NAF fallback when the install is otherwise complete', async () => {
    probePixal3dModules.mockResolvedValueOnce({
      naf: 'unavailable', missing: [], help: PIXAL3D_NAF_FALLBACK_HELP,
    });
    const state = await describeState();
    expect(state.fields.degraded).toEqual({
      label: 'NAF fallback', help: PIXAL3D_NAF_FALLBACK_HELP, repairable: true,
    });
  });

  it('reports nothing degraded for a healthy install', async () => {
    probePixal3dModules.mockResolvedValueOnce({ naf: 'available', missing: [] });
    const state = await describeState();
    expect(state.fields.degraded).toBeUndefined();
    expect(state.warnings).toEqual([]);
    expect(state.fields.naf).toBe('available');
  });

  it('reports nothing degraded when the probe could not run', async () => {
    // "Failed to determine" must never render as "determined to be broken".
    probePixal3dModules.mockResolvedValueOnce({ naf: 'unknown', missing: [] });
    const state = await describeState();
    expect(state.fields.degraded).toBeUndefined();
    expect(state.warnings).toEqual([]);
  });
});
