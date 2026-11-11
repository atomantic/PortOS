import { describe, expect, it, vi } from 'vitest';

// Only the module probe is stubbed — the projection under test is the real thing.
vi.mock('./pixal3dCuda.js', async (importOriginal) => ({
  ...(await importOriginal()),
  probePixal3dModules: vi.fn(),
}));

// Stub the MPS probe and exercise the same projection used by the route.
vi.mock('./trellis2.js', async (importOriginal) => ({
  ...(await importOriginal()),
  probeTrellis2TextureBake: vi.fn(),
}));

import { TARGET_ADAPTERS } from './adapters.js';
import { probePixal3dModules, PIXAL3D_NAF_FALLBACK_HELP } from './pixal3dCuda.js';
import { probeTrellis2TextureBake } from './trellis2.js';

const describeState = () => TARGET_ADAPTERS.pixal3dCuda.describeInstallState();

describe('pixal3dCuda degraded-state projection', () => {
  it('reports an incomplete install when a REQUIRED extension did not build', async () => {
    probePixal3dModules.mockResolvedValueOnce({ naf: 'available', missing: ['o_voxel'] });
    const state = await describeState();
    expect(state.fields.degraded).toEqual({
      label: 'incomplete install',
      help: expect.stringContaining('renders will fail in the mesh exporter'),
      repairable: false,
      detail: 'Missing: o_voxel',
    });
    // The culprit belongs to `detail` alone — repeating it in the remedy prose is the
    // split this projection exists to keep (#4741).
    expect(state.fields.degraded.help).not.toContain('o_voxel');
    expect(state.warnings).toHaveLength(1);
  });

  it('names every missing extension, not just the first', async () => {
    probePixal3dModules.mockResolvedValueOnce({ naf: 'available', missing: ['o_voxel', 'flex_gemm'] });
    const state = await describeState();
    expect(state.fields.degraded.detail).toBe('Missing: o_voxel, flex_gemm');
  });

  it('keeps the module names in the prose warning the install verify frame replays', async () => {
    // The card has a second line for `detail`; that stage has one string, so dropping the
    // names from `help` must not drop them from the frame the user actually reads there.
    probePixal3dModules.mockResolvedValueOnce({ naf: 'available', missing: ['o_voxel'] });
    const state = await describeState();
    expect(state.warnings).toEqual([expect.stringContaining('Missing: o_voxel.')]);
  });

  it('lets an incomplete install outrank a NAF fallback', async () => {
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
      label: 'NAF fallback', help: PIXAL3D_NAF_FALLBACK_HELP, repairable: false,
    });
  });

  it('reports nothing degraded for a healthy install', async () => {
    probePixal3dModules.mockResolvedValueOnce({ naf: 'available', missing: [] });
    const state = await describeState();
    expect(state.fields.degraded).toBeUndefined();
    expect(state.warnings ?? []).toEqual([]);
    expect(state.fields.naf).toBe('available');
  });

  it('reports nothing degraded when the probe could not run', async () => {
    // "Failed to determine" must never render as "determined to be broken".
    probePixal3dModules.mockResolvedValueOnce({ naf: 'unknown', missing: [] });
    const state = await describeState();
    expect(state.fields.degraded).toBeUndefined();
    expect(state.warnings ?? []).toEqual([]);
  });
});

// #4636: the card told the user which remedy to run but never what was missing, so a
// Repair that kept failing reprinted one generic sentence forever. `detail` carries
// the culprit modules through the SAME normalized `degraded` shape the client already
// renders — no per-target UI branch, and no reader on the back-compat `textureBake`.
describe('trellis2 degraded-state projection', () => {
  const describeTrellis2 = () => TARGET_ADAPTERS.trellis2.describeInstallState();
  const fallback = (missing) => ({
    quality: 'fallback', missing, degradedQuality: [], modules: {}, help: 'fix it',
  });

  it('names the missing bake modules in degraded.detail', async () => {
    probeTrellis2TextureBake.mockResolvedValueOnce(fallback(['o_voxel', 'mtlbvh']));
    const state = await describeTrellis2();
    expect(state.fields.degraded).toEqual({
      label: 'degraded textures', help: 'fix it', repairable: true, detail: 'Missing: o_voxel, mtlbvh',
    });
    expect(state.warnings).toEqual(['fix it Missing: o_voxel, mtlbvh.']);
  });

  it('reports nothing degraded — and no detail — for a healthy Metal bake', async () => {
    probeTrellis2TextureBake.mockResolvedValueOnce({
      quality: 'metal', missing: [], degradedQuality: [], modules: {},
    });
    const state = await describeTrellis2();
    expect(state.fields.degraded).toBeUndefined();
    expect(state.warnings ?? []).toEqual([]);
  });

  // A probe that could not run must not render a module list (could-not-determine ≠
  // determined-to-be-bad).
  it('reports nothing when the bake probe could not run', async () => {
    probeTrellis2TextureBake.mockResolvedValueOnce({
      quality: 'unknown', missing: [], degradedQuality: [], modules: {},
    });
    const state = await describeTrellis2();
    expect(state.fields.degraded).toBeUndefined();
  });

  // `flex_gemm` degrades bake QUALITY without forcing the fallback baker, so it must
  // never be listed as a cause of the scrambled surface.
  it('does not list degradedQuality modules as missing', async () => {
    probeTrellis2TextureBake.mockResolvedValueOnce({
      quality: 'fallback', missing: ['o_voxel'], degradedQuality: ['flex_gemm'], modules: {}, help: 'fix it',
    });
    const state = await describeTrellis2();
    expect(state.fields.degraded.detail).toBe('Missing: o_voxel');
  });
});
