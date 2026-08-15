import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { repoRoot } from './_testHelpers.js';
import { RETIRED_VIDEO_MODELS } from '../../server/lib/mediaModels.js';
import migration, { RETIRED_ID, SHIPPED_REPO, REPLACEMENT_ID } from './247-retire-ltx2-unified.js';

const REFERENCE_PATH = join(repoRoot, 'data.reference', 'media-models.json');

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const shippedLtx2 = () => ({
  id: RETIRED_ID,
  name: 'LTX-2 Unified (~42 GB)',
  repo: SHIPPED_REPO,
  runtime: 'mlx_video',
  steps: 30,
  guidance: 3,
  deprecated: true,
});

const registryWith = (ltx2, overrides = {}) => ({
  video: {
    macos: [
      ...(ltx2 ? [ltx2] : []),
      { id: 'ltx23_unified', name: 'LTX-2.3 Unified Beta' },
      { id: REPLACEMENT_ID, name: 'LTX-2.3 Distilled Q4' },
    ],
    windows: [{ id: 'ltx_video', name: 'LTX-Video 0.9.5' }],
    defaultMacos: 'ltx23_unified',
    defaultWindows: 'ltx_video',
    ...overrides,
  },
  image: [],
  _shippedDefaults: { video: { macos: [RETIRED_ID, REPLACEMENT_ID], windows: ['ltx_video'] } },
});

const idsIn = (config) => config.video.macos.map((entry) => entry.id);

describe('migration 247 — retire LTX-2 Unified', () => {
  let rootDir;
  let path;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-247-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    path = join(rootDir, 'data', 'media-models.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  // The migration freezes its own constants (per the migration convention) but
  // it is only half the retirement — mediaModels.js drops the same entry at
  // load. If the two copies drift, one half silently stops matching anything.
  it('froze the same id, repo, and replacement as the registry loader', () => {
    expect(RETIRED_VIDEO_MODELS[RETIRED_ID]).toEqual({
      shippedRepo: SHIPPED_REPO,
      replacement: REPLACEMENT_ID,
    });
  });

  // The migration exists to bring persisted registries in line with the seed a
  // fresh install gets. If the seed ever re-gained the entry the two paths would
  // silently diverge, so assert the seed agrees the model is gone.
  it('matches data.reference, which no longer ships the entry', () => {
    const seeded = JSON.parse(readFileSync(REFERENCE_PATH, 'utf-8'));
    expect(seeded.video.mlx.some((entry) => entry.id === RETIRED_ID)).toBe(false);
    expect(seeded.video.mlx.some((entry) => entry.id === REPLACEMENT_ID)).toBe(true);
  });

  it('removes the retired entry and leaves the LTX-2.3 models in place', async () => {
    writeJson(path, registryWith(shippedLtx2()));
    await migration.up({ rootDir });

    expect(idsIn(readJson(path))).toEqual(['ltx23_unified', REPLACEMENT_ID]);
  });

  it('keeps _shippedDefaults intact so nothing re-adds the model', async () => {
    writeJson(path, registryWith(shippedLtx2()));
    await migration.up({ rootDir });

    expect(readJson(path)._shippedDefaults.video.macos).toContain(RETIRED_ID);
  });

  it('repoints a default that pointed at the retired model', async () => {
    writeJson(path, registryWith(shippedLtx2(), { defaultMacos: RETIRED_ID }));
    await migration.up({ rootDir });

    expect(readJson(path).video.defaultMacos).toBe(REPLACEMENT_ID);
  });

  it('leaves the stale default alone when the replacement is not installed', async () => {
    const config = registryWith(shippedLtx2(), { defaultMacos: RETIRED_ID });
    config.video.macos = config.video.macos.filter((entry) => entry.id !== REPLACEMENT_ID);
    writeJson(path, config);
    await migration.up({ rootDir });

    const after = readJson(path);
    expect(idsIn(after)).toEqual(['ltx23_unified']);
    // Load-time fallback picks the first available model; inventing an id the
    // install doesn't have would be worse than leaving the stale value.
    expect(after.video.defaultMacos).toBe(RETIRED_ID);
  });

  it('does not touch a default pointing at another model', async () => {
    writeJson(path, registryWith(shippedLtx2()));
    await migration.up({ rootDir });

    expect(readJson(path).video.defaultMacos).toBe('ltx23_unified');
  });

  it('is idempotent', async () => {
    writeJson(path, registryWith(shippedLtx2()));
    await migration.up({ rootDir });
    const once = readJson(path);
    await migration.up({ rootDir });
    expect(readJson(path)).toEqual(once);
  });

  // The repo guard runs before any default handling, so a re-pointed entry that
  // is ALSO the configured default must come through completely untouched.
  it('skips an entry the user re-pointed at another repo, default included', async () => {
    const forked = shippedLtx2();
    forked.repo = 'example-org/ltx2-fork';
    const before = registryWith(forked, { defaultMacos: RETIRED_ID });
    writeJson(path, before);
    await migration.up({ rootDir });
    expect(readJson(path)).toEqual(before);
  });

  it('does nothing when the user already deleted the entry', async () => {
    const before = registryWith(null);
    writeJson(path, before);
    await migration.up({ rootDir });
    expect(readJson(path)).toEqual(before);
  });

  it('skips a missing registry file (fresh install seeds from data.reference)', async () => {
    await expect(migration.up({ rootDir })).resolves.toBeUndefined();
  });

  it('skips an invalid registry file rather than throwing', async () => {
    writeFileSync(path, '{ not json');
    await expect(migration.up({ rootDir })).resolves.toBeUndefined();
    expect(readFileSync(path, 'utf-8')).toBe('{ not json');
  });
});
