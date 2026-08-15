import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './271-minimax-h3-mlx-denoising-count.js';

const H3_ID = 'minimax_h3_8bit';
const OLD_NOTE = 'MiniMax H3 is CFG-distilled; this profile locks the validated 8-point sigma schedule and does not use CFG.';
const NEW_NOTE = 'MiniMax H3 is CFG-distilled; this profile locks the MLX reference 9-point sigma schedule (8 DiT forwards) and does not use CFG.';

const h3 = (extra = {}) => ({
  id: H3_ID,
  repo: 'pipenetwork/MiniMax-H3-MLX-8bit',
  steps: 8,
  guidance: 0,
  samplerLocked: true,
  samplerNote: OLD_NOTE,
  ...extra,
});

const registryWith = (entry) => ({
  video: { macos: entry ? [entry] : [], windows: [] },
  image: [],
});

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 271 — MiniMax H3 MLX denoising count', () => {
  let rootDir;
  let path;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-271-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    path = join(rootDir, 'data', 'media-models.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('updates the old shipped sampler contract to eight forwards', async () => {
    writeJson(path, registryWith(h3()));
    await migration.up({ rootDir });

    expect(readJson(path).video.macos[0]).toMatchObject({
      steps: 9,
      samplerNote: NEW_NOTE,
    });
  });

  it('is idempotent', async () => {
    writeJson(path, registryWith(h3()));
    await migration.up({ rootDir });
    const once = readFileSync(path, 'utf-8');
    await migration.up({ rootDir });
    expect(readFileSync(path, 'utf-8')).toBe(once);
  });

  it('preserves customized sampler settings and repointed rows', async () => {
    const custom = { ...h3({ steps: 12, samplerNote: 'local experiment' }) };
    writeJson(path, registryWith(custom));
    await migration.up({ rootDir });
    expect(readJson(path)).toEqual(registryWith(custom));

    const repointed = h3({ repo: 'example-org/h3-fork' });
    writeJson(path, registryWith(repointed));
    await migration.up({ rootDir });
    expect(readJson(path)).toEqual(registryWith(repointed));
  });

  it('does nothing when the registry or shipped row is absent', async () => {
    await expect(migration.up({ rootDir })).resolves.toBeUndefined();
    writeJson(path, registryWith(null));
    await migration.up({ rootDir });
    expect(readJson(path)).toEqual(registryWith(null));
  });
});
