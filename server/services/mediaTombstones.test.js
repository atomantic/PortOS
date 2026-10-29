import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const tempRoot = createTempDataRoot('portos-media-tombstones-');
vi.mock('../lib/fileUtils.js', async (importOriginal) => (
  makePathsProxy(await importOriginal(), { dataRoot: tempRoot })
));
afterAll(() => rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const {
  recordMediaTombstone, listMediaTombstones, mergeMediaTombstones,
  beginMediaTombstone, listExportableMediaTombstones, listInFlightMediaTombstones,
} = await import('./mediaTombstones.js');

const FILE = join(tempRoot, 'media-tombstones.json');

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  rmSync(FILE, { force: true });
});

describe('mediaTombstones', () => {
  it('records and lists a tombstone', async () => {
    const t = await recordMediaTombstone('video', 'vid-1', '2026-01-01T00:00:00.000Z');
    expect(t).toEqual({ key: 'vid-1', deletedAt: '2026-01-01T00:00:00.000Z' });
    expect(await listMediaTombstones('video')).toEqual([t]);
    expect(await listMediaTombstones('image')).toEqual([]);
  });

  it('merge is idempotent and unions both sides', async () => {
    await recordMediaTombstone('image', 'a.png', '2026-01-01T00:00:00.000Z');
    const remote = [{ key: 'b.png', deletedAt: '2026-01-02T00:00:00.000Z' }];
    const first = await mergeMediaTombstones('image', remote);
    expect(first.added).toEqual(remote);
    const second = await mergeMediaTombstones('image', remote);
    expect(second.added).toEqual([]);
    const keys = (await listMediaTombstones('image')).map((t) => t.key).sort();
    expect(keys).toEqual(['a.png', 'b.png']);
  });

  // Uniquely catches a cap small enough that deletes fall off and let a
  // peer's copy come back (videos were once capped at 200).
  it.each(['video', 'image'])('keeps 5000 %s tombstones, dropping the oldest first', async (kind) => {
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    const at = (i) => new Date(base + i * 1000).toISOString();
    const seeded = Array.from({ length: 5000 }, (_, i) => ({ key: `k-${i}`, deletedAt: at(i) }));
    await mergeMediaTombstones(kind, seeded);
    expect(await listMediaTombstones(kind)).toHaveLength(5000);

    await recordMediaTombstone(kind, 'newest', at(10_000));
    const kept = await listMediaTombstones(kind);
    expect(kept).toHaveLength(5000);
    expect(kept[0]).toEqual({ key: 'newest', deletedAt: at(10_000) });
    const keys = new Set(kept.map((t) => t.key));
    expect(keys.has('k-0')).toBe(false);
    expect(keys.has('k-1')).toBe(true);
    expect(keys.has('k-4999')).toBe(true);
  });

  it('refuses an empty or non-string key instead of recording nothing', async () => {
    for (const key of ['', null, undefined, 42]) {
      expect(() => recordMediaTombstone('video', key), String(key)).toThrow(/non-empty string key/);
    }
    expect(await listMediaTombstones('video')).toEqual([]);
  });

  // #14088: an in-flight marker covers only its own delete; a newer delete of
  // the same key merged from a peer is that peer's to advertise.
  it('a newer peer delete of an in-flight key is exportable and drops the marker', async () => {
    const mine = await beginMediaTombstone('video', 'vid-1');
    expect(await listExportableMediaTombstones('video')).toEqual([]);
    const theirs = { key: 'vid-1', deletedAt: new Date(Date.parse(mine.deletedAt) + 1000).toISOString() };
    await mergeMediaTombstones('video', [theirs]);
    expect(await listExportableMediaTombstones('video')).toEqual([theirs]);
    expect(await listInFlightMediaTombstones('video')).toEqual([]);
  });

  it('unreadable file rejects instead of resetting', async () => {
    writeFileSync(FILE, '{not json');
    await expect(recordMediaTombstone('video', 'vid-1')).rejects.toThrow();
    await expect(listMediaTombstones('video')).rejects.toThrow();
  });
});
