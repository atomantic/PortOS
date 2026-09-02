import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import migration from './333-fasth3-dense-datafree-mlx.js';

const NEW_ID = 'fasth3_dense_datafree_mlx_int4';

describe('333-fasth3-dense-datafree-mlx migration', () => {
  let rootDir;
  let registryFile;

  beforeEach(() => {
    rootDir = join(tmpdir(), `portos-test-333-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    registryFile = join(rootDir, 'data', 'media-models.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  const write = (config) => writeFileSync(registryFile, JSON.stringify(config, null, 2));
  const read = () => JSON.parse(readFileSync(registryFile, 'utf-8'));

  it('skips gracefully when media-models.json does not exist', async () => {
    await expect(migration.up({ rootDir })).resolves.toBeUndefined();
  });

  it('adds the FastH3 row to an existing MLX registry and its shipped list', async () => {
    write({
      video: { mlx: [{ id: 'fastmetal_1_3b_qad', name: 'FastMetal 1.3B' }], cuda: [] },
      _shippedDefaults: { video: { mlx: ['fastmetal_1_3b_qad'] } },
    });

    await migration.up({ rootDir });

    const updated = read();
    const entry = updated.video.mlx.find((m) => m.id === NEW_ID);
    expect(entry).toBeDefined();
    // The row rides the EXISTING fastvideo runtime; `fastvideoFamily` is what
    // routes it to the FastH3 entry script. A new runtime id here would mean
    // an unprovisioned venv and an unrenderable entry.
    expect(entry.runtime).toBe('fastvideo');
    expect(entry.fastvideoFamily).toBe('fasth3');
    // Pinned: the pack is a specific conversion of a specific source revision.
    expect(entry.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(entry.supportedModes).toEqual(['text']);
    expect(entry.steps).toBe(4);
    // The UI reads its frame/fps/capability limits straight off the entry, so
    // an upgraded install must receive them too — not just a fresh seed.
    expect(entry.frameOptions.every((f) => (f - 5) % 17 === 0)).toBe(true);
    expect(entry.frameOptions).toContain(entry.defaultFrames);
    expect(entry.fpsOptions).toEqual([24]);
    expect(entry.supportsNegativePrompt).toBe(false);
    expect(entry.supportsTiling).toBe(false);
    expect(entry.supportsDisableAudio).toBe(false);
    expect(updated._shippedDefaults.video.mlx).toContain(NEW_ID);
  });

  it('leaves the CUDA bucket untouched', async () => {
    write({ video: { mlx: [], cuda: [{ id: 'ltx_video' }] } });

    await migration.up({ rootDir });

    expect(read().video.cuda.map((m) => m.id)).toEqual(['ltx_video']);
  });

  it('is idempotent when run multiple times', async () => {
    write({ video: { mlx: [{ id: 'fastmetal_1_3b_qad' }] } });

    await migration.up({ rootDir });
    const firstPass = readFileSync(registryFile, 'utf-8');
    await migration.up({ rootDir });

    expect(readFileSync(registryFile, 'utf-8')).toBe(firstPass);
  });

  it('does not re-add a row the user deleted from the shipped list only', async () => {
    // A user who removed the entry but kept the shipped-defaults marker must
    // not have it pushed back on the next upgrade.
    write({
      video: { mlx: [{ id: NEW_ID, name: 'edited by user', runtime: 'fastvideo' }] },
      _shippedDefaults: { video: { mlx: [NEW_ID] } },
    });

    await migration.up({ rootDir });

    const mlx = read().video.mlx;
    expect(mlx).toHaveLength(1);
    expect(mlx[0].name).toBe('edited by user');
  });
});
