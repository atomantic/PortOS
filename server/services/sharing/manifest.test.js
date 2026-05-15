import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { vi } from 'vitest';

let tempRoot;

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'PATHS') return { ...actual.PATHS, data: tempRoot };
      return target[prop];
    },
  });
});

const manifest = await import('./manifest.js');

describe('sharing/manifest', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'portos-manifest-test-'));
  });
  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it('buildManifest produces a valid shape', () => {
    const m = manifest.buildManifest({
      kind: 'series',
      senderInstanceId: 'inst-123',
      source: 'me',
      sourceBio: null,
      bucketId: 'b1',
      bucketName: 'creative',
      recordIds: ['ser-1', 'iss-2'],
      assetRefs: [{ kind: 'image', ref: 'abc.png' }],
    });
    expect(m.id).toBeTruthy();
    expect(m.kind).toBe('series');
    expect(m.source).toBe('me');
    expect(m.recordIds).toEqual(['ser-1', 'iss-2']);
    expect(m.assetRefs).toEqual([{ kind: 'image', ref: 'abc.png' }]);
    expect(m.schemaVersion).toBe(manifest.MANIFEST_SCHEMA_VERSION);
  });

  it('buildManifest rejects invalid kind', () => {
    expect(() => manifest.buildManifest({ kind: 'bogus' })).toThrow(/invalid kind/);
  });

  it('manifestFilename is sortable + slug-safe', () => {
    const m = manifest.buildManifest({
      kind: 'series',
      source: 'Bob & Co!',
      bucketId: 'b1',
      bucketName: 'b',
      recordIds: [],
      assetRefs: [],
    });
    const name = manifest.manifestFilename(m);
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // `Bob & Co!` slugifies to `bob-co-` (each run of non-alphanumeric → single dash).
    expect(name).toContain('bob-co-');
    expect(name).toMatch(/\.json$/);
    expect(name).not.toMatch(/[^a-zA-Z0-9._-]/);
  });

  it('hasBeenProcessed reports cursor state correctly', async () => {
    const cursor = await manifest.readCursor('bucket-1');
    expect(manifest.hasBeenProcessed(cursor, 'foo.json')).toBe(false);
    await manifest.markProcessed('bucket-1', 'foo.json');
    const next = await manifest.readCursor('bucket-1');
    expect(manifest.hasBeenProcessed(next, 'foo.json')).toBe(true);
  });

  it('markProcessed is idempotent', async () => {
    await manifest.markProcessed('b1', 'a.json');
    await manifest.markProcessed('b1', 'a.json');
    const c = await manifest.readCursor('b1');
    expect(c.processed.filter((x) => x === 'a.json')).toHaveLength(1);
  });
});
