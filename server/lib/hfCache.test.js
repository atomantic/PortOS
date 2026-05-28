import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectModelCache, getHfCacheRoot, isModelCached } from './hfCache.js';

// Build a fake HF cache layout under tmp so we can assert the inspector
// without touching the user's real ~/.cache/huggingface/hub. Snapshot files
// are symlinked into ../../blobs/ exactly as huggingface_hub writes them.
function buildFakeCache({ repoId, snapshots, partial = false }) {
  const root = mkdtempSync(join(tmpdir(), 'hfcache-test-'));
  const repoDir = join(root, `models--${repoId.replace(/\//g, '--')}`);
  const blobsDir = join(repoDir, 'blobs');
  mkdirSync(blobsDir, { recursive: true });
  for (const [sha, files] of Object.entries(snapshots)) {
    const snapDir = join(repoDir, 'snapshots', sha);
    mkdirSync(snapDir, { recursive: true });
    for (const [filename, bytes] of Object.entries(files)) {
      const blobName = `${sha}-${filename}.blob`;
      const blobPath = join(blobsDir, blobName);
      if (!(partial && filename.endsWith('.safetensors'))) {
        writeFileSync(blobPath, Buffer.alloc(bytes));
      }
      symlinkSync(blobPath, join(snapDir, filename));
    }
  }
  return { root, repoDir };
}

describe('hfCache', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = {
      HF_HUB_CACHE: process.env.HF_HUB_CACHE,
      HF_HOME: process.env.HF_HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    };
  });

  afterEach(() => {
    for (const key of Object.keys(originalEnv)) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it('resolves cache root with precedence HF_HUB_CACHE > HF_HOME/hub > XDG_CACHE_HOME/huggingface/hub > ~/.cache', () => {
    process.env.HF_HUB_CACHE = '/explicit/hub';
    expect(getHfCacheRoot()).toBe('/explicit/hub');

    delete process.env.HF_HUB_CACHE;
    process.env.HF_HOME = '/custom/hf';
    expect(getHfCacheRoot()).toBe('/custom/hf/hub');

    delete process.env.HF_HOME;
    process.env.XDG_CACHE_HOME = '/xdg/cache';
    expect(getHfCacheRoot()).toBe('/xdg/cache/huggingface/hub');

    delete process.env.XDG_CACHE_HOME;
    expect(getHfCacheRoot()).toMatch(/\.cache\/huggingface\/hub$/);
  });

  it('reports cached=false for missing repo dir', async () => {
    process.env.HF_HUB_CACHE = mkdtempSync(join(tmpdir(), 'hfcache-empty-'));
    const result = await inspectModelCache('foo/bar');
    expect(result.cached).toBe(false);
    expect(result.sizeBytes).toBe(0);
    rmSync(process.env.HF_HUB_CACHE, { recursive: true, force: true });
  });

  it('reports cached=true and sums weight-file sizes when snapshot is complete', async () => {
    const { root } = buildFakeCache({
      repoId: 'org/model',
      snapshots: {
        'abc123': {
          'config.json': 1024,
          'model.safetensors': 4096,
          'tokenizer.json': 512,
        },
      },
    });
    process.env.HF_HUB_CACHE = root;
    const result = await inspectModelCache('org/model');
    expect(result.cached).toBe(true);
    expect(result.sizeBytes).toBe(4096); // weight files only, config/tokenizer excluded
    expect(result.snapshotPath).toContain('snapshots/abc123');
    rmSync(root, { recursive: true, force: true });
  });

  it('reports cached=false when snapshot has no weight files (config-only stub)', async () => {
    const { root } = buildFakeCache({
      repoId: 'org/configonly',
      snapshots: { 'sha1': { 'config.json': 200 } },
    });
    process.env.HF_HUB_CACHE = root;
    expect((await inspectModelCache('org/configonly')).cached).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('reports cached=false for partial download (dangling weight symlink)', async () => {
    const { root } = buildFakeCache({
      repoId: 'org/partial',
      snapshots: {
        'sha2': { 'config.json': 200, 'model.safetensors': 4096 },
      },
      partial: true,
    });
    process.env.HF_HUB_CACHE = root;
    expect((await inspectModelCache('org/partial')).cached).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('walks nested snapshot subdirectories (e.g. text_encoder/model.safetensors)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hfcache-nested-'));
    const repoDir = join(root, 'models--org--nested');
    const blobs = join(repoDir, 'blobs');
    const snap = join(repoDir, 'snapshots', 'shaN');
    mkdirSync(blobs, { recursive: true });
    mkdirSync(join(snap, 'text_encoder'), { recursive: true });
    const blobPath = join(blobs, 'encoder.blob');
    writeFileSync(blobPath, Buffer.alloc(8192));
    symlinkSync(blobPath, join(snap, 'text_encoder', 'model.safetensors'));
    process.env.HF_HUB_CACHE = root;
    const result = await inspectModelCache('org/nested');
    expect(result.cached).toBe(true);
    expect(result.sizeBytes).toBe(8192);
    rmSync(root, { recursive: true, force: true });
  });

  it('isModelCached is a boolean wrapper', async () => {
    process.env.HF_HUB_CACHE = mkdtempSync(join(tmpdir(), 'hfcache-bool-'));
    expect(await isModelCached('does/notexist')).toBe(false);
    rmSync(process.env.HF_HUB_CACHE, { recursive: true, force: true });
  });

  it('returns cached=false for empty/invalid repoId without throwing', async () => {
    expect((await inspectModelCache('')).cached).toBe(false);
    expect((await inspectModelCache(null)).cached).toBe(false);
    expect((await inspectModelCache(undefined)).cached).toBe(false);
  });
});
