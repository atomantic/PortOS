import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PINNED = {
  id: 'ltx25_mlx_q8', repo: 'MrMofer/ltx-2.5-mlx-q8',
  revision: 'f1b56e7dc89f71a9af2cddac787b89ed22a8b7fc', runtime: 'ltx25',
  steps: 8, guidance: 3,
};
const FAST = {
  id: 'fast', steps: 8, stage2Steps: 3, guidance: 1, teacache: true,
  modes: ['text', 'image'], speedupLabel: '~35-45% faster',
  description: 'Validated 8+3-step two-stage schedule at CFG 1.0 with stage-1 TeaCache. Softer detail and weaker prompt adherence than Quality.',
};

describe('LTX-2.5 guided sampler migration', () => {
  let rootDir;
  let path;
  let models;
  let migration;
  const previousPath = process.env.PORTOS_MEDIA_MODELS_FILE;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'portos-ltx25-steps-'));
    mkdirSync(join(rootDir, 'data'));
    path = join(rootDir, 'data', 'media-models.json');
    process.env.PORTOS_MEDIA_MODELS_FILE = path;
    vi.resetModules();
    models = await import('../../server/lib/mediaModels.js');
    ({ default: migration } = await import('./455-ltx25-guided-steps.js'));
  });

  afterEach(() => {
    if (previousPath === undefined) delete process.env.PORTOS_MEDIA_MODELS_FILE;
    else process.env.PORTOS_MEDIA_MODELS_FILE = previousPath;
    rmSync(rootDir, { recursive: true, force: true });
  });

  const writeEntry = (registryPath, entry, bucket = 'mlx') => {
    writeFileSync(registryPath, JSON.stringify({ video: { [bucket]: [entry] } }));
  };

  it('updates the shipped sampler and cached registry once while preserving the fast schedule and later overrides', async () => {
    writeEntry(path, { ...PINNED, speedProfiles: [FAST] });
    expect(models.loadMediaModels().video.mlx[0].steps).toBe(8);

    await migration.up({ rootDir });

    const current = models.loadMediaModels().video.mlx[0];
    expect(current).toMatchObject({ steps: 30, guidance: 3 });
    expect(current.speedProfiles[0]).toMatchObject({ steps: 8, stage2Steps: 3, guidance: 1, teacache: true });
    expect(current.speedProfiles[0]).not.toHaveProperty('speedupLabel');
    expect(current.speedProfiles[0].description).toContain('not calibrated for LTX-2.5');
    const once = readFileSync(path, 'utf-8');
    await migration.up({ rootDir });
    expect(readFileSync(path, 'utf-8')).toBe(once);

    const stored = JSON.parse(once);
    stored.video.mlx[0].steps = 8;
    writeFileSync(path, JSON.stringify(stored));
    expect(models.reloadMediaModels().video.mlx[0].steps).toBe(8);
  });

  it('supports the legacy macos bucket', async () => {
    writeEntry(path, PINNED, 'macos');
    await migration.up({ rootDir });
    expect(JSON.parse(readFileSync(path, 'utf-8')).video.macos[0].steps).toBe(30);
  });

  it('does not invalidate the live cache when migrating a different root', async () => {
    writeEntry(path, PINNED);
    const cached = models.loadMediaModels();
    const otherRoot = join(rootDir, 'other');
    mkdirSync(join(otherRoot, 'data'), { recursive: true });
    writeEntry(join(otherRoot, 'data', 'media-models.json'), PINNED);
    await migration.up({ rootDir: otherRoot });
    expect(models.loadMediaModels()).toBe(cached);
    expect(cached.video.mlx[0].steps).toBe(8);
  });

  it.each([
    { steps: 20 }, { guidance: 4 }, { samplerLocked: true }, { source: 'user' },
    { repo: 'example/ltx25-fork' }, { revision: 'different' }, { runtime: 'other' },
  ])('preserves a customized or repointed entry: %o', async (override) => {
    const entry = { ...PINNED, ...override };
    writeEntry(path, entry);
    await migration.up({ rootDir });
    expect(JSON.parse(readFileSync(path, 'utf-8')).video.mlx[0]).toEqual(entry);
  });

  it('leaves a custom profile label and missing registries alone', async () => {
    await expect(migration.up({ rootDir })).resolves.toBeUndefined();
    writeEntry(path, { ...PINNED, steps: 18, speedProfiles: [{ ...FAST, speedupLabel: 'local estimate', description: 'local description' }] });
    const before = readFileSync(path, 'utf-8');
    await migration.up({ rootDir });
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });
});
