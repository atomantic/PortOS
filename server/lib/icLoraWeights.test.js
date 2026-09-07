import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

// Both dependencies are filesystem-facing: inspectModelCache walks the real HF
// cache and existsSync probes the pinned weight file. Mock them so these tests
// cover the registry + resolution logic rather than the user's ~/.cache layout
// (hfCache.test.js already covers the cache walk).
const { mockFindCachedRepoFile } = vi.hoisted(() => ({ mockFindCachedRepoFile: vi.fn() }));
vi.mock('./hfCache.js', () => ({ findCachedRepoFile: mockFindCachedRepoFile }));

const {
  IC_LORA_MODES, IC_LORA_MODE_VALUES, IC_LORA_WEIGHT_KEYS, IC_LORA_REMIX_BASE_MODEL,
  isIcLoraMode, icLoraSpecForMode, icLoraSpecByKey, icLoraWeightKey, icLoraProbesExactFile,
  icLoraRepos, listIcLoraWeights, listIcLoraRemixModes, icLoraWeightCandidates,
  findCachedIcLoraWeight, resolveIcLoraWeight, resolveIcLoraWeightByKey, icResolutionIssue,
} = await import('./icLoraWeights.js');

beforeEach(() => {
  mockFindCachedRepoFile.mockReset();
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
      'Lightricks/LTX-2.5-22b-IC-LoRA-Pixel-Spatial-Upscaler',
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
      expect(spec.filename.endsWith('.safetensors')).toBe(true);
      expect(spec.repo).toMatch(/^[^/]+\/[^/]+$/);
      expect(spec.sizeBytes).toBeGreaterThan(0);
      expect(spec.uploadLabel).toBeTruthy();
      expect(spec.baseModel).toMatch(/^ltx-\d+\.\d+$/);
      expect(spec.minReferences).toBeGreaterThanOrEqual(1);
      expect(spec.maxReferences).toBeGreaterThanOrEqual(spec.minReferences);
      // Either a real factor read from the weight's metadata, or an explicit
      // null meaning "not read yet" — never 0, a string, or a guess.
      expect(
        spec.referenceDownscaleFactor === null || spec.referenceDownscaleFactor >= 1,
      ).toBe(true);
    }
  });

  it('keys every registry entry by its own id', () => {
    // icLoraSpecForMode and icLoraSpecByKey both fall back to a bare-id lookup
    // straight into this map, so a key that drifts from its entry's `id` makes
    // that lookup silently miss for one weight and work for the rest.
    for (const [key, spec] of Object.entries(IC_LORA_MODES)) expect(key).toBe(spec.id);
  });

  it('names every remix mode ic-<id>, and gives a non-remix weight no mode at all', () => {
    // The `ic-` prefix is load-bearing for the remix modes; a weight that is not
    // a remix mode must carry `mode: null` rather than an unreachable `ic-` value
    // that would read as a render mode the enum silently drops.
    for (const spec of listIcLoraRemixModes()) expect(spec.mode).toBe(`ic-${spec.id}`);
    for (const spec of listIcLoraWeights()) {
      if (listIcLoraRemixModes().includes(spec)) continue;
      expect(spec.mode).toBeNull();
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

  it('asserts no resolution rule for a weight whose factor has not been read', () => {
    // The upscaler's file is gated, so its `reference_downscale_factor` is
    // unknown rather than known-to-be-1. Guessing either way is the bug: a
    // guessed 2 rejects valid resolutions, and treating a non-number as a
    // divisor produces a nonsense message. Both must yield "no rule".
    expect(IC_LORA_MODES['pixel-upscale'].referenceDownscaleFactor).toBeNull();
    expect(icResolutionIssue(IC_LORA_MODES['pixel-upscale'], 705, 449)).toBeNull();
    expect(icResolutionIssue({ referenceDownscaleFactor: undefined }, 705, 449)).toBeNull();
    expect(icResolutionIssue({ referenceDownscaleFactor: '2' }, 705, 449)).toBeNull();
  });
});

describe('resolveIcLoraWeight', () => {
  // `findCachedRepoFile(repo, filename)` returns the absolute path or null. It is
  // deliberately NOT inspectModelCache: that walks + stats the whole snapshot,
  // which for an aggregate mirror means hundreds of GB of unrelated weights.
  const cacheHas = (...pairs) => mockFindCachedRepoFile.mockImplementation(
    async (repo, filename) => {
      const hit = pairs.find((p) => p.repo === repo && p.filename === filename);
      return hit ? join(hit.snapshot, filename) : null;
    },
  );

  it('pins the exact filename inside the cached snapshot', async () => {
    cacheHas({ repo: IC_LORA_MODES.control.repo, filename: IC_LORA_MODES.control.filename, snapshot: '/hf/snap' });

    const resolved = await resolveIcLoraWeight('ic-control');
    // Pinning the filename (rather than returning the snapshot dir or the repo
    // id) is what stops the pipeline's glob from picking a sibling weight.
    expect(resolved.path).toBe(join('/hf/snap', IC_LORA_MODES.control.filename));
    expect(resolved.cached).toBe(true);
    expect(resolved.spec).toBe(IC_LORA_MODES.control);
  });

  it('pins each mode to its OWN filename, not the first registry entry', async () => {
    cacheHas({ repo: IC_LORA_MODES.colorize.repo, filename: IC_LORA_MODES.colorize.filename, snapshot: '/hf/snap' });

    const resolved = await resolveIcLoraWeight('ic-colorize');
    expect(resolved.path).toBe(join('/hf/snap', IC_LORA_MODES.colorize.filename));
    expect(resolved.spec).toBe(IC_LORA_MODES.colorize);
    expect(mockFindCachedRepoFile).toHaveBeenCalledWith(
      IC_LORA_MODES.colorize.repo, IC_LORA_MODES.colorize.filename, { revision: null },
    );
  });

  it('never asks for a whole-snapshot walk, only exact filenames (#3112)', async () => {
    // The single-file invariant at the resolution layer: every probe names a file.
    cacheHas();
    await resolveIcLoraWeight('ic-ingredients');
    expect(mockFindCachedRepoFile).toHaveBeenCalledTimes(2);
    for (const [, filename] of mockFindCachedRepoFile.mock.calls) {
      expect(filename).toMatch(/\.safetensors$/);
    }
  });

  it('falls back to the repo id when the weight is not resident', async () => {
    // Covers both "no snapshot at all" and "snapshot present but the pinned file
    // missing / a dangling symlink" — findCachedRepoFile collapses them to null,
    // and the repo-id fallback (which re-downloads) is the correct degrade.
    cacheHas();

    const resolved = await resolveIcLoraWeight('ic-control');
    expect(resolved.path).toBe(IC_LORA_MODES.control.repo);
    expect(resolved.cached).toBe(false);
  });

  it('returns null for an unknown mode without touching the cache', async () => {
    expect(await resolveIcLoraWeight('ic-nope')).toBeNull();
    expect(mockFindCachedRepoFile).not.toHaveBeenCalled();
  });

  it('SUPPRESSES the repo-id fallback for a requiresPreDownload weight (#3112)', async () => {
    // This is the whole point of the flag. `_resolve_lora_path` implements a bare
    // repo id as `snapshot_download(id)`: for Ingredients the official repo is
    // gated (401 deep inside the render) and the mirror is the ~708 GB
    // DeepBeepMeep/LTX-2 aggregate, which would fill the user's disk. Neither id
    // may ever reach the pipeline — path must be null so icLoraArgs 400s with
    // "download the weight first".
    cacheHas();

    const resolved = await resolveIcLoraWeight('ic-ingredients');
    expect(resolved.path).toBeNull();
    expect(resolved.cached).toBe(false);
    expect(resolved.spec).toBe(IC_LORA_MODES.ingredients);
    expect(resolved.path).not.toBe(IC_LORA_MODES.ingredients.repo);
    expect(resolved.path).not.toBe(IC_LORA_MODES.ingredients.mirrorRepo);
  });

  it('still resolves a requiresPreDownload weight from the mirror', async () => {
    // Official repo doesn't have it; the mirror does. The candidate walk must find
    // it there rather than giving up — that's what makes the un-gated path work
    // for a user with no HF token.
    cacheHas({
      repo: IC_LORA_MODES.ingredients.mirrorRepo,
      filename: IC_LORA_MODES.ingredients.mirrorFilename,
      snapshot: '/hf/mirror-snap',
    });

    const resolved = await resolveIcLoraWeight('ic-ingredients');
    expect(resolved.path).toBe(join('/hf/mirror-snap', IC_LORA_MODES.ingredients.mirrorFilename));
    expect(resolved.cached).toBe(true);
    expect(resolved.repo).toBe(IC_LORA_MODES.ingredients.mirrorRepo);
  });

  it('prefers the official repo over the mirror when both have it', async () => {
    cacheHas(
      { repo: IC_LORA_MODES.ingredients.repo, filename: IC_LORA_MODES.ingredients.filename, snapshot: '/hf/official' },
      { repo: IC_LORA_MODES.ingredients.mirrorRepo, filename: IC_LORA_MODES.ingredients.mirrorFilename, snapshot: '/hf/mirror' },
    );

    const resolved = await resolveIcLoraWeight('ic-ingredients');
    expect(resolved.repo).toBe(IC_LORA_MODES.ingredients.repo);
    expect(resolved.path).toBe(join('/hf/official', IC_LORA_MODES.ingredients.filename));
    // Short-circuits: the mirror is never even probed once the official hit lands.
    expect(mockFindCachedRepoFile).toHaveBeenCalledTimes(1);
  });
});

describe('icLoraWeightCandidates', () => {
  it('orders official first, mirror second, and pins each filename', () => {
    // Order IS the policy: a user WITH an HF token gets the first-party weight; a
    // user without one falls through to the un-gated mirror.
    expect(icLoraWeightCandidates(IC_LORA_MODES.ingredients)).toEqual([
      {
        repo: IC_LORA_MODES.ingredients.repo,
        filename: IC_LORA_MODES.ingredients.filename,
        revision: null,
        mirror: false,
      },
      {
        repo: IC_LORA_MODES.ingredients.mirrorRepo,
        filename: IC_LORA_MODES.ingredients.mirrorFilename,
        revision: null,
        mirror: true,
      },
    ]);
  });

  it('yields a single candidate for a mirror-less spec', () => {
    expect(icLoraWeightCandidates(IC_LORA_MODES.control)).toEqual([
      {
        repo: IC_LORA_MODES.control.repo,
        filename: IC_LORA_MODES.control.filename,
        revision: null,
        mirror: false,
      },
    ]);
  });

  it('carries a pinned revision on the official candidate only', () => {
    // The pin belongs to the official repo's history. A mirror is a different
    // repository whose commits have nothing to do with it, so pinning one there
    // would resolve nothing — the mirror stays unpinned by construction.
    const [official] = icLoraWeightCandidates(IC_LORA_MODES['pixel-upscale']);
    expect(official.revision).toBe(IC_LORA_MODES['pixel-upscale'].revision);
    expect(official.revision).toMatch(/^[0-9a-f]{40}$/);
    for (const c of icLoraWeightCandidates(IC_LORA_MODES.ingredients)) {
      if (c.mirror) expect(c.revision).toBeNull();
    }
  });

  it('returns nothing for a null spec', () => {
    expect(icLoraWeightCandidates(null)).toEqual([]);
  });
});

describe('findCachedIcLoraWeight', () => {
  it('returns null when no candidate has the file resident', async () => {
    // findCachedRepoFile already collapses "no snapshot", "file absent" and
    // "dangling symlink / zero bytes" into null (hfCache.test.js covers those);
    // this asserts the candidate walk gives up rather than returning a bad path.
    mockFindCachedRepoFile.mockResolvedValue(null);
    expect(await findCachedIcLoraWeight(IC_LORA_MODES.ingredients)).toBeNull();
  });

  it('returns nothing for a null spec without probing the cache', async () => {
    expect(await findCachedIcLoraWeight(null)).toBeNull();
    expect(mockFindCachedRepoFile).not.toHaveBeenCalled();
  });

  it('probes a pinned weight inside its pinned revision, not the newest snapshot', async () => {
    // Without the revision, findCachedRepoFile resolves the NEWEST snapshot —
    // so an install holding an older commit of the repo would report the weight
    // cached and hand a different commit's tensors to the pipeline.
    mockFindCachedRepoFile.mockResolvedValue('/cache/pinned.safetensors');
    const found = await findCachedIcLoraWeight(IC_LORA_MODES['pixel-upscale']);
    expect(found.path).toBe('/cache/pinned.safetensors');
    expect(mockFindCachedRepoFile).toHaveBeenCalledWith(
      IC_LORA_MODES['pixel-upscale'].repo,
      IC_LORA_MODES['pixel-upscale'].filename,
      { revision: IC_LORA_MODES['pixel-upscale'].revision },
    );
  });

  it('probes an unpinned weight with no revision, preserving the existing behavior', async () => {
    mockFindCachedRepoFile.mockResolvedValue('/cache/control.safetensors');
    await findCachedIcLoraWeight(IC_LORA_MODES.control);
    expect(mockFindCachedRepoFile).toHaveBeenCalledWith(
      IC_LORA_MODES.control.repo,
      IC_LORA_MODES.control.filename,
      { revision: null },
    );
  });
});

describe('the LTX-2.5 Pixel Spatial Upscaler weight (#6502)', () => {
  const spec = () => IC_LORA_MODES['pixel-upscale'];

  it('is registered for provisioning but is NOT a remix mode', () => {
    // The whole point of the base-model split: this adapter rides the same
    // download/verify/repair surface, but fusing it into the LTX-2.3 remix
    // pipeline would load without erroring and render garbage.
    expect(listIcLoraWeights()).toContain(spec());
    expect(listIcLoraRemixModes()).not.toContain(spec());
    expect(spec().baseModel).not.toBe(IC_LORA_REMIX_BASE_MODEL);
  });

  it('is absent from the render-mode enum the route builds its z.enum from', () => {
    expect(IC_LORA_MODE_VALUES).toEqual(['ic-control', 'ic-colorize', 'ic-ingredients']);
    expect(IC_LORA_MODE_VALUES).not.toContain('ic-pixel-upscale');
    expect(isIcLoraMode('ic-pixel-upscale')).toBe(false);
    expect(isIcLoraMode('pixel-upscale')).toBe(false);
  });

  it('is unreachable through the render-path spec lookup', () => {
    // icLoraSpecForMode feeds the render path. It must not resolve a non-remix
    // weight by ANY spelling, including the bare registry id that the same
    // helper accepts for the remix modes.
    expect(icLoraSpecForMode('pixel-upscale')).toBeNull();
    expect(icLoraSpecForMode('ic-pixel-upscale')).toBeNull();
    expect(icLoraSpecForMode(spec().id)).toBeNull();
  });

  it('IS reachable through the provisioning lookup, by its weight key', () => {
    expect(icLoraWeightKey(spec())).toBe('pixel-upscale');
    expect(icLoraSpecByKey('pixel-upscale')).toBe(spec());
    // Remix modes keep their existing URL identity through the same lookup, so
    // `/ic-loras/ic-control/download` is unchanged.
    expect(icLoraWeightKey(IC_LORA_MODES.control)).toBe('ic-control');
    expect(icLoraSpecByKey('ic-control')).toBe(IC_LORA_MODES.control);
    expect(IC_LORA_WEIGHT_KEYS).toEqual(['ic-control', 'ic-colorize', 'ic-ingredients', 'pixel-upscale']);
  });

  it('pins the exact repo, filename, revision and byte size from the HF listing', () => {
    // Read from the repo's public blob listing. The size is exact, not an
    // estimate — the download badge shows it before the pull.
    expect(spec().repo).toBe('Lightricks/LTX-2.5-22b-IC-LoRA-Pixel-Spatial-Upscaler');
    expect(spec().filename).toBe('ltx-2.5-22b-ic-lora-pixel-spatial-upscaler-x2-1.0.safetensors');
    expect(spec().revision).toBe('5863fdef3eaa8b2d69fa22e259a1d75fede215dd');
    expect(spec().sizeBytes).toBe(327_322_640);
  });

  it('is gated with NO mirror, so a gated failure is not swallowed by a fallback', () => {
    // #6502 rules out adopting a third-party release mirror or side-stepping the
    // license. A single candidate also means the download stream reports the
    // gated failure itself instead of downgrading it on the way to a fallback.
    expect(spec().gated).toBe(true);
    expect(spec().mirrorRepo).toBeUndefined();
    expect(icLoraWeightCandidates(spec())).toHaveLength(1);
  });

  it('is probed by its exact file, never by a repo-wide cache verdict', () => {
    expect(icLoraProbesExactFile(spec())).toBe(true);
    // Un-pinned, un-mirrored weights keep the cheaper repo-wide path.
    expect(icLoraProbesExactFile(IC_LORA_MODES.control)).toBe(false);
    expect(icLoraProbesExactFile(IC_LORA_MODES.ingredients)).toBe(true);
  });

  it('never emits a bare repo id for the pipeline to snapshot_download', async () => {
    // Handing a gated repo id to a pipeline's own resolver produces a 401 deep
    // inside a render. `path: null` is what makes the caller fail fast with an
    // actionable "download the weight first" instead.
    mockFindCachedRepoFile.mockResolvedValue(null);
    const resolved = await resolveIcLoraWeightByKey('pixel-upscale');
    expect(resolved).toEqual({ path: null, cached: false, spec: spec() });
    expect(spec().requiresPreDownload).toBe(true);
  });

  it('resolves the cached file once it is downloaded', async () => {
    mockFindCachedRepoFile.mockResolvedValue('/cache/upscaler.safetensors');
    const resolved = await resolveIcLoraWeightByKey('pixel-upscale');
    expect(resolved).toMatchObject({ path: '/cache/upscaler.safetensors', cached: true, repo: spec().repo });
  });

  it('stays unresolvable through the render-path resolver', async () => {
    expect(await resolveIcLoraWeight('ic-pixel-upscale')).toBeNull();
    expect(await resolveIcLoraWeight('pixel-upscale')).toBeNull();
    expect(mockFindCachedRepoFile).not.toHaveBeenCalled();
  });
});
