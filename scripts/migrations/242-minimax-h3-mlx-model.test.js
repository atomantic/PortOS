import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './242-minimax-h3-mlx-model.js';

const H3_ID = 'minimax_h3_8bit';
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

describe('migration 242 — MiniMax H3 MLX model', () => {
  let rootDir;
  let path;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-242-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    path = join(rootDir, 'data', 'media-models.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('adds H3 to a pre-snapshot registry and bootstraps a deletion-safe shipped list', async () => {
    const before = legacyRegistry();
    writeJson(path, before);
    await migration.up({ rootDir });

    const got = readJson(path);
    expect(got.video.macos[0]).toEqual(before.video.macos[0]);
    expect(got.video.defaultMacos).toBe('ltx23_distilled_q4');
    expect(got.image).toEqual(before.image);
    const h3 = got.video.macos.find((entry) => entry.id === H3_ID);
    expect(h3).toMatchObject({
      repo: 'pipenetwork/MiniMax-H3-MLX-8bit',
      revision: '3ac52081470b0488921c3ec3ba84a39097bf2361',
      runtime: 'minimax_h3',
      termsGate: { id: 'minimax-h3-community-license-2026-08-02' },
    });
    // The snapshot it creates uses the canonical #4142 keys even though the
    // registry it read is still legacy-keyed — mediaModels.js reads either.
    expect(got._shippedDefaults.video.mlx).toContain(H3_ID);
    expect(got._shippedDefaults.video.mlx).toContain('ltx23_unified');
    expect(got._shippedDefaults.video.cuda).toContain('ltx_video');
  });

  it('adds and records H3 when a post-snapshot registry has not received it', async () => {
    const config = legacyRegistry();
    config._shippedDefaults = { video: { macos: ['ltx23_distilled_q4'], windows: ['ltx_video'] } };
    writeJson(path, config);
    await migration.up({ rootDir });
    const got = readJson(path);
    expect(got.video.macos.filter((entry) => entry.id === H3_ID)).toHaveLength(1);
    expect(got._shippedDefaults.video.macos).toContain(H3_ID);
  });

  it('preserves an existing customized H3 row while recording its id', async () => {
    const config = legacyRegistry();
    const custom = { id: H3_ID, name: 'My H3 profile', repo: 'example-org/h3-fork', steps: 5 };
    config.video.macos.push(custom);
    config._shippedDefaults = { video: { macos: ['ltx23_distilled_q4'], windows: ['ltx_video'] } };
    writeJson(path, config);
    await migration.up({ rootDir });
    const got = readJson(path);
    expect(got.video.macos.find((entry) => entry.id === H3_ID)).toEqual(custom);
    expect(got._shippedDefaults.video.macos).toContain(H3_ID);
  });

  it('does not recreate H3 after a recorded user deletion', async () => {
    const config = legacyRegistry();
    config._shippedDefaults = { video: { macos: ['ltx23_distilled_q4', H3_ID], windows: ['ltx_video'] } };
    writeJson(path, config);
    await migration.up({ rootDir });
    expect(readJson(path).video.macos.some((entry) => entry.id === H3_ID)).toBe(false);
  });

  it('is idempotent', async () => {
    writeJson(path, legacyRegistry());
    await migration.up({ rootDir });
    const once = readFileSync(path, 'utf-8');
    await migration.up({ rootDir });
    expect(readFileSync(path, 'utf-8')).toBe(once);
  });

  it('skips silently when the installed registry is missing', async () => {
    await migration.up({ rootDir });
    expect(existsSync(path)).toBe(false);
  });

  it('throws a clear error for malformed installed JSON', async () => {
    writeFileSync(path, '{not-json');
    await expect(migration.up({ rootDir })).rejects.toThrow(/invalid JSON/);
  });
});
