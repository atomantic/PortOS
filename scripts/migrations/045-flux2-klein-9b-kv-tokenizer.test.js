import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './045-flux2-klein-9b-kv-tokenizer.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const OLD = 'black-forest-labs/FLUX.2-klein-9B';
const NEW = 'black-forest-labs/FLUX.2-klein-9B-kv';

const baseRegistry = (tokenizerRepo) => ({
  image: [
    { id: 'dev', name: 'Flux 1 Dev' },
    {
      id: 'flux2-klein-9b',
      name: 'Flux 2 Klein 9B',
      runner: 'flux2',
      quantization: 'sdnq',
      repo: 'Disty0/FLUX.2-klein-9B-SDNQ-4bit-dynamic-svd-r32',
      tokenizerRepo,
    },
  ],
});

describe('migration 045 — flux2-klein-9b kv tokenizerRepo', () => {
  let rootDir;
  let path;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-045-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    path = join(rootDir, 'data', 'media-models.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('swaps the pre-change tokenizerRepo to the kv repo', async () => {
    writeJson(path, baseRegistry(OLD));
    await migration.up({ rootDir });
    const got = readJson(path);
    const entry = got.image.find((e) => e.id === 'flux2-klein-9b');
    expect(entry.tokenizerRepo).toBe(NEW);
  });

  it('is idempotent — a second run leaves the new value alone', async () => {
    writeJson(path, baseRegistry(NEW));
    const beforeMtime = readFileSync(path, 'utf-8');
    await migration.up({ rootDir });
    expect(readFileSync(path, 'utf-8')).toBe(beforeMtime);
  });

  it('preserves a user-customized tokenizerRepo', async () => {
    writeJson(path, baseRegistry('my-fork/flux2-tokenizer'));
    await migration.up({ rootDir });
    const entry = readJson(path).image.find((e) => e.id === 'flux2-klein-9b');
    expect(entry.tokenizerRepo).toBe('my-fork/flux2-tokenizer');
  });

  it('skips silently when data/media-models.json is missing (fresh install)', async () => {
    await migration.up({ rootDir });
    expect(existsSync(path)).toBe(false);
  });

  it('skips when the flux2-klein-9b entry has been removed', async () => {
    writeJson(path, { image: [{ id: 'dev', name: 'Flux 1 Dev' }] });
    await migration.up({ rootDir });
    const got = readJson(path);
    expect(got.image.find((e) => e.id === 'flux2-klein-9b')).toBeUndefined();
  });

  it('skips when image[] is missing entirely', async () => {
    writeJson(path, { textEncoders: [] });
    await migration.up({ rootDir });
    expect(readJson(path)).toEqual({ textEncoders: [] });
  });
});
