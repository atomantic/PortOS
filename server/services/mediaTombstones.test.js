import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const tempRoot = createTempDataRoot('portos-media-tombstones-');
vi.mock('../lib/fileUtils.js', async (importOriginal) => (
  makePathsProxy(await importOriginal(), { dataRoot: tempRoot })
));
afterAll(() => rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const { recordMediaTombstone, listMediaTombstones, mergeMediaTombstones, isMediaTombstoned } =
  await import('./mediaTombstones.js');

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

  it('a row whose createdAt is newer than the tombstone is not tombstoned', async () => {
    await recordMediaTombstone('video', 'vid-1', '2026-01-01T00:00:00.000Z');
    expect(await isMediaTombstoned('video', 'vid-1', '2025-12-31T00:00:00.000Z')).toBe(true);
    expect(await isMediaTombstoned('video', 'vid-1')).toBe(true);
    expect(await isMediaTombstoned('video', 'vid-1', '2026-02-01T00:00:00.000Z')).toBe(false);
    expect(await isMediaTombstoned('video', 'other')).toBe(false);
  });

  it('unreadable file rejects instead of resetting', async () => {
    writeFileSync(FILE, '{not json');
    await expect(recordMediaTombstone('video', 'vid-1')).rejects.toThrow();
    await expect(listMediaTombstones('video')).rejects.toThrow();
  });
});
