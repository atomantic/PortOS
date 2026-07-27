import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, readlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectModelCache, getHfCacheRoot, isModelCached,
  verifyModelCache, repairModelCache, findCachedRepoFile, repairCachedFile,
} from './hfCache.js';

// Build a minimal *valid* .safetensors buffer: 8-byte LE header length, a JSON
// header declaring one tensor whose data_offsets span `dataLen` bytes, then the
// data region. `truncateBy` lops bytes off the end to simulate a partial fetch.
function buildSafetensors({ dataLen = 16, truncateBy = 0 } = {}) {
  const header = JSON.stringify({ t: { dtype: 'F32', shape: [dataLen / 4], data_offsets: [0, dataLen] } });
  const headerBuf = Buffer.from(header, 'utf8');
  const lenBuf = Buffer.alloc(8);
  lenBuf.writeBigUInt64LE(BigInt(headerBuf.length), 0);
  const data = Buffer.alloc(dataLen, 7);
  const full = Buffer.concat([lenBuf, headerBuf, data]);
  return truncateBy > 0 ? full.subarray(0, full.length - truncateBy) : full;
}

// Build a fake HF cache with real file contents (vs. the zero-filled blobs the
// inspect tests use). Each file is symlinked into the snapshot from a blob
// named by its sha256 — matching how HF names LFS blobs, which is what the deep
// sha256 check relies on. `blobName` overrides the blob name to force a
// sha256 mismatch.
function buildContentCache({ repoId, files }) {
  const root = mkdtempSync(join(tmpdir(), 'hfverify-test-'));
  const repoDir = join(root, `models--${repoId.replace(/\//g, '--')}`);
  const blobsDir = join(repoDir, 'blobs');
  const snapDir = join(repoDir, 'snapshots', 'sha');
  mkdirSync(blobsDir, { recursive: true });
  mkdirSync(snapDir, { recursive: true });
  for (const [filename, spec] of Object.entries(files)) {
    const content = spec.content;
    const sha = spec.blobName || createHash('sha256').update(content).digest('hex');
    const blobPath = join(blobsDir, sha);
    writeFileSync(blobPath, content);
    // Relative symlink mirrors HF's `../../blobs/<sha>` layout.
    symlinkSync(join('..', '..', 'blobs', sha), join(snapDir, filename));
  }
  return { root, repoDir, snapDir, blobsDir };
}

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

describe('verifyModelCache', () => {
  let originalEnv;
  const roots = [];
  beforeEach(() => { originalEnv = process.env.HF_HUB_CACHE; });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.HF_HUB_CACHE;
    else process.env.HF_HUB_CACHE = originalEnv;
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  it('returns status "missing" for a repo with no snapshot', async () => {
    process.env.HF_HUB_CACHE = mkdtempSync(join(tmpdir(), 'hfverify-empty-'));
    roots.push(process.env.HF_HUB_CACHE);
    const r = await verifyModelCache('foo/bar');
    expect(r.status).toBe('missing');
    expect(r.cached).toBe(false);
  });

  it('returns status "ok" for a structurally valid safetensors', async () => {
    const { root } = buildContentCache({
      repoId: 'org/good',
      files: { 'model.safetensors': { content: buildSafetensors({ dataLen: 32 }) } },
    });
    roots.push(root);
    process.env.HF_HUB_CACHE = root;
    const r = await verifyModelCache('org/good');
    expect(r.status).toBe('ok');
    expect(r.cached).toBe(true);
    expect(r.files).toHaveLength(1);
    expect(r.files[0].ok).toBe(true);
  });

  it('flags a truncated safetensors (right header, missing tail bytes) as bad', async () => {
    const { root } = buildContentCache({
      repoId: 'org/truncated',
      files: { 'model.safetensors': { content: buildSafetensors({ dataLen: 64, truncateBy: 16 }) } },
    });
    roots.push(root);
    process.env.HF_HUB_CACHE = root;
    const r = await verifyModelCache('org/truncated');
    expect(r.status).toBe('bad');
    expect(r.files[0].ok).toBe(false);
    expect(r.files[0].reason).toBe('truncated-data');
  });

  it('flags a garbage (non-safetensors) header as bad', async () => {
    const { root } = buildContentCache({
      repoId: 'org/garbage',
      files: { 'model.safetensors': { content: Buffer.alloc(4096, 0) } }, // header length 0
    });
    roots.push(root);
    process.env.HF_HUB_CACHE = root;
    const r = await verifyModelCache('org/garbage');
    expect(r.status).toBe('bad');
    expect(r.files[0].reason).toBe('bad-header-length');
  });

  it('flags a parseable-but-non-object header (e.g. JSON null) as bad without throwing', async () => {
    // Header length points at valid JSON `null` — Object.entries(null) would
    // throw, which must surface as status:'bad', not a 500.
    const headerBuf = Buffer.from('null', 'utf8');
    const lenBuf = Buffer.alloc(8);
    lenBuf.writeBigUInt64LE(BigInt(headerBuf.length), 0);
    const content = Buffer.concat([lenBuf, headerBuf, Buffer.alloc(8)]);
    const { root } = buildContentCache({
      repoId: 'org/nullheader',
      files: { 'model.safetensors': { content } },
    });
    roots.push(root);
    process.env.HF_HUB_CACHE = root;
    const r = await verifyModelCache('org/nullheader');
    expect(r.status).toBe('bad');
    expect(r.files[0].reason).toBe('unparseable-header');
  });

  it('deep check passes when content sha256 matches the blob name', async () => {
    const { root } = buildContentCache({
      repoId: 'org/deepok',
      files: { 'model.safetensors': { content: buildSafetensors({ dataLen: 16 }) } },
    });
    roots.push(root);
    process.env.HF_HUB_CACHE = root;
    const r = await verifyModelCache('org/deepok', { deep: true });
    expect(r.status).toBe('ok');
    expect(r.checkedDeep).toBe(true);
    expect(r.files[0].reason).toBe('sha256-ok');
  });

  it('deep check flags content whose sha256 differs from the blob name', async () => {
    const { root } = buildContentCache({
      repoId: 'org/deepbad',
      files: {
        // structurally valid, but stored under a wrong (mismatched) blob name
        'model.safetensors': { content: buildSafetensors({ dataLen: 16 }), blobName: 'a'.repeat(64) },
      },
    });
    roots.push(root);
    process.env.HF_HUB_CACHE = root;
    const structural = await verifyModelCache('org/deepbad');
    expect(structural.status).toBe('ok'); // structural alone can't catch wrong-bytes
    const deep = await verifyModelCache('org/deepbad', { deep: true });
    expect(deep.status).toBe('bad');
    expect(deep.files[0].reason).toBe('sha256-mismatch');
  });
});

describe('repairModelCache', () => {
  let originalEnv;
  const roots = [];
  beforeEach(() => { originalEnv = process.env.HF_HUB_CACHE; });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.HF_HUB_CACHE;
    else process.env.HF_HUB_CACHE = originalEnv;
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  it('deletes the corrupt file (symlink + blob) and leaves good files alone', async () => {
    const { root, snapDir, blobsDir } = buildContentCache({
      repoId: 'org/mixed',
      files: {
        'good.safetensors': { content: buildSafetensors({ dataLen: 32 }) },
        'bad.safetensors': { content: buildSafetensors({ dataLen: 64, truncateBy: 16 }) },
      },
    });
    roots.push(root);
    process.env.HF_HUB_CACHE = root;

    const badBlob = join(blobsDir, readlinkSync(join(snapDir, 'bad.safetensors')).split('/').pop());
    expect(existsSync(badBlob)).toBe(true);

    const result = await repairModelCache('org/mixed');
    expect(result.status).toBe('bad');
    expect(result.deleted).toEqual(['bad.safetensors']);
    // The bad symlink + blob are gone; the good file is untouched.
    expect(existsSync(join(snapDir, 'bad.safetensors'))).toBe(false);
    expect(existsSync(badBlob)).toBe(false);
    expect(existsSync(join(snapDir, 'good.safetensors'))).toBe(true);
  });

  it('is a no-op when integrity is already ok', async () => {
    const { root } = buildContentCache({
      repoId: 'org/clean',
      files: { 'model.safetensors': { content: buildSafetensors({ dataLen: 32 }) } },
    });
    roots.push(root);
    process.env.HF_HUB_CACHE = root;
    const result = await repairModelCache('org/clean');
    expect(result.status).toBe('ok');
    expect(result.deleted).toEqual([]);
  });
});

// ── Single-file probe + repair (#3112) ─────────────────────────────────────
// A weight can live inside an AGGREGATE repo: `DeepBeepMeep/LTX-2` mirrors every
// LTX weight in one ~708 GB repo. `inspectModelCache` recursively stats every
// weight in the snapshot, which there means hundreds of GB of files that have
// nothing to do with the one we asked for — so these two helpers answer the
// single-file questions without ever walking the snapshot.
describe('findCachedRepoFile', () => {
  let originalEnv;
  const cleanup = [];

  beforeEach(() => { originalEnv = process.env.HF_HUB_CACHE; });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.HF_HUB_CACHE;
    else process.env.HF_HUB_CACHE = originalEnv;
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const aggregateCache = ({ partial = false } = {}) => {
    const { root } = buildFakeCache({
      repoId: 'org/aggregate',
      snapshots: {
        sha1: {
          'wanted.safetensors': 1024,
          'unrelated-a.safetensors': 2048,
          'unrelated-b.safetensors': 4096,
        },
      },
      partial,
    });
    cleanup.push(root);
    process.env.HF_HUB_CACHE = root;
    return root;
  };

  it('resolves the requested file out of an aggregate repo', async () => {
    aggregateCache();
    const found = await findCachedRepoFile('org/aggregate', 'wanted.safetensors');
    expect(found).toMatch(/snapshots\/sha1\/wanted\.safetensors$/);
  });

  it('returns null for a file the repo has not fetched, even though siblings exist', async () => {
    // The precise failure this exists to prevent: inspectModelCache would report
    // the repo `cached` off the unrelated siblings and the caller would skip a
    // download for a weight the user does NOT have.
    aggregateCache();
    expect(await findCachedRepoFile('org/aggregate', 'never-fetched.safetensors')).toBeNull();
    expect((await inspectModelCache('org/aggregate')).cached).toBe(true);
  });

  it('returns null for a dangling snapshot symlink (interrupted download)', async () => {
    // The stat FOLLOWS the link, so a link with no blob behind it reports null
    // rather than a plausible path that fails on open inside the render.
    aggregateCache({ partial: true });
    expect(await findCachedRepoFile('org/aggregate', 'wanted.safetensors')).toBeNull();
  });

  it('returns null when the repo has no snapshot at all', async () => {
    aggregateCache();
    expect(await findCachedRepoFile('org/never-downloaded', 'wanted.safetensors')).toBeNull();
  });

  it('returns null for a missing repo id or filename', async () => {
    aggregateCache();
    expect(await findCachedRepoFile('', 'wanted.safetensors')).toBeNull();
    expect(await findCachedRepoFile(null, 'wanted.safetensors')).toBeNull();
    expect(await findCachedRepoFile('org/aggregate', '')).toBeNull();
    expect(await findCachedRepoFile('org/aggregate', null)).toBeNull();
  });
});

describe('repairCachedFile', () => {
  const cleanup = [];
  afterEach(() => {
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('unlinks the snapshot entry AND the blob behind it, leaving siblings alone', async () => {
    // Deleting only the symlink is not enough: `hf_hub_download` keys on the
    // cached etag rather than the content, so a stale blob with the right name
    // would be trusted and never re-fetched.
    const { root, repoDir } = buildFakeCache({
      repoId: 'org/aggregate',
      snapshots: { sha1: { 'wanted.safetensors': 1024, 'keep.safetensors': 2048 } },
    });
    cleanup.push(root);
    const target = join(repoDir, 'snapshots', 'sha1', 'wanted.safetensors');
    const blob = readlinkSync(target);
    const keep = join(repoDir, 'snapshots', 'sha1', 'keep.safetensors');

    expect(await repairCachedFile(target)).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(blob)).toBe(false);
    // The aggregate repo's other weights are untouched — that's the whole point
    // of not routing through repairModelCache here.
    expect(existsSync(keep)).toBe(true);
  });

  it('reports false for a path that is not there', async () => {
    expect(await repairCachedFile('/nope/missing.safetensors')).toBe(false);
    expect(await repairCachedFile(null)).toBe(false);
  });
});
