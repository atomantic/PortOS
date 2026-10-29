/**
 * Gallery images through the restore delete-record pass (videos and the peer
 * hop are covered end to end in mediaPeerDelete.e2e.test.js): a Put Back from
 * the OS Trash, a peer-owned image, and a delete still in flight — plus the
 * settling of deletes a crash left in flight, for both kinds.
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

const { recordMediaTombstone, listMediaTombstones, listExportableMediaTombstones, listInFlightMediaTombstones } = await import('./mediaTombstones.js');
const { atomicWrite } = await import('../lib/fileUtils.js');
const { clearRestoredMediaTombstones } = await import('./mediaRestoreTombstones.js');
const { peerSyncBus } = await import('./peerSyncEventBus.js');

const imagesDir = join(tempRoot, 'images');
const putBack = (filename, originInstanceId) => {
  writeFileSync(join(imagesDir, filename), Buffer.from('png'));
  writeFileSync(join(imagesDir, filename.replace(/\.png$/, '.metadata.json')), JSON.stringify({ originInstanceId, createdAt: '2026-01-01T00:00:00.000Z' }));
};
const imageKeys = async () => (await listMediaTombstones('image')).map((t) => t.key);

const videosDir = join(tempRoot, 'videos');

beforeEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(imagesDir, { recursive: true });
  mkdirSync(videosDir, { recursive: true });
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

// #14088: a crash between recording a delete's tombstone and settling it
// leaves the tombstone in flight; the next pass settles it from the file.
describe('deletes a crash left in flight', () => {
  const at = new Date(Date.now() - 60_000).toISOString();
  const pending = (key) => ({ key, deletedAt: at });
  const keys = (list) => list.map((t) => t.key).sort();

  it('withdraws the delete whose file is still here and commits the one whose file is gone', async () => {
    putBack('kept.png', 'inst-local');
    writeFileSync(join(videosDir, 'v-kept.mp4'), Buffer.from('mp4'));
    await atomicWrite(join(tempRoot, 'video-history.json'), [
      { id: 'v-kept', filename: 'v-kept.mp4', createdAt: '2026-01-01T00:00:00.000Z', originInstanceId: 'inst-local' },
      { id: 'v-trashed', filename: 'v-trashed.mp4', createdAt: '2026-01-01T00:00:00.000Z', originInstanceId: 'inst-local' },
    ]);
    const video = [pending('v-kept'), pending('v-trashed'), pending('v-gone')];
    const image = [pending('kept.png'), pending('trashed.png')];
    await atomicWrite(join(tempRoot, 'media-tombstones.json'), { version: 1, video, image, inFlight: { video, image } });
    expect(await listExportableMediaTombstones('video')).toEqual([]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await clearRestoredMediaTombstones();

    log.mockRestore();
    expect(await listInFlightMediaTombstones('video')).toEqual([]);
    expect(await listInFlightMediaTombstones('image')).toEqual([]);
    expect(keys(await listExportableMediaTombstones('video'))).toEqual(['v-gone', 'v-trashed']);
    expect(keys(await listExportableMediaTombstones('image'))).toEqual(['trashed.png']);
    expect(keys(await listMediaTombstones('video'))).toEqual(['v-gone', 'v-trashed']);
  });
});
