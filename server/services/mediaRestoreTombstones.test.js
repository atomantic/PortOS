/**
 * Gallery images through the restore delete-record pass (videos and the peer
 * hop are covered end to end in mediaPeerDelete.e2e.test.js): a Put Back from
 * the OS Trash, a peer-owned image, and a delete still in flight.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const tempRoot = createTempDataRoot('portos-media-restore-');
vi.mock('../lib/fileUtils.js', async (importOriginal) => (
  makePathsProxy(await importOriginal(), { dataRoot: tempRoot })
));
vi.mock('./instanceIdentity.js', () => ({ UNKNOWN_INSTANCE_ID: 'unknown', getInstanceId: async () => 'inst-local' }));
afterAll(() => rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const { recordMediaTombstone, listMediaTombstones } = await import('./mediaTombstones.js');
const { clearRestoredMediaTombstones } = await import('./mediaRestoreTombstones.js');
const { peerSyncBus } = await import('./peerSyncEventBus.js');

const imagesDir = join(tempRoot, 'images');
const putBack = (filename, originInstanceId) => {
  writeFileSync(join(imagesDir, filename), Buffer.from('png'));
  writeFileSync(join(imagesDir, filename.replace(/\.png$/, '.metadata.json')), JSON.stringify({ originInstanceId, createdAt: '2026-01-01T00:00:00.000Z' }));
};
const imageKeys = async () => (await listMediaTombstones('image')).map((t) => t.key);

beforeEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(imagesDir, { recursive: true });
});

describe('clearRestoredMediaTombstones', () => {
  it('clears the delete record of a locally owned image put back after its delete, and only that one', async () => {
    const delivered = [];
    const onChange = (payload) => delivered.push(payload);
    peerSyncBus.on('media-history-changed', onChange);
    await recordMediaTombstone('image', 'mine.png', new Date(Date.now() - 60_000).toISOString());
    await recordMediaTombstone('image', 'theirs.png', new Date(Date.now() - 60_000).toISOString());
    putBack('mine.png', 'inst-local');
    putBack('theirs.png', 'inst-peer');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await clearRestoredMediaTombstones();

    peerSyncBus.off('media-history-changed', onChange);
    expect(result.images).toEqual(['mine.png']);
    expect(await imageKeys()).toEqual(['theirs.png']);
    expect(delivered).toEqual([{ kind: 'image', op: 'upsert', ids: ['mine.png'] }]);
    expect(log.mock.calls.flat().join('\n')).toMatch(/Restored image theirs\.png keeps its delete record: owned by inst-peer/);
    log.mockRestore();
  });

  // The tombstone is recorded just before the files move to the Trash; a pass
  // landing in between must not read the still-present file as a restore.
  it('keeps the delete record of an image whose file predates the delete', async () => {
    putBack('deleting.png', 'inst-local');
    await recordMediaTombstone('image', 'deleting.png', new Date(Date.now() + 1000).toISOString());

    expect((await clearRestoredMediaTombstones()).images).toEqual([]);
    expect(await imageKeys()).toEqual(['deleting.png']);
  });
});
