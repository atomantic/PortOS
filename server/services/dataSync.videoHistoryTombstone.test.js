import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-datasync-vtomb-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});
const registry = vi.hoisted(() => ({ peers: [] }));
vi.mock('./instances.js', async () => {
  const actual = await vi.importActual('./instances.js');
  return { ...actual, getPeers: async () => registry.peers };
});
vi.mock('./mediaAssetIndex/index.js', () => ({ unindexVideo: async () => {} }));
vi.mock('./musicVideo/mediaPool.js', () => ({ forgetDeletedMusicVideoAssets: async () => {} }));
vi.mock('../lib/trashFiles.js', () => ({ trashFiles: vi.fn(async () => {}) }));

const { PATHS, readJSONFile, atomicWrite } = await import('../lib/fileUtils.js');
const dataSync = await import('./dataSync.js');
const { deleteHistoryItem } = await import('./videoGen/historyOps.js');
const { listMediaTombstones, recordMediaTombstone } = await import('./mediaTombstones.js');
const { trashFiles } = await import('../lib/trashFiles.js');

const HISTORY = join(PATHS.data, 'video-history.json');
const row = (id, createdAt = '2026-05-01T00:00:00.000Z', extra = {}) => ({ id, filename: `${id}.mp4`, createdAt, ...extra });
const PAIR = 's'.repeat(40);
const pairedPeer = (instanceId, extra = {}) => ({ id: `rec-${instanceId}`, name: instanceId, instanceId, enabled: true, syncSecret: PAIR, ...extra });
const ownedBy = (origin) => ({ originInstanceId: origin });
const tomb = (key, deletedAt = '2026-06-01T00:00:00.000Z') => ({ key, deletedAt });
const readHistory = async () => (await readJSONFile(HISTORY, [])).map((r) => r.id).sort();

beforeEach(async () => {
  mkdirSync(PATHS.videos, { recursive: true });
  mkdirSync(PATHS.videoThumbnails, { recursive: true });
  await atomicWrite(HISTORY, []);
  await atomicWrite(join(PATHS.data, 'media-tombstones.json'), { version: 1, video: [], image: [] });
  trashFiles.mockClear();
  registry.peers = [pairedPeer('peer-a'), pairedPeer('peer-b')];
});

describe('applyRemoteVideoTombstones scope', () => {
  it('retires only the rows the authorized tombstones name', async () => {
    // A held row another stored tombstone covers was not admitted for this sender.
    await atomicWrite(HISTORY, [row('v-named'), row('v-other')]);
    await recordMediaTombstone('video', 'v-other', '2026-06-01T00:00:00.000Z');
    expect(await dataSync.applyRemoteVideoTombstones([tomb('v-named')])).toBe(1);
    expect(await readHistory()).toEqual(['v-other']);
  });

  it('fails the apply when trashing a tombstoned row fails, so the sync retries', async () => {
    await atomicWrite(HISTORY, [row('v-stuck')]);
    trashFiles.mockRejectedValueOnce(new Error('disk busy'));
    await expect(dataSync.applyRemoteVideoTombstones([tomb('v-stuck')])).rejects.toThrow(/v-stuck/);
    expect(await readHistory()).toEqual(['v-stuck']);
  });

  it('a remote-tombstone delete re-checks the row inside the history writer', async () => {
    // The replacement row (newer than the delete) is what the writer sees, so it survives.
    await atomicWrite(HISTORY, [row('v-race', '2026-07-01T00:00:00.000Z')]);
    const result = await deleteHistoryItem('v-race', {
      fromRemoteTombstone: true,
      onlyIf: (current) => Date.parse(current.createdAt) <= Date.parse('2026-06-01T00:00:00.000Z'),
    });
    expect(result).toEqual({ ok: false, skipped: true });
    expect(trashFiles).not.toHaveBeenCalled();
    expect(await readHistory()).toEqual(['v-race']);
  });
});

describe('video delete durability', () => {
  it('deleting a video records a tombstone', async () => {
    await atomicWrite(HISTORY, [row('v1')]);
    await deleteHistoryItem('v1');
    expect((await listMediaTombstones('video')).map((t) => t.key)).toEqual(['v1']);
    expect(await readHistory()).toEqual([]);
  });

  it('leaves no tombstone when trashing fails, so the row still syncs', async () => {
    await atomicWrite(HISTORY, [row('v1')]);
    trashFiles.mockRejectedValueOnce(new Error('disk full'));
    await expect(deleteHistoryItem('v1')).rejects.toThrow('disk full');
    expect(await listMediaTombstones('video')).toEqual([]);
    expect(await readHistory()).toEqual(['v1']);
    const { data } = await dataSync.getSnapshot('videoHistory');
    expect(data.videos.map((v) => v.id)).toEqual(['v1']);
    expect(data).not.toHaveProperty('tombstones');
  });

  // #14088: a peer pulling while the files are still being trashed must not
  // receive a delete that the failed trash would then withdraw.
  it('keeps a delete out of the snapshot until its trash commits', async () => {
    await atomicWrite(HISTORY, [row('v1')]);
    let finishTrash;
    let trashStarted;
    const started = new Promise((resolve) => { trashStarted = resolve; });
    trashFiles.mockImplementationOnce(() => new Promise((resolve) => { finishTrash = resolve; trashStarted(); }));
    const deleting = deleteHistoryItem('v1');
    try {
      await started;
      const during = await dataSync.getSnapshot('videoHistory');
      expect(during.data).not.toHaveProperty('tombstones');
      // Filtering here starts at once: a peer's copy cannot slip back in meanwhile.
      expect((await listMediaTombstones('video')).map((t) => t.key)).toEqual(['v1']);
    } finally {
      finishTrash();
      await deleting;
    }
    const after = await dataSync.getSnapshot('videoHistory');
    expect(after.data.tombstones.map((t) => t.key)).toEqual(['v1']);
    expect(after.data.videos).toEqual([]);
  });

  it('has the tombstone recorded before files are trashed', async () => {
    await atomicWrite(HISTORY, [row('v1')]);
    let seen;
    trashFiles.mockImplementationOnce(async () => { seen = (await listMediaTombstones('video')).map((t) => t.key); });
    await deleteHistoryItem('v1');
    expect(seen).toEqual(['v1']);
  });

  it('fromRemoteTombstone does not re-record the tombstone', async () => {
    await atomicWrite(HISTORY, [row('v1')]);
    await deleteHistoryItem('v1', { fromRemoteTombstone: true });
    expect(await listMediaTombstones('video')).toEqual([]);
  });

  it('snapshot from a peer with a tombstone removes the local row and files', async () => {
    await atomicWrite(HISTORY, [row('v1', undefined, ownedBy('peer-a')), row('v2')]);
    const result = await dataSync.applyRemote('videoHistory', {
      videos: [],
      tombstones: [tomb('v1')],
    }, { peerId: 'peer-a' });
    expect(await readHistory()).toEqual(['v2']);
    expect(trashFiles).toHaveBeenCalled();
    expect(trashFiles.mock.calls[0][0].some((f) => f.endsWith('v1.mp4'))).toBe(true);
    expect((await listMediaTombstones('video')).map((t) => t.key)).toEqual(['v1']);
    expect(result.applied).toBe(true);
  });

  it('peer snapshot without the tombstone does not resurrect a deleted row', async () => {
    await atomicWrite(HISTORY, [row('v1')]);
    await deleteHistoryItem('v1');
    await dataSync.applyRemote('videoHistory', { videos: [row('v1'), row('v3')] }, { peerId: 'peer-a' });
    expect(await readHistory()).toEqual(['v3']);
  });

  // #14123: the tombstone must be read inside the history writer, or a merge
  // queued behind a delete filters against the pre-delete tombstone list.
  it('a peer merge racing a local delete does not re-add the deleted row', async () => {
    await atomicWrite(HISTORY, [row('v1')]);
    const deleting = deleteHistoryItem('v1');
    const merging = dataSync.applyRemote('videoHistory', { videos: [row('v1')] }, { peerId: 'peer-a' });
    await deleting;
    await merging;
    expect(await readHistory()).toEqual([]);
    expect((await listMediaTombstones('video')).map((t) => t.key)).toEqual(['v1']);
  });

  it('re-created row with newer createdAt survives its tombstone', async () => {
    await recordMediaTombstone('video', 'v1', '2026-06-01T00:00:00.000Z');
    await dataSync.applyRemote('videoHistory', {
      videos: [row('v1', '2026-07-01T00:00:00.000Z'), row('v2', '2026-05-01T00:00:00.000Z')],
    }, { peerId: 'peer-a' });
    expect(await readHistory()).toEqual(['v1', 'v2']);
  });

  // #14087: only the row's owner may un-delete it with a restore stamp.
  it('admits a restored row only from its owner, which also retires the superseded tombstone', async () => {
    await recordMediaTombstone('video', 'v1', '2026-06-01T00:00:00.000Z');
    const restored = row('v1', '2026-05-01T00:00:00.000Z', { ...ownedBy('peer-a'), restoredAt: '2026-06-01T00:00:00.001Z' });

    await dataSync.applyRemote('videoHistory', { videos: [restored] }, { peerId: 'peer-b' });
    expect(await readHistory()).toEqual([]);
    expect((await listMediaTombstones('video')).map((t) => t.key)).toEqual(['v1']);

    await dataSync.applyRemote('videoHistory', { videos: [restored] }, { peerId: 'peer-a' });
    expect(await readHistory()).toEqual(['v1']);
    expect(await listMediaTombstones('video')).toEqual([]);
  });

  it('checksum is stable across tombstone insertion order', async () => {
    const a = '2026-06-01T00:00:00.000Z';
    const b = '2026-06-02T00:00:00.000Z';
    const file = join(PATHS.data, 'media-tombstones.json');
    await atomicWrite(file, { version: 1, video: [{ key: 'a', deletedAt: a }, { key: 'b', deletedAt: b }], image: [] });
    const first = await dataSync.getSnapshot('videoHistory');
    await atomicWrite(file, { version: 1, video: [{ key: 'b', deletedAt: b }, { key: 'a', deletedAt: a }], image: [] });
    const second = await dataSync.getSnapshot('videoHistory');
    expect(first.checksum).toBe(second.checksum);
    expect(first.data.tombstones.map((t) => t.key)).toEqual(['a', 'b']);
  });

  it('omits tombstones from the snapshot when there are none', async () => {
    const snap = await dataSync.getSnapshot('videoHistory');
    expect(snap.data).not.toHaveProperty('tombstones');
  });
});

describe('snapshot tombstone authorization', () => {
  const ids = async () => (await listMediaTombstones('video')).map((t) => t.key);

  it('ignores a forged tombstone from a peer that does not own the row', async () => {
    await atomicWrite(HISTORY, [row('v1', undefined, ownedBy('peer-a'))]);
    await dataSync.applyRemote('videoHistory', { videos: [], tombstones: [tomb('v1')] }, { peerId: 'peer-b' });
    expect(await readHistory()).toEqual(['v1']);
    expect(await ids()).toEqual([]);
    expect(trashFiles).not.toHaveBeenCalled();
  });

  it('ignores the owner\'s tombstone when media delete is off for that peer', async () => {
    registry.peers = [pairedPeer('peer-a', { mediaDeleteAllowed: false })];
    await atomicWrite(HISTORY, [row('v1', undefined, ownedBy('peer-a'))]);
    await dataSync.applyRemote('videoHistory', { videos: [], tombstones: [tomb('v1')] }, { peerId: 'peer-a' });
    expect(await readHistory()).toEqual(['v1']);
    expect(await ids()).toEqual([]);
  });

  it('ignores tombstones from an unregistered or unpaired sender', async () => {
    registry.peers = [{ ...pairedPeer('peer-a'), syncSecret: undefined }];
    await atomicWrite(HISTORY, [row('v1', undefined, ownedBy('peer-a'))]);
    await dataSync.applyRemote('videoHistory', { videos: [], tombstones: [tomb('v1')] }, { peerId: 'peer-a' });
    await dataSync.applyRemote('videoHistory', { videos: [], tombstones: [tomb('v1')] }, { peerId: 'peer-unknown' });
    expect(await readHistory()).toEqual(['v1']);
    expect(await ids()).toEqual([]);
  });

  it('ignores a future-dated tombstone even from the owner', async () => {
    await atomicWrite(HISTORY, [row('v1', undefined, ownedBy('peer-a'))]);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await dataSync.applyRemote('videoHistory', { videos: [], tombstones: [tomb('v1', future)] }, { peerId: 'peer-a' });
    expect(await readHistory()).toEqual(['v1']);
    expect(await ids()).toEqual([]);
  });

  it('accepts the owner\'s tombstone stamped within clock skew, ignores an unparseable one', async () => {
    await atomicWrite(HISTORY, [row('v1', undefined, ownedBy('peer-a')), row('v2', undefined, ownedBy('peer-a'))]);
    const skewed = new Date(Date.now() + 4 * 60 * 1000).toISOString();
    await dataSync.applyRemote('videoHistory', { videos: [], tombstones: [tomb('v1', skewed), tomb('v2', 'not a time')] }, { peerId: 'peer-a' });
    expect(await readHistory()).toEqual(['v2']);
    expect(await ids()).toEqual(['v1']);
  });

  // Uniquely catches a merge that hands a held origin-less row to the sender,
  // whose next tombstone would then pass the owner check.
  it('a newer snapshot row never gives a held origin-less row the sender\'s origin', async () => {
    await atomicWrite(HISTORY, [row('v1')]);
    await dataSync.applyRemote('videoHistory', {
      videos: [row('v1', '2026-07-01T00:00:00.000Z', ownedBy('peer-a')), row('fresh', '2026-07-01T00:00:00.000Z', ownedBy('peer-a'))],
    }, { peerId: 'peer-a' });
    const rows = await readJSONFile(HISTORY, []);
    const held = rows.find((r) => r.id === 'v1');
    expect(held.createdAt).toBe('2026-07-01T00:00:00.000Z');
    expect(held).not.toHaveProperty('originInstanceId');
    expect(rows.find((r) => r.id === 'fresh')).toMatchObject({ originInstanceId: 'peer-a', suppliedByInstanceId: 'peer-a' });
    await dataSync.applyRemote('videoHistory', { videos: [], tombstones: [tomb('v1', '2026-08-01T00:00:00.000Z')] }, { peerId: 'peer-a' });
    expect(await readHistory()).toEqual(['fresh', 'v1']);
    expect(trashFiles).not.toHaveBeenCalled();
  });

  it('does not record a tombstone for a row this machine does not hold', async () => {
    await dataSync.applyRemote('videoHistory', { videos: [], tombstones: [tomb('ghost')] }, { peerId: 'peer-a' });
    expect(await ids()).toEqual([]);
  });
});

afterAll(cleanup);

describe('Make-primary designation in the video snapshot', () => {
  const stored = async () => (await readJSONFile(HISTORY, [])).find((r) => r.id === 'v1');
  const designated = (instanceId, primaryAt) => row('v1', undefined, { ...ownedBy('peer-a'), primaryInstanceId: instanceId, primaryAt });

  it('a newer designation replaces the held one, an older one never does, and origin stays local', async () => {
    await atomicWrite(HISTORY, [designated('peer-a', '2026-06-01T00:00:00.000Z')]);

    const newer = await dataSync.applyRemote('videoHistory', { videos: [{ ...designated('peer-b', '2026-07-01T00:00:00.000Z'), originInstanceId: 'peer-b' }] }, { peerId: 'peer-b' });
    expect(newer.applied).toBe(true);
    expect(await stored()).toMatchObject({ primaryInstanceId: 'peer-b', primaryAt: '2026-07-01T00:00:00.000Z', originInstanceId: 'peer-a' });

    const older = await dataSync.applyRemote('videoHistory', { videos: [designated('peer-c', '2026-06-15T00:00:00.000Z')] }, { peerId: 'peer-c' });
    expect(older.applied).toBe(false);
    expect(await stored()).toMatchObject({ primaryInstanceId: 'peer-b' });
  });

  it('keeps the local designation when a re-created incoming row without one wins the row', async () => {
    await atomicWrite(HISTORY, [designated('peer-a', '2026-06-01T00:00:00.000Z')]);
    await dataSync.applyRemote('videoHistory', { videos: [row('v1', '2026-05-15T00:00:00.000Z', ownedBy('peer-a'))] }, { peerId: 'peer-a' });
    expect(await stored()).toMatchObject({ createdAt: '2026-05-15T00:00:00.000Z', primaryInstanceId: 'peer-a', primaryAt: '2026-06-01T00:00:00.000Z' });
  });
});
