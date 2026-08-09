import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './237-video-model-disclosure.js';
import { VIDEO_MODEL_DISCLOSURES } from '../../server/lib/videoDisclosure.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const HUNYUAN_REPO = VIDEO_MODEL_DISCLOSURES.hunyuan_video.shippedRepo;
const TI2V_REPO = VIDEO_MODEL_DISCLOSURES.wan22_ti2v_5b.shippedRepo;

const baseRegistry = (overrides = {}) => ({
  video: {
    macos: [
      { id: 'wan22_ti2v_5b', name: 'Wan 2.2 TI2V 5B', repo: TI2V_REPO, runtime: 'wan22', steps: 25, ...overrides },
      { id: 'hunyuan_video', name: 'HunyuanVideo', repo: HUNYUAN_REPO, runtime: 'hunyuan', steps: 30 },
      { id: 'my_custom_model', name: 'My Custom Model', repo: 'example-org/example-video', source: 'user' },
    ],
    windows: [{ id: 'ltx_video', name: 'LTX-Video 0.9.5', runtime: 'mlx_video', steps: 25 }],
    defaultMacos: 'wan22_ti2v_5b',
  },
});

const findMacos = (path, id) => readJson(path).video.macos.find((e) => e.id === id);

describe('migration 237 — video model disclosure metadata', () => {
  let rootDir;
  let path;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-237-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    path = join(rootDir, 'data', 'media-models.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('enriches shipped video entries with source-backed disclosure metadata', async () => {
    writeJson(path, baseRegistry());
    await migration.up({ rootDir });
    const entry = findMacos(path, 'hunyuan_video');
    expect(entry.disclosure).toEqual(VIDEO_MODEL_DISCLOSURES.hunyuan_video.disclosure);
    expect(entry.disclosure.weightsLicense.name).toBe('Tencent Hunyuan Community License');
    expect(entry.disclosure.runtimeLicense.name).toBe('Tencent Hunyuan Community License');
    expect(entry.disclosure.estimatedDownloadGb).toBeGreaterThan(0);
  });

  it('enriches the windows list too', async () => {
    writeJson(path, baseRegistry());
    await migration.up({ rootDir });
    const entry = readJson(path).video.windows.find((e) => e.id === 'ltx_video');
    expect(entry.disclosure.runtimeLicense.name).toBe('MIT');
    // No repo → no model card and no weights license we can attribute.
    expect('modelCardUrl' in entry.disclosure).toBe(false);
    expect('weightsLicense' in entry.disclosure).toBe(false);
  });

  it('preserves canonical fields and entry order', async () => {
    writeJson(path, baseRegistry());
    await migration.up({ rootDir });
    const got = readJson(path);
    expect(got.video.macos.map((e) => e.id)).toEqual(['wan22_ti2v_5b', 'hunyuan_video', 'my_custom_model']);
    const ti2v = got.video.macos[0];
    expect(ti2v.repo).toBe(TI2V_REPO);
    expect(ti2v.runtime).toBe('wan22');
    expect(ti2v.steps).toBe(25);
    expect(got.video.defaultMacos).toBe('wan22_ti2v_5b');
  });

  it('does not duplicate canonical fields inside disclosure', async () => {
    writeJson(path, baseRegistry());
    await migration.up({ rootDir });
    const keys = Object.keys(findMacos(path, 'wan22_ti2v_5b').disclosure);
    for (const canonical of ['repo', 'revision', 'runtime', 'memoryGb', 'supportedModes', 'requiredWeights']) {
      expect(keys).not.toContain(canonical);
    }
  });

  it('leaves custom (user-added) models untouched', async () => {
    writeJson(path, baseRegistry());
    await migration.up({ rootDir });
    const custom = findMacos(path, 'my_custom_model');
    expect('disclosure' in custom).toBe(false);
  });

  it('preserves a user-customized disclosure (including an intentional clear)', async () => {
    writeJson(path, baseRegistry({ disclosure: null }));
    await migration.up({ rootDir });
    expect(findMacos(path, 'wan22_ti2v_5b').disclosure).toBe(null);
  });

  it('skips an entry whose repo was re-pointed at a fork', async () => {
    writeJson(path, baseRegistry({ repo: 'example-org/wan2.2-fork' }));
    await migration.up({ rootDir });
    expect('disclosure' in findMacos(path, 'wan22_ti2v_5b')).toBe(false);
  });

  it('does not recreate entries the user deleted', async () => {
    writeJson(path, { video: { macos: [{ id: 'hunyuan_video', repo: HUNYUAN_REPO }], windows: [] } });
    await migration.up({ rootDir });
    expect(readJson(path).video.macos.map((e) => e.id)).toEqual(['hunyuan_video']);
  });

  it('is idempotent — a second run rewrites nothing', async () => {
    writeJson(path, baseRegistry());
    await migration.up({ rootDir });
    const after = readFileSync(path, 'utf-8');
    await migration.up({ rootDir });
    expect(readFileSync(path, 'utf-8')).toBe(after);
  });

  it('skips silently when data/media-models.json is missing (fresh install)', async () => {
    await migration.up({ rootDir });
    expect(existsSync(path)).toBe(false);
  });

  it('skips when the video section is missing entirely', async () => {
    writeJson(path, { image: [] });
    await migration.up({ rootDir });
    expect(readJson(path)).toEqual({ image: [] });
  });

  it('throws a clear error on invalid JSON', async () => {
    writeFileSync(path, '{ not json');
    await expect(migration.up({ rootDir })).rejects.toThrow(/invalid JSON/);
  });
});
