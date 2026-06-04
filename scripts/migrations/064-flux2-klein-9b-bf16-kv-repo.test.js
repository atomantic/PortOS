import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './064-flux2-klein-9b-bf16-kv-repo.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const SHIPPED_REPO = 'black-forest-labs/FLUX.2-klein-9B';
const KV_REPO = 'black-forest-labs/FLUX.2-klein-9B-kv';

const baseRegistry = (entry = {}) => ({
  image: [
    { id: 'dev', name: 'Flux 1 Dev' },
    {
      id: 'flux2-klein-9b-bf16',
      name: 'Flux 2 Klein 9B (bf16)',
      runner: 'flux2',
      quantization: 'none',
      repo: SHIPPED_REPO,
      ...entry,
    },
  ],
});

describe('migration 064 — flux2-klein-9b-bf16 kvRepo', () => {
  let rootDir;
  let path;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-064-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    path = join(rootDir, 'data', 'media-models.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('adds kvRepo to the bf16 entry when absent and repo matches the shipped default', async () => {
    writeJson(path, baseRegistry());
    await migration.up({ rootDir });
    const entry = readJson(path).image.find((e) => e.id === 'flux2-klein-9b-bf16');
    expect(entry.kvRepo).toBe(KV_REPO);
  });

  it('is idempotent — a second run leaves an already-present kvRepo alone', async () => {
    writeJson(path, baseRegistry({ kvRepo: KV_REPO }));
    const before = readFileSync(path, 'utf-8');
    await migration.up({ rootDir });
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  it('preserves a user-customized kvRepo (even empty-string clear)', async () => {
    writeJson(path, baseRegistry({ kvRepo: '' }));
    await migration.up({ rootDir });
    const entry = readJson(path).image.find((e) => e.id === 'flux2-klein-9b-bf16');
    expect(entry.kvRepo).toBe('');
  });

  it('leaves the entry alone when repo points at a fork (not the shipped default)', async () => {
    writeJson(path, baseRegistry({ repo: 'my-fork/FLUX.2-klein-9B' }));
    await migration.up({ rootDir });
    const entry = readJson(path).image.find((e) => e.id === 'flux2-klein-9b-bf16');
    expect('kvRepo' in entry).toBe(false);
  });

  it('skips silently when data/media-models.json is missing (fresh install)', async () => {
    await migration.up({ rootDir });
    expect(existsSync(path)).toBe(false);
  });

  it('skips when the flux2-klein-9b-bf16 entry has been removed', async () => {
    writeJson(path, { image: [{ id: 'dev', name: 'Flux 1 Dev' }] });
    await migration.up({ rootDir });
    const got = readJson(path);
    expect(got.image.find((e) => e.id === 'flux2-klein-9b-bf16')).toBeUndefined();
  });

  it('skips when image[] is missing entirely', async () => {
    writeJson(path, { textEncoders: [] });
    await migration.up({ rootDir });
    expect(readJson(path)).toEqual({ textEncoders: [] });
  });
});
