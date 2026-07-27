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
  icLoraRepos, listIcLoraWeights, icLoraWeightCandidates, findCachedIcLoraWeight,
  resolveIcLoraWeight, icResolutionIssue,
} = await import('./icLoraWeights.js');

beforeEach(() => {
  mockInspectModelCache.mockReset();
  mockExistsSync.mockReset();
});

describe('IC-LoRA registry', () => {
  it('exposes ic-prefixed mode values derived from the registry', () => {
    expect(IC_LORA_MODE_VALUES).toEqual(['ic-control', 'ic-colorize', 'ic-ingredients']);
    // The `ic-` prefix is load-bearing: the client's download-id router and the
    // route's mode enum both key off it.
    for (const v of IC_LORA_MODE_VALUES) expect(v.startsWith('ic-')).toBe(true);
  });

  it('identifies IC modes and rejects everything else', () => {
    expect(isIcLoraMode('ic-control')).toBe(true);
    expect(isIcLoraMode('ic-colorize')).toBe(true);
    expect(isIcLoraMode('text')).toBe(false);
    expect(isIcLoraMode('a2v')).toBe(false);
    expect(isIcLoraMode(undefined)).toBe(false);
    expect(isIcLoraMode('')).toBe(false);
  });

  it('resolves a spec from either the prefixed mode or the bare id', () => {
    expect(icLoraSpecForMode('ic-control')).toBe(IC_LORA_MODES.control);
    expect(icLoraSpecForMode('control')).toBe(IC_LORA_MODES.control);
    expect(icLoraSpecForMode('ic-colorize')).toBe(IC_LORA_MODES.colorize);
    expect(icLoraSpecForMode('colorize')).toBe(IC_LORA_MODES.colorize);
    expect(icLoraSpecForMode('ic-nope')).toBeNull();
    expect(icLoraSpecForMode(null)).toBeNull();
  });

  it('lists every weight repo for the integrity-scan surface', () => {
    expect(icLoraRepos()).toEqual([
      'Lightricks/LTX-2.3-22b-IC-LoRA-Union-Control',
      'DoctorDiffusion/LTX-2.3-IC-LoRA-Colorizer',
      'Lightricks/LTX-2.3-22b-IC-LoRA-Ingredients',
    ]);
  });

  it('excludes mirror repos from the integrity-scan surface (#3112)', () => {
    // An unscoped integrity scan walks each repo's WHOLE snapshot. The Ingredients
    // mirror is the ~708 GB `DeepBeepMeep/LTX-2` aggregate, so including it would
    // stat (and under `deep`, hash) every unrelated LTX weight the user has.
    const mirrors = listIcLoraWeights().map((s) => s.mirrorRepo).filter(Boolean);
    expect(mirrors.length).toBeGreaterThan(0);
    for (const mirror of mirrors) expect(icLoraRepos()).not.toContain(mirror);
  });

  it('keeps every entry internally consistent', () => {
    for (const spec of Object.values(IC_LORA_MODES)) {
      expect(spec.mode).toBe(`ic-${spec.id}`);
      expect(spec.filename.endsWith('.safetensors')).toBe(true);
      expect(spec.repo).toMatch(/^[^/]+\/[^/]+$/);
      expect(spec.sizeBytes).toBeGreaterThan(0);
      expect(spec.uploadLabel).toBeTruthy();
      expect(spec.minReferences).toBeGreaterThanOrEqual(1);
      expect(spec.maxReferences).toBeGreaterThanOrEqual(spec.minReferences);
      expect(spec.referenceDownscaleFactor).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps each weight on its OWN downscale factor, read from its metadata', () => {
    // Verified against each weight's safetensors `__metadata__` header
    // (`reference_downscale_factor`, the value read_lora_reference_downscale_factor
    // in the vendored iclora_utils.py returns). They DIFFER — copying Control's 2
    // onto the Colorizer would make the form reject perfectly valid odd-multiple
    // resolutions, so this pins the per-weight values rather than a shared one.
    expect(IC_LORA_MODES.control.referenceDownscaleFactor).toBe(2);
    expect(IC_LORA_MODES.colorize.referenceDownscaleFactor).toBe(1);
  });

  it('imposes no resolution rule for a factor-1 weight but does for factor 2', () => {
    // Factor 1 → icResolutionIssue short-circuits, so an odd resolution is fine.
    expect(icResolutionIssue(IC_LORA_MODES.colorize, 705, 449)).toBeNull();
    expect(icResolutionIssue(IC_LORA_MODES.control, 705, 449)).toMatch(/divisible by 2/);
    expect(icResolutionIssue(IC_LORA_MODES.control, 704, 448)).toBeNull();
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

  it('pins each mode to its OWN filename, not the first registry entry', async () => {
    mockInspectModelCache.mockResolvedValue({ cached: true, sizeBytes: 1, snapshotPath: '/hf/snap' });
    mockExistsSync.mockReturnValue(true);

    const resolved = await resolveIcLoraWeight('ic-colorize');
    expect(resolved.path).toBe(join('/hf/snap', IC_LORA_MODES.colorize.filename));
    expect(resolved.spec).toBe(IC_LORA_MODES.colorize);
    expect(mockInspectModelCache).toHaveBeenCalledWith(IC_LORA_MODES.colorize.repo);
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

  it('SUPPRESSES the repo-id fallback for a requiresPreDownload weight (#3112)', async () => {
    // This is the whole point of the flag. `_resolve_lora_path` implements a bare
    // repo id as `snapshot_download(id)`: for Ingredients the official repo is
    // gated (401 deep inside the render) and the mirror is the ~708 GB
    // DeepBeepMeep/LTX-2 aggregate, which would fill the user's disk. Neither id
    // may ever reach the pipeline — path must be null so icLoraArgs 400s with
    // "download the weight first".
    mockInspectModelCache.mockResolvedValue({ cached: false, sizeBytes: 0, snapshotPath: null });

    const resolved = await resolveIcLoraWeight('ic-ingredients');
    expect(resolved.path).toBeNull();
    expect(resolved.cached).toBe(false);
    expect(resolved.spec).toBe(IC_LORA_MODES.ingredients);
    expect(resolved.path).not.toBe(IC_LORA_MODES.ingredients.repo);
    expect(resolved.path).not.toBe(IC_LORA_MODES.ingredients.mirrorRepo);
  });

  it('still resolves a requiresPreDownload weight from the mirror snapshot', async () => {
    // Official repo has no snapshot; the mirror does. The candidate walk must find
    // it there rather than giving up (that's what makes the un-gated path work for
    // a user with no HF token).
    mockInspectModelCache.mockImplementation(async (repo) => (
      repo === IC_LORA_MODES.ingredients.mirrorRepo
        ? { cached: true, sizeBytes: 1, snapshotPath: '/hf/mirror-snap' }
        : { cached: false, sizeBytes: 0, snapshotPath: null }
    ));
    mockExistsSync.mockReturnValue(true);

    const resolved = await resolveIcLoraWeight('ic-ingredients');
    expect(resolved.path).toBe(join('/hf/mirror-snap', IC_LORA_MODES.ingredients.mirrorFilename));
    expect(resolved.cached).toBe(true);
    expect(resolved.repo).toBe(IC_LORA_MODES.ingredients.mirrorRepo);
  });

  it('prefers the official repo over the mirror when both are cached', async () => {
    mockInspectModelCache.mockImplementation(async (repo) => ({
      cached: true,
      sizeBytes: 1,
      snapshotPath: repo === IC_LORA_MODES.ingredients.repo ? '/hf/official' : '/hf/mirror',
    }));
    mockExistsSync.mockReturnValue(true);

    const resolved = await resolveIcLoraWeight('ic-ingredients');
    expect(resolved.repo).toBe(IC_LORA_MODES.ingredients.repo);
    expect(resolved.path).toBe(join('/hf/official', IC_LORA_MODES.ingredients.filename));
  });
});

describe('icLoraWeightCandidates', () => {
  it('orders official first, mirror second, and pins each filename', () => {
    // Order IS the policy: a user WITH an HF token gets the first-party weight; a
    // user without one falls through to the un-gated mirror.
    expect(icLoraWeightCandidates(IC_LORA_MODES.ingredients)).toEqual([
      { repo: IC_LORA_MODES.ingredients.repo, filename: IC_LORA_MODES.ingredients.filename, mirror: false },
      { repo: IC_LORA_MODES.ingredients.mirrorRepo, filename: IC_LORA_MODES.ingredients.mirrorFilename, mirror: true },
    ]);
  });

  it('yields a single candidate for a mirror-less spec', () => {
    expect(icLoraWeightCandidates(IC_LORA_MODES.control)).toEqual([
      { repo: IC_LORA_MODES.control.repo, filename: IC_LORA_MODES.control.filename, mirror: false },
    ]);
  });

  it('returns nothing for a null spec', () => {
    expect(icLoraWeightCandidates(null)).toEqual([]);
  });
});

describe('findCachedIcLoraWeight', () => {
  it('treats a dangling snapshot symlink as not cached', async () => {
    // existsSync FOLLOWS symlinks, so an interrupted download (link present, blob
    // gone) must NOT count as resident — otherwise the render hands the pipeline a
    // path that fails on open.
    mockInspectModelCache.mockResolvedValue({ cached: true, sizeBytes: 1, snapshotPath: '/hf/snap' });
    mockExistsSync.mockReturnValue(false);
    expect(await findCachedIcLoraWeight(IC_LORA_MODES.ingredients)).toBeNull();
  });
});
