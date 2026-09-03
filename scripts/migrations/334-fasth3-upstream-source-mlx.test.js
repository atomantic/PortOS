import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import migration from './334-fasth3-upstream-source-mlx.js';

const NEW_IDS = ['fasth3_dense_datafree_int8', 'fasth3_dense_datafree_int6', 'fasth3_dense_datafree_int4'];
const SOURCE_REPO = 'FastVideo/FastVideo-FastH3-4-step-Preview-v1-Dense-DataFree';

describe('334-fasth3-upstream-source-mlx migration', () => {
  let rootDir;
  let registryFile;

  beforeEach(() => {
    rootDir = join(tmpdir(), `portos-test-334-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  it('adds all three format rows to an existing MLX registry and its shipped list', async () => {
    write({
      video: { mlx: [{ id: 'fastmetal_1_3b_qad', name: 'FastMetal 1.3B' }], cuda: [] },
      _shippedDefaults: { video: { mlx: ['fastmetal_1_3b_qad'] } },
    });

    await migration.up({ rootDir });

    const updated = read();
    for (const id of NEW_IDS) {
      const entry = updated.video.mlx.find((m) => m.id === id);
      expect(entry).toBeDefined();
      // All three rows are ONE download differing only by a local conversion,
      // so they must name the same pinned snapshot.
      expect(entry.repo).toBe(SOURCE_REPO);
      expect(entry.revision).toMatch(/^[0-9a-f]{40}$/);
      // The row rides the EXISTING fastvideo runtime; `fastvideoFamily` routes
      // it to the FastH3 entry script and `fastvideoMlxFormat` is what makes
      // the helper convert the snapshot's bf16 transformer before rendering.
      expect(entry.runtime).toBe('fastvideo');
      expect(entry.fastvideoFamily).toBe('fasth3');
      expect(entry.fastvideoMlxFormat).toBe(id.split('_').pop());
      // The UI reads its frame/fps/capability limits straight off the entry, so
      // an upgraded install must receive them too — not just a fresh seed.
      expect(entry.frameOptions.every((f) => (f - 5) % 17 === 0)).toBe(true);
      expect(entry.frameOptions).toContain(entry.defaultFrames);
      expect(entry.fpsOptions).toEqual([24]);
      expect(entry.supportsNegativePrompt).toBe(false);
      expect(entry.supportsTiling).toBe(false);
      expect(entry.supportsDisableAudio).toBe(false);
      expect(updated._shippedDefaults.video.mlx).toContain(id);
    }
  });

  it('leaves the pre-converted repack row from migration 333 otherwise in place', async () => {
    write({ video: { mlx: [{ id: 'fasth3_dense_datafree_mlx_int4', repo: 'MrMofer/x' }] } });

    await migration.up({ rootDir });

    const packed = read().video.mlx.find((m) => m.id === 'fasth3_dense_datafree_mlx_int4');
    expect(packed).toEqual({ id: 'fasth3_dense_datafree_mlx_int4', repo: 'MrMofer/x' });
  });

  it('drops the two out-of-window frame counts migration 333 shipped', async () => {
    // 107 is 4.46 s and 362 is 15.08 s at FastH3's fixed 24 fps; the pipeline
    // refuses both, so they were a broken value at each end of the picker.
    write({
      video: {
        mlx: [{
          id: 'fasth3_dense_datafree_mlx_int4',
          frameOptions: [107, 124, 141, 158, 175, 192, 209, 226, 243, 260, 277, 294, 311, 328, 345, 362],
        }],
      },
    });

    await migration.up({ rootDir });

    const packed = read().video.mlx.find((m) => m.id === 'fasth3_dense_datafree_mlx_int4');
    expect(packed.frameOptions).not.toContain(107);
    expect(packed.frameOptions).not.toContain(362);
    expect(packed.frameOptions.every((f) => f / 24 >= 5 && f / 24 <= 15)).toBe(true);
  });

  it('keeps a user own frame options rather than overwriting them', async () => {
    write({ video: { mlx: [{ id: 'fasth3_dense_datafree_mlx_int4', frameOptions: [124, 141] }] } });

    await migration.up({ rootDir });

    expect(read().video.mlx.find((m) => m.id === 'fasth3_dense_datafree_mlx_int4').frameOptions)
      .toEqual([124, 141]);
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
    write({
      video: { mlx: [{ id: NEW_IDS[0], name: 'edited by user', runtime: 'fastvideo' }] },
      _shippedDefaults: { video: { mlx: NEW_IDS } },
    });

    await migration.up({ rootDir });

    expect(read().video.mlx.filter((m) => m.id === NEW_IDS[0])).toEqual([
      { id: NEW_IDS[0], name: 'edited by user', runtime: 'fastvideo' },
    ]);
  });
});
