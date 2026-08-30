import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import migration from './318-ltx25-a2v-duration.js';

const PINNED = {
  id: 'ltx25_mlx_q8',
  repo: 'MrMofer/ltx-2.5-mlx-q8',
  revision: 'f1b56e7dc89f71a9af2cddac787b89ed22a8b7fc',
};

describe('318-ltx25-a2v-duration migration', () => {
  let rootDir;

  beforeEach(() => {
    rootDir = join(tmpdir(), `portos-test-318-${Date.now()}`);
    mkdirSync(join(rootDir, 'data'), { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('adds only absent duration fields to the pinned shipped model', async () => {
    const initial = { video: { mlx: [{ ...PINNED, frameStride: 16 }], cuda: [] } };
    writeFileSync(join(rootDir, 'data', 'media-models.json'), JSON.stringify(initial));

    await migration.up({ rootDir });

    const updated = JSON.parse(readFileSync(join(rootDir, 'data', 'media-models.json'), 'utf-8'));
    expect(updated.video.mlx[0]).toMatchObject({
      ...PINNED,
      audioDurationDriven: true,
      frameStride: 16,
      maxNumFrames: 1017,
    });
  });

  it('preserves a repointed fork and is idempotent', async () => {
    const path = join(rootDir, 'data', 'media-models.json');
    writeFileSync(path, JSON.stringify({ video: { mlx: [{ ...PINNED, repo: 'example/ltx25-fork' }] } }));
    await migration.up({ rootDir });
    const first = readFileSync(path, 'utf-8');
    await migration.up({ rootDir });
    expect(readFileSync(path, 'utf-8')).toBe(first);
    expect(JSON.parse(first).video.mlx[0].audioDurationDriven).toBeUndefined();
  });
});
