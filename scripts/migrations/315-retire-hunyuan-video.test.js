import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { repoRoot } from './_testHelpers.js';
import { RETIRED_VIDEO_MODELS } from '../../server/lib/mediaModels.js';
import migration, { REPLACEMENT_ID, RETIRED_ID, SHIPPED_REPO } from './315-retire-hunyuan-video.js';

const REFERENCE_PATH = join(repoRoot, 'data.reference', 'media-models.json');
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const shippedHunyuan = () => ({
  id: RETIRED_ID,
  name: 'HunyuanVideo legacy profile',
  repo: SHIPPED_REPO,
  runtime: 'hunyuan',
  steps: 30,
  guidance: 6,
  deprecated: true,
});

const registryWith = (hunyuan, overrides = {}) => ({
  video: {
    macos: [
      ...(hunyuan ? [hunyuan] : []),
      { id: REPLACEMENT_ID, name: 'FastMetal 1.3B', runtime: 'fastvideo' },
    ],
    windows: [{ id: 'ltx_video', name: 'LTX-Video' }],
    defaultMacos: RETIRED_ID,
    defaultWindows: 'ltx_video',
    ...overrides,
  },
  image: [],
  _shippedDefaults: { video: { macos: [RETIRED_ID, REPLACEMENT_ID], windows: ['ltx_video'] } },
});

describe('migration 315 — retire legacy HunyuanVideo', () => {
  let rootDir;
  let path;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-315-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    path = join(rootDir, 'data', 'media-models.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('shares its retirement contract with the registry loader', () => {
    expect(RETIRED_VIDEO_MODELS[RETIRED_ID]).toEqual({
      shippedRepo: SHIPPED_REPO,
      replacement: REPLACEMENT_ID,
    });
  });

  it('matches the fresh-install catalog', () => {
    const seeded = JSON.parse(readFileSync(REFERENCE_PATH, 'utf-8'));
    expect(seeded.video.mlx.some((entry) => entry.id === RETIRED_ID)).toBe(false);
    expect(seeded.video.mlx.some((entry) => entry.id === REPLACEMENT_ID)).toBe(true);
  });

  it('removes the shipped profile and repoints its configured default', async () => {
    writeJson(path, registryWith(shippedHunyuan()));
    await migration.up({ rootDir });

    const after = readJson(path);
    expect(after.video.macos.map((entry) => entry.id)).toEqual([REPLACEMENT_ID]);
    expect(after.video.defaultMacos).toBe(REPLACEMENT_ID);
    expect(after._shippedDefaults.video.macos).toContain(RETIRED_ID);
  });

  it('preserves a user-repointed entry and its default', async () => {
    const customized = shippedHunyuan();
    customized.repo = 'example-org/custom-video-runtime';
    const before = registryWith(customized);
    writeJson(path, before);

    await migration.up({ rootDir });

    expect(readJson(path)).toEqual(before);
  });

  it('leaves the stale default when the replacement is absent', async () => {
    const before = registryWith(shippedHunyuan());
    before.video.macos = [shippedHunyuan()];
    writeJson(path, before);

    await migration.up({ rootDir });

    const after = readJson(path);
    expect(after.video.macos).toEqual([]);
    expect(after.video.defaultMacos).toBe(RETIRED_ID);
  });

  it('is idempotent and skips a missing registry', async () => {
    writeJson(path, registryWith(shippedHunyuan()));
    await migration.up({ rootDir });
    const once = readJson(path);
    await migration.up({ rootDir });
    expect(readJson(path)).toEqual(once);

    rmSync(path);
    await expect(migration.up({ rootDir })).resolves.toBeUndefined();
  });
});
