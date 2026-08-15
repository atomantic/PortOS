import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './270-video-registry-mlx-cuda-buckets.js';

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const legacyRegistry = () => ({
  _doc: 'PortOS media model registry.',
  video: {
    macos: [{ id: 'ltx23_distilled_q4', name: 'My tuned default', steps: 17 }],
    windows: [{ id: 'ltx_video', name: 'LTX' }],
    defaultMacos: 'ltx23_distilled_q4',
    defaultWindows: 'ltx_video',
  },
  image: [{ id: 'my-image', name: 'My image model' }],
  textEncoders: [{ id: 't', label: 't', repo: 'r' }],
  selectedTextEncoder: 't',
  _shippedDefaults: {
    video: { macos: ['ltx23_distilled_q4'], windows: ['ltx_video'] },
    image: { list: ['my-image'] },
  },
});

describe('migration 270 — video registry mlx/cuda buckets', () => {
  let rootDir;
  let path;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-270-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    path = join(rootDir, 'data', 'media-models.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('renames both buckets, both defaults, and the shipped snapshot', async () => {
    const before = legacyRegistry();
    writeJson(path, before);
    await migration.up({ rootDir });

    const got = readJson(path);
    expect(Object.keys(got.video).sort()).toEqual(['cuda', 'defaultCuda', 'defaultMlx', 'mlx']);
    expect(got.video.mlx).toEqual(before.video.macos);
    expect(got.video.cuda).toEqual(before.video.windows);
    expect(got.video.defaultMlx).toBe('ltx23_distilled_q4');
    expect(got.video.defaultCuda).toBe('ltx_video');
    expect(got._shippedDefaults.video).toEqual({ mlx: ['ltx23_distilled_q4'], cuda: ['ltx_video'] });
  });

  it('touches nothing else in the file', async () => {
    const before = legacyRegistry();
    writeJson(path, before);
    await migration.up({ rootDir });

    const got = readJson(path);
    expect(got._doc).toBe(before._doc);
    expect(got.image).toEqual(before.image);
    expect(got.textEncoders).toEqual(before.textEncoders);
    expect(got.selectedTextEncoder).toBe(before.selectedTextEncoder);
    expect(got._shippedDefaults.image).toEqual(before._shippedDefaults.image);
  });

  it('is a no-op on an already-canonical registry', async () => {
    writeJson(path, legacyRegistry());
    await migration.up({ rootDir });
    const once = readFileSync(path, 'utf-8');

    await migration.up({ rootDir });
    expect(readFileSync(path, 'utf-8')).toBe(once);
  });

  it('renames the video section even when there is no shipped snapshot yet', async () => {
    const { _shippedDefaults: _omit, ...noSnapshot } = legacyRegistry();
    writeJson(path, noSnapshot);
    await migration.up({ rootDir });

    const got = readJson(path);
    expect(got.video.mlx).toHaveLength(1);
    expect(got._shippedDefaults).toBeUndefined();
  });

  // Half-migrated shapes are reachable: mediaModels.js canonicalizes on load,
  // and migration 242 writes a canonical snapshot onto a legacy-keyed registry.
  it('finishes a partially renamed registry without duplicating a bucket', async () => {
    const config = legacyRegistry();
    config._shippedDefaults.video = { mlx: ['ltx23_distilled_q4'], cuda: ['ltx_video'] };
    writeJson(path, config);
    await migration.up({ rootDir });

    const got = readJson(path);
    expect(Object.keys(got.video).sort()).toEqual(['cuda', 'defaultCuda', 'defaultMlx', 'mlx']);
    expect(got._shippedDefaults.video).toEqual({ mlx: ['ltx23_distilled_q4'], cuda: ['ltx_video'] });
  });

  it('does nothing when the registry file is absent', async () => {
    await expect(migration.up({ rootDir })).resolves.toBeUndefined();
  });

  it('leaves an unparseable registry alone', async () => {
    writeFileSync(path, '{ not json');
    await expect(migration.up({ rootDir })).resolves.toBeUndefined();
    expect(readFileSync(path, 'utf-8')).toBe('{ not json');
  });
});
