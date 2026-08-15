import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import migration from './267-minimax-h3-native-output-controls.js';

const H3_ID = 'minimax_h3_8bit';
const REFERENCE_PATH = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', 'data.reference', 'media-models.json',
);
const OLD_FRAMES = [124, 141, 158, 175, 192, 209, 226, 243, 260, 277, 294, 311, 328, 345, 362];
const h3 = () => ({
  id: H3_ID,
  repo: 'pipenetwork/MiniMax-H3-MLX-8bit',
  defaultFrames: 124,
  frameOptions: [...OLD_FRAMES],
});
const registryWith = (entry) => ({
  video: { macos: entry ? [entry] : [], windows: [] },
  image: [],
});
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 267 — MiniMax H3 native output controls', () => {
  let rootDir;
  let path;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-267-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    path = join(rootDir, 'data', 'media-models.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('adds the 4-second grid point and exact native canvas contract', async () => {
    writeJson(path, registryWith(h3()));
    await migration.up({ rootDir });

    const migrated = readJson(path).video.macos[0];
    expect(migrated.defaultFrames).toBe(124);
    expect(migrated.frameOptions).toEqual([107, ...OLD_FRAMES]);
    expect(migrated).toMatchObject({
      defaultWidth: 1344,
      defaultHeight: 768,
      resolutionStep: 32,
    });
    expect(migrated.resolutionOptions).toEqual([
      { label: '1536x672 (21:9 H3 native)', w: 1536, h: 672 },
      { label: '1344x768 (16:9 H3 default)', w: 1344, h: 768 },
      { label: '1024x768 (4:3 H3 native)', w: 1024, h: 768 },
      { label: '768x768 (1:1 H3 native)', w: 768, h: 768 },
      { label: '768x1024 (3:4 H3 native)', w: 768, h: 1024 },
      { label: '768x1344 (9:16 H3 native)', w: 768, h: 1344 },
    ]);
    const seeded = JSON.parse(readFileSync(REFERENCE_PATH, 'utf-8'))
      .video.mlx.find((entry) => entry.id === H3_ID);
    expect({
      defaultFrames: migrated.defaultFrames,
      frameOptions: migrated.frameOptions,
      defaultWidth: migrated.defaultWidth,
      defaultHeight: migrated.defaultHeight,
      resolutionStep: migrated.resolutionStep,
      resolutionOptions: migrated.resolutionOptions,
    }).toEqual({
      defaultFrames: seeded.defaultFrames,
      frameOptions: seeded.frameOptions,
      defaultWidth: seeded.defaultWidth,
      defaultHeight: seeded.defaultHeight,
      resolutionStep: seeded.resolutionStep,
      resolutionOptions: seeded.resolutionOptions,
    });
  });

  it('is idempotent', async () => {
    writeJson(path, registryWith(h3()));
    await migration.up({ rootDir });
    const once = readJson(path);
    await migration.up({ rootDir });
    expect(readJson(path)).toEqual(once);
  });

  it('preserves customized frames and resolution fields', async () => {
    const custom = {
      ...h3(),
      frameOptions: [124, 243],
      defaultWidth: 1024,
      defaultHeight: 576,
      resolutionStep: 64,
      resolutionOptions: [],
    };
    writeJson(path, registryWith(custom));
    await migration.up({ rootDir });
    expect(readJson(path)).toEqual(registryWith(custom));
  });

  it('does not mix shipped presets with a partially customized geometry contract', async () => {
    const customStep = { ...h3(), resolutionStep: 64 };
    writeJson(path, registryWith(customStep));
    await migration.up({ rootDir });
    const withCustomStep = readJson(path).video.macos[0];
    expect(withCustomStep.resolutionStep).toBe(64);
    expect(withCustomStep).not.toHaveProperty('resolutionOptions');

    const customOptions = { ...h3(), resolutionOptions: [] };
    writeJson(path, registryWith(customOptions));
    await migration.up({ rootDir });
    const withCustomOptions = readJson(path).video.macos[0];
    expect(withCustomOptions).not.toHaveProperty('resolutionStep');
    expect(withCustomOptions.resolutionOptions).toEqual([]);
  });

  it('skips a user-repointed or deleted entry and a missing registry', async () => {
    const forked = { ...h3(), repo: 'example-org/h3-fork' };
    writeJson(path, registryWith(forked));
    await migration.up({ rootDir });
    expect(readJson(path)).toEqual(registryWith(forked));

    writeJson(path, registryWith(null));
    await migration.up({ rootDir });
    expect(readJson(path)).toEqual(registryWith(null));

    rmSync(path);
    await expect(migration.up({ rootDir })).resolves.toBeUndefined();
  });
});
