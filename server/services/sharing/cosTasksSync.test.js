import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'crypto';

// Live CoS task-list + claim-metadata federation (#1712). We exercise
// peerSync.js's cos-tasks functions with the network (peerFetch), peer registry
// (instances), and the CoS task store all mocked. cosTaskStore is a spy so the
// receiver merge is observable AND can never touch the real data/TASKS.md —
// buildCosTasksPayload reads its getUserTasks/getCosTasks, syncCosTasksFromPeer
// calls its mergePeerTasks. The heavy record-graph modules are mocked exactly as
// cosHistorySync.test.js does, purely so importing peerSync.js stays offline.

vi.mock('../instances.js', () => ({
  UNKNOWN_INSTANCE_ID: 'unknown',
  DEFAULT_SYNC_CATEGORIES: {},
  getInstanceId: vi.fn().mockResolvedValue('test-instance'),
  getPeers: vi.fn().mockResolvedValue([]),
  enqueueReciprocalSync: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../universeBuilder.js', async () => ({ getUniverse: vi.fn(), mergeUniversesFromSync: vi.fn(), listUniverses: vi.fn() }));
vi.mock('../pipeline/series.js', async () => ({ getSeries: vi.fn(), mergeSeriesFromSync: vi.fn(), listSeries: vi.fn() }));
vi.mock('../pipeline/issues.js', async () => ({ listIssues: vi.fn(), mergeIssuesFromSync: vi.fn() }));
vi.mock('../pipeline/manuscriptReview.js', async () => ({ getReview: vi.fn(), mergeReviewFromSync: vi.fn() }));
vi.mock('../pipeline/reverseOutline.js', async () => ({ getStoredOutline: vi.fn(), mergeOutlineFromSync: vi.fn() }));
vi.mock('../mediaCollections.js', async () => ({
  getCollection: vi.fn(), listCollections: vi.fn(), findCollectionByUniverseId: vi.fn(),
  findCollectionBySeriesId: vi.fn(), mergeMediaCollectionsFromSync: vi.fn(),
}));
vi.mock('../mediaAssetIndex/index.js', () => ({ reconcileMediaAssets: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/peerHttpClient.js', async () => ({ peerFetch: vi.fn() }));
// cosTaskStore is dynamic-imported by both the sender (getUserTasks/getCosTasks)
// and the receiver (mergePeerTasks). Spy it so the wire build + merge are
// observable AND can't read/write the real task files.
vi.mock('../cosTaskStore.js', () => ({
  getUserTasks: vi.fn().mockResolvedValue({ tasks: [] }),
  getCosTasks: vi.fn().mockResolvedValue({ tasks: [] }),
  mergePeerTasks: vi.fn().mockResolvedValue({ changed: false }),
}));

import {
  buildCosTasksPayload,
  syncCosTasksFromPeer,
} from './peerSync.js';
import { getPeers } from '../instances.js';
import { peerFetch } from '../../lib/peerHttpClient.js';
import { getUserTasks, getCosTasks, mergePeerTasks } from '../cosTaskStore.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');

function payloadRes(obj) {
  return { ok: true, headers: { get: () => null }, json: async () => obj };
}

const PEER = { instanceId: 'peer-1', name: 'P1', address: '10.0.0.2', port: 5555, fullSync: true, enabled: true };

function task(id, status = 'pending', overrides = {}) {
  return { id, status, priority: 'MEDIUM', priorityValue: 2, description: `d ${id}`, metadata: {}, ...overrides };
}

beforeEach(() => {
  vi.mocked(peerFetch).mockReset();
  vi.mocked(getPeers).mockResolvedValue([PEER]);
  vi.mocked(getUserTasks).mockReset().mockResolvedValue({ tasks: [] });
  vi.mocked(getCosTasks).mockReset().mockResolvedValue({ tasks: [] });
  vi.mocked(mergePeerTasks).mockReset().mockResolvedValue({ changed: false });
});

describe('buildCosTasksPayload', () => {
  it('unions user + internal tasks with a taskType discriminator and a deterministic listHash', async () => {
    vi.mocked(getUserTasks).mockResolvedValue({ tasks: [task('task-a', 'pending')] });
    vi.mocked(getCosTasks).mockResolvedValue({ tasks: [task('sys-b', 'in_progress', { metadata: { claimedBy: 'i1' } })] });
    const p = await buildCosTasksPayload();
    expect(p.schemaVersion).toBe(2); // v2: `challenged` status + challenge metadata (#2441)
    expect(p.listHash).toMatch(/^[a-f0-9]{64}$/);
    expect(p.tasks).toHaveLength(2);
    const user = p.tasks.find((t) => t.id === 'task-a');
    const internal = p.tasks.find((t) => t.id === 'sys-b');
    expect(user.taskType).toBe('user');
    expect(internal.taskType).toBe('internal');
    expect(internal.metadata.claimedBy).toBe('i1');
    // Deterministic: same disk → same hash.
    const again = await buildCosTasksPayload();
    expect(again.listHash).toBe(p.listHash);
  });

  it('listHash flips when claim metadata changes (re-triggers a merge)', async () => {
    vi.mocked(getCosTasks).mockResolvedValue({ tasks: [task('sys-b', 'in_progress')] });
    const before = (await buildCosTasksPayload()).listHash;
    vi.mocked(getCosTasks).mockResolvedValue({ tasks: [task('sys-b', 'in_progress', { metadata: { claimedBy: 'i1', leaseExpiresAt: 'x' } })] });
    const after = (await buildCosTasksPayload()).listHash;
    expect(after).not.toBe(before);
  });

  it('listHash flips on a same-status description or approval-flag edit (so the receiver re-pulls)', async () => {
    vi.mocked(getUserTasks).mockResolvedValue({ tasks: [task('task-a', 'pending', { description: 'original' })] });
    const before = (await buildCosTasksPayload()).listHash;
    vi.mocked(getUserTasks).mockResolvedValue({ tasks: [task('task-a', 'pending', { description: 'EDITED' })] });
    const afterDesc = (await buildCosTasksPayload()).listHash;
    expect(afterDesc).not.toBe(before);
    vi.mocked(getUserTasks).mockResolvedValue({ tasks: [task('task-a', 'pending', { description: 'original', autoApproved: true })] });
    const afterApproval = (await buildCosTasksPayload()).listHash;
    expect(afterApproval).not.toBe(before);
  });

  it('returns an empty payload when there are no tasks', async () => {
    const p = await buildCosTasksPayload();
    expect(p.tasks).toEqual([]);
    expect(p.schemaVersion).toBe(2); // v2: `challenged` status + challenge metadata (#2441)
  });
});

describe('syncCosTasksFromPeer', () => {
  it('skips a non-full-sync peer (no network)', async () => {
    const r = await syncCosTasksFromPeer({ ...PEER, fullSync: false });
    expect(r).toEqual({ merged: 0, skipped: 'not-fullsync' });
    expect(peerFetch).not.toHaveBeenCalled();
  });

  it('gently skips a sender whose payload schema is ahead', async () => {
    vi.mocked(peerFetch).mockResolvedValue(payloadRes({ schemaVersion: 999, listHash: sha('x'), tasks: [] }));
    const r = await syncCosTasksFromPeer(PEER);
    expect(r).toEqual({ merged: 0, skipped: 'schema-ahead' });
    expect(mergePeerTasks).not.toHaveBeenCalled();
  });

  it('skips a malformed payload (failed validation)', async () => {
    vi.mocked(peerFetch).mockResolvedValue(payloadRes({ schemaVersion: 1, listHash: 'not-hex', tasks: [] }));
    const r = await syncCosTasksFromPeer(PEER);
    expect(r).toEqual({ merged: 0, skipped: 'invalid' });
  });

  it('merges both task files, splitting entries by taskType', async () => {
    const tasks = [
      { id: 'task-a', taskType: 'user', status: 'pending', priority: 'MEDIUM', description: 'd' },
      { id: 'sys-b', taskType: 'internal', status: 'in_progress', priority: 'HIGH', description: 'd', metadata: { claimedBy: 'peer-1' } },
    ];
    vi.mocked(peerFetch).mockResolvedValue(payloadRes({ schemaVersion: 1, listHash: sha('m'), tasks }));
    vi.mocked(mergePeerTasks).mockResolvedValue({ changed: true, count: 1 });

    const r = await syncCosTasksFromPeer(PEER);
    expect(r).toEqual({ merged: 2 });
    expect(mergePeerTasks).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(mergePeerTasks).mock.calls;
    const userCall = calls.find(([type]) => type === 'user');
    const internalCall = calls.find(([type]) => type === 'internal');
    expect(userCall[1].map((t) => t.id)).toEqual(['task-a']);
    expect(internalCall[1].map((t) => t.id)).toEqual(['sys-b']);
  });

  it('short-circuits an unchanged backlog on the second identical sweep', async () => {
    vi.mocked(peerFetch).mockResolvedValue(payloadRes({ schemaVersion: 1, listHash: sha('stable'), tasks: [] }));
    await syncCosTasksFromPeer(PEER);          // first sweep records the hash
    vi.mocked(mergePeerTasks).mockClear();
    const r = await syncCosTasksFromPeer(PEER); // second identical sweep
    expect(r).toEqual({ merged: 0, skipped: 'unchanged' });
    expect(mergePeerTasks).not.toHaveBeenCalled();
  });
});
