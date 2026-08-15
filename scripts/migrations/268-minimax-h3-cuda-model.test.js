import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import migration242 from './242-minimax-h3-mlx-model.js';
import migration from './268-minimax-h3-cuda-model.js';

const CUDA_ID = 'minimax_h3_cuda';
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const legacyRegistry = () => ({
  video: {
    macos: [{ id: 'ltx23_distilled_q4', name: 'My tuned default', steps: 17 }],
    windows: [{ id: 'ltx_video', name: 'LTX Windows' }],
    defaultMacos: 'ltx23_distilled_q4',
    defaultWindows: 'ltx_video',
  },
  image: [{ id: 'my-image', name: 'My image model' }],
});

describe('migration 268 — MiniMax H3 CUDA model', () => {
  let rootDir;
  let path;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-268-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    path = join(rootDir, 'data', 'media-models.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('adds and records the CUDA profile when a snapshot registry has not received it', async () => {
    const config = legacyRegistry();
    config._shippedDefaults = { video: { macos: ['ltx23_distilled_q4'], windows: ['ltx_video'] } };
    writeJson(path, config);
    await migration.up({ rootDir });

    const got = readJson(path);
    const cuda = got.video.windows.find((entry) => entry.id === CUDA_ID);
    expect(cuda).toMatchObject({
      repo: 'MiniMaxAI/MiniMax-H3',
      revision: '42ed227ee7df40d41602854ae760620d6eb651fe',
      runtime: 'minimax_h3_cuda',
      termsGate: { id: 'minimax-h3-community-license-2026-08-02' },
    });
    expect(cuda.repoFiles.length).toBeGreaterThan(0);
    expect(got._shippedDefaults.video.windows).toContain(CUDA_ID);
    // The user's own rows and the rest of the registry are untouched.
    expect(got.video.windows[0]).toEqual(config.video.windows[0]);
    expect(got.video.macos).toEqual(config.video.macos);
    expect(got.image).toEqual(config.image);
  });

  it('is idempotent', async () => {
    const config = legacyRegistry();
    config._shippedDefaults = { video: { macos: [], windows: ['ltx_video'] } };
    writeJson(path, config);
    await migration.up({ rootDir });
    await migration.up({ rootDir });
    const got = readJson(path);
    expect(got.video.windows.filter((entry) => entry.id === CUDA_ID)).toHaveLength(1);
    expect(got._shippedDefaults.video.windows.filter((id) => id === CUDA_ID)).toHaveLength(1);
  });

  it('respects a deliberate deletion — a recorded-but-absent id stays absent', async () => {
    const config = legacyRegistry();
    config._shippedDefaults = { video: { macos: [], windows: ['ltx_video', CUDA_ID] } };
    writeJson(path, config);
    await migration.up({ rootDir });
    const got = readJson(path);
    expect(got.video.windows.some((entry) => entry.id === CUDA_ID)).toBe(false);
  });

  it('never overwrites a user-customized row', async () => {
    const config = legacyRegistry();
    config.video.windows.push({ id: CUDA_ID, name: 'My tuned H3 CUDA', steps: 4 });
    config._shippedDefaults = { video: { macos: [], windows: ['ltx_video'] } };
    writeJson(path, config);
    await migration.up({ rootDir });
    const got = readJson(path);
    const rows = got.video.windows.filter((entry) => entry.id === CUDA_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ id: CUDA_ID, name: 'My tuned H3 CUDA', steps: 4 });
  });

  it('leaves a registry with no snapshot key to 242, which owns creating it', async () => {
    writeJson(path, legacyRegistry());
    await migration.up({ rootDir });
    const got = readJson(path);
    expect(got._shippedDefaults).toBeUndefined();
    expect(got.video.windows.some((entry) => entry.id === CUDA_ID)).toBe(true);
  });

  it('is not suppressed by 242 running first on a pre-snapshot registry', async () => {
    // The regression this pair exists for: 242's bootstrap used to union the
    // user's ids with TODAY's data.reference, so it recorded this entry as
    // already-shipped without ever adding it — and `appendNewlyShippedEntries`
    // reads a recorded id as a user deletion, suppressing the row forever.
    writeJson(path, legacyRegistry());
    await migration242.up({ rootDir });
    const afterMlx = readJson(path);
    // 242 writes the snapshot under the canonical #4142 keys.
    expect(afterMlx._shippedDefaults.video.cuda).not.toContain(CUDA_ID);

    await migration.up({ rootDir });
    const got = readJson(path);
    expect(got.video.windows.some((entry) => entry.id === CUDA_ID)).toBe(true);
    expect(got._shippedDefaults.video.cuda).toContain(CUDA_ID);
  });

  // A fresh install seeds data/media-models.json from the canonical-keyed
  // data.reference copy BEFORE any migration runs, so this family has to read
  // the post-#4142 spelling as readily as the legacy one it was written against.
  it('reads the canonical mlx/cuda bucket keys too', async () => {
    const { video, ...rest } = legacyRegistry();
    writeJson(path, {
      ...rest,
      video: { mlx: video.macos, cuda: video.windows, defaultMlx: video.defaultMacos, defaultCuda: video.defaultWindows },
      _shippedDefaults: { video: { mlx: [], cuda: ['ltx_video'] } },
    });
    await migration.up({ rootDir });

    const got = readJson(path);
    expect(got.video.cuda.some((entry) => entry.id === CUDA_ID)).toBe(true);
    expect(got.video.windows).toBeUndefined();
    expect(got._shippedDefaults.video.cuda).toContain(CUDA_ID);
  });

  it('does nothing when the registry file is absent', async () => {
    await expect(migration.up({ rootDir })).resolves.toBeUndefined();
  });
});
