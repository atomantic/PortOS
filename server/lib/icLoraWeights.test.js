import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

// Both dependencies are filesystem-facing: inspectModelCache walks the real HF
// cache and existsSync probes the pinned weight file. Mock them so these tests
// cover the registry + resolution logic rather than the user's ~/.cache layout
// (hfCache.test.js already covers the cache walk).
const { mockInspectModelCache, mockExistsSync } = vi.hoisted(() => ({
  mockInspectModelCache: vi.fn(),
  mockExistsSync: vi.fn(),
}));
vi.mock('./hfCache.js', () => ({ inspectModelCache: mockInspectModelCache }));
vi.mock('node:fs', () => ({ existsSync: mockExistsSync }));

const {
  IC_LORA_MODES, IC_LORA_MODE_VALUES, isIcLoraMode, icLoraSpecForMode,
  icLoraRepos, resolveIcLoraWeight,
} = await import('./icLoraWeights.js');

beforeEach(() => {
  mockInspectModelCache.mockReset();
  mockExistsSync.mockReset();
});

describe('IC-LoRA registry', () => {
  it('exposes ic-prefixed mode values derived from the registry', () => {
    expect(IC_LORA_MODE_VALUES).toEqual(['ic-control']);
    // The `ic-` prefix is load-bearing: the client's download-id router and the
    // route's mode enum both key off it.
    for (const v of IC_LORA_MODE_VALUES) expect(v.startsWith('ic-')).toBe(true);
  });

  it('identifies IC modes and rejects everything else', () => {
    expect(isIcLoraMode('ic-control')).toBe(true);
    expect(isIcLoraMode('text')).toBe(false);
    expect(isIcLoraMode('a2v')).toBe(false);
    expect(isIcLoraMode(undefined)).toBe(false);
    expect(isIcLoraMode('')).toBe(false);
  });

  it('resolves a spec from either the prefixed mode or the bare id', () => {
    expect(icLoraSpecForMode('ic-control')).toBe(IC_LORA_MODES.control);
    expect(icLoraSpecForMode('control')).toBe(IC_LORA_MODES.control);
    expect(icLoraSpecForMode('ic-nope')).toBeNull();
    expect(icLoraSpecForMode(null)).toBeNull();
  });

  it('lists every weight repo for the integrity-scan surface', () => {
    expect(icLoraRepos()).toEqual(['Lightricks/LTX-2.3-22b-IC-LoRA-Union-Control']);
  });

  it('keeps every entry internally consistent', () => {
    for (const spec of Object.values(IC_LORA_MODES)) {
      expect(spec.mode).toBe(`ic-${spec.id}`);
      expect(spec.filename.endsWith('.safetensors')).toBe(true);
      expect(spec.repo).toMatch(/^[^/]+\/[^/]+$/);
      expect(spec.minReferences).toBeGreaterThanOrEqual(1);
      expect(spec.maxReferences).toBeGreaterThanOrEqual(spec.minReferences);
      expect(spec.referenceDownscaleFactor).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('resolveIcLoraWeight', () => {
  it('pins the exact filename inside the cached snapshot', async () => {
    mockInspectModelCache.mockResolvedValue({ cached: true, sizeBytes: 1, snapshotPath: '/hf/snap' });
    mockExistsSync.mockReturnValue(true);

    const resolved = await resolveIcLoraWeight('ic-control');
    // Pinning the filename (rather than returning the snapshot dir or the repo
    // id) is what stops the pipeline's glob from picking a sibling weight.
    expect(resolved.path).toBe(join('/hf/snap', IC_LORA_MODES.control.filename));
    expect(resolved.cached).toBe(true);
    expect(resolved.spec).toBe(IC_LORA_MODES.control);
  });

  it('falls back to the repo id when no snapshot exists', async () => {
    mockInspectModelCache.mockResolvedValue({ cached: false, sizeBytes: 0, snapshotPath: null });

    const resolved = await resolveIcLoraWeight('ic-control');
    expect(resolved.path).toBe(IC_LORA_MODES.control.repo);
    expect(resolved.cached).toBe(false);
  });

  it('falls back to the repo id when the snapshot lacks the pinned file', async () => {
    // A partial download leaves the snapshot dir present but the weight absent —
    // returning the dir-joined path would hand the pipeline a missing file, so
    // the repo-id fallback (which re-downloads) is the correct degrade.
    mockInspectModelCache.mockResolvedValue({ cached: true, sizeBytes: 1, snapshotPath: '/hf/snap' });
    mockExistsSync.mockReturnValue(false);

    const resolved = await resolveIcLoraWeight('ic-control');
    expect(resolved.path).toBe(IC_LORA_MODES.control.repo);
    expect(resolved.cached).toBe(false);
  });

  it('returns null for an unknown mode without touching the cache', async () => {
    expect(await resolveIcLoraWeight('ic-nope')).toBeNull();
    expect(mockInspectModelCache).not.toHaveBeenCalled();
  });
});
