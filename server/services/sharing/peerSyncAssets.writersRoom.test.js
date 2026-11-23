import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makePathsProxy, mockNoPeers, mockNoPeerSync, ownTestBodies } from '../../lib/mockPathsDataRoot.js';

let dataRoot = mkdtempSync(join(tmpdir(), 'portos-draft-pull-boot-'));
const owned = ownTestBodies(it);
const roots = new Set([dataRoot]);
const peer = { instanceId: 'peer-a', host: 'example.com', port: 5555 };

vi.mock('../../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => dataRoot }));
vi.mock('../instances.js', () => ({ ...mockNoPeers(), getPeers: async () => [peer] }));
vi.mock('./peerSync.js', () => mockNoPeerSync());
vi.mock('../../lib/peerHttpClient.js', async (importOriginal) => ({ ...(await importOriginal()), peerFetch: vi.fn() }));

const { __resetBaseHashCacheForTests, conflictJournalStore } = await import('../../lib/conflictJournal.js');
const { peerFetch } = await import('../../lib/peerHttpClient.js');
const { createWork, saveDraftBody, snapshotDraft, getDraftBody, getWork, contentHash } = await import('../writersRoom/local.js');
const { diffWorkBodyManifest, mergeWorksFromSync, getWorkForSync } = await import('../writersRoom/sync.js');
const { listConflicts, resolveConflict } = await import('../conflictJournalResolver.js');
const { pullMissingWorkBodies } = await import('./peerSyncAssets.js');

const oldProse = 'The bell rang.';
const localProse = 'The brass bell rang twice.\n';
const activeProse = '# A different draft\n\nIts prose stays separate.';

function draftResponse(body) {
  const bytes = Buffer.from(body);
  return {
    ok: true,
    headers: new Headers({ 'content-length': String(bytes.length) }),
    arrayBuffer: async () => bytes,
  };
}

async function receivePeerEdit(local, draftId, { manifestProse = oldProse, fileProse = oldProse } = {}) {
  const updatedAt = new Date(Date.parse(local.updatedAt) + 60_000).toISOString();
  const winner = {
    ...local,
    title: 'A title edited on the peer',
    updatedAt,
    drafts: local.drafts.map((draft) => draft.id === draftId
      ? { ...draft, contentHash: contentHash(manifestProse) }
      : draft),
  };
  const { applied } = await mergeWorksFromSync([winner], { source: { via: 'peer-sync', peerId: peer.instanceId } });
  expect(applied).toBe(true);
  const entry = { workId: local.id, draftId, sha256: contentHash(fileProse) };
  const missing = await diffWorkBodyManifest([entry], { expectedHashes: new Map([[draftId, contentHash(fileProse)]]) });
  expect(missing).toHaveLength(1);
  return { missing, updatedAt };
}

async function draftConflicts() {
  return (await listConflicts({ status: 'pending' })).filter((entry) => entry.recordKind === 'writersRoomDraftBody');
}

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'portos-draft-pull-'));
  roots.add(dataRoot);
  __resetBaseHashCacheForTests();
  vi.mocked(peerFetch).mockReset();
});

async function cleanRoots() {
  try {
    await owned.drain();
  } finally {
    vi.restoreAllMocks();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.clear();
  }
}

afterEach(cleanRoots);
afterAll(cleanRoots);

describe('Writers Room draft pulls', () => {
  for (const body of [localProse, '']) {
    owned.it(`archives the ${body ? 'losing prose' : 'empty draft'} and restores its original version`, async () => {
      const work = await createWork({ title: 'Local story', kind: 'short-story' });
      const draftId = work.activeDraftVersionId;
      await saveDraftBody(work.id, body);
      const second = await snapshotDraft(work.id, { label: 'Current draft' });
      const { manifest } = await saveDraftBody(work.id, activeProse);
      const { missing, updatedAt } = await receivePeerEdit(manifest, draftId);
      vi.mocked(peerFetch).mockResolvedValueOnce(draftResponse(oldProse));

      await pullMissingWorkBodies(peer.instanceId, missing);
      expect(await getDraftBody(work.id, draftId)).toBe(oldProse);
      const conflicts = await draftConflicts();
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({
        recordId: `${work.id}/${draftId}`,
        source: { via: 'peer-sync', peerId: peer.instanceId },
        localHash: contentHash(body),
        remoteHash: contentHash(oldProse),
        localSnapshot: { body },
        remoteSnapshot: { body: oldProse },
        diffSummary: [{ field: 'body', localValue: body, remoteValue: oldProse, changed: 'both' }],
      });

      const resolved = await resolveConflict(conflicts[0].id, { action: 'restore-all' });

      expect(resolved.status).toBe('resolved');
      expect(await draftConflicts()).toEqual([]);
      expect(await getDraftBody(work.id, draftId)).toBe(body);
      expect(await getDraftBody(work.id, second.activeDraftVersionId)).toBe(activeProse);
      const restored = await getWork(work.id);
      expect(restored).toMatchObject({
        title: 'A title edited on the peer',
        activeDraftVersionId: second.activeDraftVersionId,
        drafts: expect.arrayContaining([expect.objectContaining({ id: draftId, contentHash: contentHash(body) })]),
      });
      expect(Date.parse(restored.updatedAt)).toBeGreaterThan(Date.parse(updatedAt));
    });
  }

  owned.it('retry push after a failed pull still converges; a stale push never pulls', async () => {
    const work = await createWork({ title: 'Local story', kind: 'short-story' });
    const draftId = work.activeDraftVersionId;
    const { manifest } = await saveDraftBody(work.id, localProse);
    const { missing } = await receivePeerEdit(manifest, draftId);
    // Push #1: background pull fails transiently; the body stays old.
    vi.mocked(peerFetch).mockRejectedValueOnce(new Error('transient'));
    await pullMissingWorkBodies(peer.instanceId, missing).catch(() => {});
    expect(await getDraftBody(work.id, draftId)).toBe(localProse);

    // Push #2: identical updatedAt, so the merge is NOT applied. The gate keys on
    // the persisted manifest hash (what reconcileWriterRoomBodies passes).
    const persisted = await getWorkForSync(work.id);
    const expectedHashes = new Map(persisted.drafts.map((d) => [d.id, d.contentHash]));
    const retry = await diffWorkBodyManifest([{ workId: work.id, draftId, sha256: contentHash(oldProse) }], { expectedHashes });
    expect(retry).toHaveLength(1);
    vi.mocked(peerFetch).mockResolvedValueOnce(draftResponse(oldProse));
    await pullMissingWorkBodies(peer.instanceId, retry);
    expect(await getDraftBody(work.id, draftId)).toBe(oldProse);

    // A stale losing push (hash != persisted) is refused.
    const stale = await diffWorkBodyManifest([{ workId: work.id, draftId, sha256: contentHash('stale') }], { expectedHashes });
    expect(stale).toEqual([]);
  });

  owned.it('skips a pull when a save changes the hash during its download', async () => {
    const work = await createWork({ title: 'Local story', kind: 'short-story' });
    const draftId = work.activeDraftVersionId;
    const { manifest } = await saveDraftBody(work.id, localProse);
    const { missing } = await receivePeerEdit(manifest, draftId);
    const downloading = Promise.withResolvers();
    const response = Promise.withResolvers();
    vi.mocked(peerFetch).mockImplementationOnce(() => {
      downloading.resolve();
      return response.promise;
    });
    const pull = pullMissingWorkBodies(peer.instanceId, missing);
    const newerProse = 'The newest local edit.';
    try {
      await downloading.promise;
      await saveDraftBody(work.id, newerProse);
    } finally {
      response.resolve(draftResponse(oldProse));
      await pull;
    }

    expect(await getDraftBody(work.id, draftId)).toBe(newerProse);
    expect(await draftConflicts()).toEqual([]);
  });

  owned.it('skips stale bytes when the peer manifest already has the current prose hash', async () => {
    const work = await createWork({ title: 'Local story', kind: 'short-story' });
    const draftId = work.activeDraftVersionId;
    const { manifest } = await saveDraftBody(work.id, localProse);
    const { missing } = await receivePeerEdit(manifest, draftId, { manifestProse: localProse });
    vi.mocked(peerFetch).mockResolvedValueOnce(draftResponse(oldProse));

    await pullMissingWorkBodies(peer.instanceId, missing);

    expect(await getDraftBody(work.id, draftId)).toBe(localProse);
    expect(await draftConflicts()).toEqual([]);
  });

  owned.it('keeps the incumbent bytes if their conflict cannot be saved', async () => {
    const work = await createWork({ title: 'Local story', kind: 'short-story' });
    const draftId = work.activeDraftVersionId;
    const { manifest } = await saveDraftBody(work.id, localProse);
    const { missing } = await receivePeerEdit(manifest, draftId);
    vi.mocked(peerFetch).mockResolvedValueOnce(draftResponse(oldProse));
    const archive = vi.spyOn(conflictJournalStore(), 'saveOne').mockRejectedValueOnce(new Error('Journal unavailable'));

    await pullMissingWorkBodies(peer.instanceId, missing);

    expect(archive).toHaveBeenCalledTimes(1);
    expect(await getDraftBody(work.id, draftId)).toBe(localProse);
  });
});
