import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'crypto';

// Live CoS task-list + claim-metadata federation (#1712). We exercise
// peerSync.js's cos-tasks functions with the network (peerFetch), peer registry
// (instances), and the CoS task store all mocked. cosTaskStore is a spy so the
// receiver merge is observable AND can never touch the real data/TASKS.md —
// buildCosTasksPayload reads its getUserTasks/getCosTasks, syncCosTasksFromPeer
// calls its mergePeerTasks. The heavy record-graph modules are mocked exactly as
// cosHistorySync.test.js does, purely so importing peerSync.js stays offline.

vi.mock('../instances.js', () => ({
  DEFAULT_SYNC_CATEGORIES: {},
  getPeers: vi.fn().mockResolvedValue([]),
  enqueueReciprocalSync: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../instanceIdentity.js', () => ({
  UNKNOWN_INSTANCE_ID: 'unknown',
  getInstanceId: vi.fn().mockResolvedValue('test-instance'),
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
vi.mock('../../lib/peerHttpClient.js', async (importOriginal) => ({
  peerFetch: vi.fn(),
  readPeerBody: (await importOriginal()).readPeerBody,
}));
// cosTaskStore is dynamic-imported by both the sender (getUserTasks/getCosTasks)
// and the receiver (mergePeerTasks). Spy it so the wire build + merge are
// observable AND can't read/write the real task files.
const taskStoreAvailability = vi.hoisted(() => ({ available: true }));
vi.mock('../cos/cosTaskStore.js', () => {
  const merge = vi.fn().mockResolvedValue({ changed: false });
  return {
    getUserTasks: vi.fn().mockResolvedValue({ tasks: [] }),
    getCosTasks: vi.fn().mockResolvedValue({ tasks: [] }),
    get mergePeerTasks() { return taskStoreAvailability.available ? merge : undefined; },
  };
});

import {
  buildCosTasksPayload,
} from './peerSync.js';
import { syncCosTasksFromPeer, syncCosTasksWithAllPeers } from './peerCosSync.js';
import { PORTOS_SCHEMA_VERSIONS } from '../../lib/schemaVersions.js';
import { getPeers } from '../instances.js';
import { peerFetch } from '../../lib/peerHttpClient.js';
// A chunked body with no Content-Length that never ends; only the streaming
// cap in readPeerBody can stop it.
const endlessChunkedRes = () => {
  const chunk = new Uint8Array(8 * 1024 * 1024);
  return new Response(new ReadableStream({ pull(controller) { controller.enqueue(chunk); } }));
};
import { getUserTasks, getCosTasks, mergePeerTasks } from '../cos/cosTaskStore.js';
import { behindPeersKnown, clearBehindPeer, getBehindPeerHolder } from '../cos/cosBehindPeerHold.js';
import { LEASE_DURATION_MS } from '../cos/cosTaskClaim.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');

function payloadRes(obj) {
  return { ok: true, headers: { get: () => null }, json: async () => obj };
}

const PEER = { instanceId: 'peer-1', name: 'P1', address: '10.0.0.2', port: 5555, fullSync: true, enabled: true };

function task(id, status = 'pending', overrides = {}) {
  return { id, status, priority: 'MEDIUM', priorityValue: 2, description: `d ${id}`, metadata: {}, ...overrides };
}

beforeEach(() => {
  taskStoreAvailability.available = true;
  vi.mocked(peerFetch).mockReset();
  vi.mocked(getPeers).mockResolvedValue([PEER]);
  vi.mocked(getUserTasks).mockReset().mockResolvedValue({ tasks: [] });
  vi.mocked(getCosTasks).mockReset().mockResolvedValue({ tasks: [] });
  vi.mocked(mergePeerTasks).mockReset().mockResolvedValue({ changed: false });
});

describe('buildCosTasksPayload', () => {
  it('never federates private assessment tasks or their source inventory', async () => {
    vi.mocked(getCosTasks).mockResolvedValue({ tasks: [task('private', 'pending', { metadata: {
      analysisType: 'private-security-assessment', privateSecurityScope: { files: ['auth.js'] },
    } })] });
    expect((await buildCosTasksPayload()).tasks).toEqual([]);
  });

  it('excludes machine-local Video prompts from both task files', async () => {
    const video = task('video', 'pending', { metadata: { machineLocal: true, context: 'Example source canon' } });
    vi.mocked(getUserTasks).mockResolvedValue({ tasks: [video] });
    vi.mocked(getCosTasks).mockResolvedValue({ tasks: [{ ...video, metadata: { ...video.metadata, machineLocal: 'true' } }, task('ordinary')] });
    expect((await buildCosTasksPayload()).tasks.map(t => t.id)).toEqual(['ordinary']);
  });

  it('unions user + internal tasks with a taskType discriminator and a deterministic listHash', async () => {
    vi.mocked(getUserTasks).mockResolvedValue({ tasks: [task('task-a', 'pending')] });
    vi.mocked(getCosTasks).mockResolvedValue({ tasks: [task('sys-b', 'in_progress', { metadata: { claimedBy: 'i1' } })] });
    const p = await buildCosTasksPayload();
    expect(p.schemaVersion).toBe(PORTOS_SCHEMA_VERSIONS.cosTasks);
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
    expect(p.schemaVersion).toBe(PORTOS_SCHEMA_VERSIONS.cosTasks);
  });
});

describe('syncCosTasksFromPeer', () => {
  it('skips a non-full-sync peer (no network)', async () => {
    const r = await syncCosTasksFromPeer({ ...PEER, fullSync: false });
    expect(r).toEqual({ merged: 0, skipped: 'not-fullsync' });
    expect(peerFetch).not.toHaveBeenCalled();
  });

  it('gently skips a sender whose payload schema is ahead', async () => {
    vi.mocked(peerFetch).mockResolvedValue(payloadRes({
      schemaVersion: PORTOS_SCHEMA_VERSIONS.cosTasks + 1,
      listHash: sha('x'),
      tasks: [],
    }));
    const r = await syncCosTasksFromPeer(PEER);
    expect(r).toEqual({ merged: 0, skipped: 'schema-ahead' });
    expect(mergePeerTasks).not.toHaveBeenCalled();
  });

  it('skips a chunked payload that streams past the byte cap', async () => {
    vi.mocked(peerFetch).mockResolvedValue(endlessChunkedRes());
    expect(await syncCosTasksFromPeer(PEER)).toEqual({ merged: 0, skipped: 'too-large' });
    expect(mergePeerTasks).not.toHaveBeenCalled();
  });

  it('skips a malformed payload (failed validation)', async () => {
    vi.mocked(peerFetch).mockResolvedValue(payloadRes({ schemaVersion: 1, listHash: 'not-hex', tasks: [] }));
    const r = await syncCosTasksFromPeer(PEER);
    expect(r).toEqual({ merged: 0, skipped: 'invalid' });
  });

  it('merges both task files, splitting entries by taskType', async () => {
    const tasks = [
      { id: 'local-video', taskType: 'internal', status: 'pending', priority: 'MEDIUM', description: 'Example video', metadata: { machineLocal: true, context: 'Example source canon' } },
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
    // The store merge takes no per-version option: an older payload merges like any other.
    expect(userCall).toHaveLength(2);
    expect(internalCall).toHaveLength(2);
  });

  // The spawn-budget proof was retired at v13 (#16807). A peer still on v12 holds
  // every task that arrives without proof metadata, so it must see this install's
  // payload as schema-ahead and skip it; its own payload still merges here, where
  // the store drops the proof keys.
  it('advertises a schema a proof-era peer skips, and still merges that peer\'s payload', async () => {
    const PROOF_ERA_SCHEMA = 12;
    expect(PORTOS_SCHEMA_VERSIONS.cosTasks).toBeGreaterThan(PROOF_ERA_SCHEMA);
    const tasks = [{ id: 'task-proof-era', taskType: 'user', status: 'pending', priority: 'MEDIUM', description: 'd',
      metadata: { totalSpawnCount: '1', spawnBudgetProof: { version: 1 }, spawnBudgetReconciledHold: 'true' } }];
    vi.mocked(peerFetch).mockResolvedValue(payloadRes({ schemaVersion: PROOF_ERA_SCHEMA, listHash: sha('proof-era'), tasks }));
    vi.mocked(mergePeerTasks).mockResolvedValue({ changed: true, count: 1 });

    expect(await syncCosTasksFromPeer({ ...PEER, instanceId: 'proof-era-peer' })).toEqual({ merged: 2 });
    expect(vi.mocked(mergePeerTasks).mock.calls.find(([type]) => type === 'user')).toEqual(['user', tasks]);
  });

  it.each(['user', 'internal'])('retries the identical payload immediately after the %s file merge fails', async (failedType) => {
    const peer = { ...PEER, instanceId: `retry-${failedType}` };
    const tasks = [
      { id: 'user-retry', status: 'in_progress', priority: 'MEDIUM', description: 'Example user task', metadata: { claimedBy: peer.instanceId, claimId: 'user-claim' }, taskType: 'user' },
      { id: 'internal-retry', status: 'in_progress', priority: 'MEDIUM', description: 'Example internal task', metadata: { claimedBy: peer.instanceId, claimId: 'internal-claim' }, taskType: 'internal' },
    ];
    const stored = { user: [], internal: [] };
    let failing = true;
    vi.mocked(peerFetch).mockResolvedValue(payloadRes({ schemaVersion: PORTOS_SCHEMA_VERSIONS.cosTasks, listHash: sha(peer.instanceId), tasks }));
    vi.mocked(mergePeerTasks).mockImplementation(async (type, incoming) => {
      if (failing && type === failedType) throw new Error('Synthetic task-file write failure');
      const changed = JSON.stringify(stored[type]) !== JSON.stringify(incoming);
      stored[type] = structuredClone(incoming);
      return { changed };
    });

    expect(await syncCosTasksFromPeer(peer)).toEqual({ merged: 1 });
    expect(stored[failedType]).toEqual([]);
    const successfulType = failedType === 'user' ? 'internal' : 'user';
    expect(stored[successfulType]).toEqual(tasks.filter(t => t.taskType === successfulType));

    failing = false;
    expect(await syncCosTasksFromPeer(peer)).toEqual({ merged: 1 });
    expect(stored.user).toEqual([tasks[0]]);
    expect(stored.internal).toEqual([tasks[1]]);
    expect(await syncCosTasksFromPeer(peer)).toEqual({ merged: 0, skipped: 'unchanged' });
    expect(mergePeerTasks).toHaveBeenCalledTimes(4);
  });

  it('retries the same payload when the task-store merge is unavailable', async () => {
    const peer = { ...PEER, instanceId: 'retry-unavailable-store' };
    vi.mocked(peerFetch).mockResolvedValue(payloadRes({ schemaVersion: 1, listHash: sha('unavailable-store'), tasks: [] }));
    taskStoreAvailability.available = false;
    expect(await syncCosTasksFromPeer(peer)).toEqual({ merged: 0 });
    taskStoreAvailability.available = true;
    expect(await syncCosTasksFromPeer(peer)).toEqual({ merged: 0 });
    expect(mergePeerTasks).toHaveBeenCalledTimes(2);
    expect(await syncCosTasksFromPeer(peer)).toEqual({ merged: 0, skipped: 'unchanged' });
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

// A peer on an older cosTasks schema skips every payload this install sends, so
// it never sees a claim made here. Until it updates, this install leaves the
// tasks that peer holds to it (#16871). The schema gate itself is unchanged.
describe('syncCosTasksFromPeer: tasks left to a behind-schema peer (#16871)', () => {
  const BEHIND = { ...PEER, instanceId: 'behind-peer' };
  const LOCAL = 'local-instance';
  const OLDER = PORTOS_SCHEMA_VERSIONS.cosTasks - 1;
  const T0 = Date.parse('2026-01-01T00:00:00.000Z');
  const entry = (id, status = 'pending', metadata = {}) => ({ id, taskType: 'user', status, priority: 'MEDIUM', description: `d ${id}`, metadata });
  const respond = (schemaVersion, tasks, hash = 'behind') => vi.mocked(peerFetch)
    .mockResolvedValue(payloadRes({ schemaVersion, listHash: sha(hash), tasks }));
  const holder = (id, now, metadata = {}) => getBehindPeerHolder({ id, metadata }, LOCAL, now);
  let clock;

  beforeEach(() => { clock = vi.spyOn(Date, 'now').mockReturnValue(T0); });
  afterEach(() => { clock.mockRestore(); clearBehindPeer(BEHIND.instanceId); });

  it('holds the unfinished tasks in an older payload and nothing else, and still merges that payload', async () => {
    const tasks = [
      entry('shared-pending'), entry('shared-running', 'in_progress'), entry('shared-blocked', 'blocked'),
      entry('shared-done', 'completed'), entry('peer-video', 'pending', { machineLocal: true }),
    ];
    respond(OLDER, tasks);
    vi.mocked(mergePeerTasks).mockResolvedValue({ changed: true });

    expect(await syncCosTasksFromPeer(BEHIND)).toEqual({ merged: 2 });
    expect(vi.mocked(mergePeerTasks).mock.calls.find(([type]) => type === 'user')[1].map((t) => t.id))
      .toEqual(['shared-pending', 'shared-running', 'shared-blocked', 'shared-done']);

    for (const id of ['shared-pending', 'shared-running', 'shared-blocked']) expect(holder(id, T0)).toBe(BEHIND.instanceId);
    // Created here during the window, finished there, or never federated: all run here as before.
    for (const id of ['created-here', 'shared-done', 'peer-video']) expect(holder(id, T0)).toBeNull();
    // A pin to this install is the user choosing where the task runs.
    expect(holder('shared-pending', T0, { targetInstanceId: LOCAL })).toBeNull();
    expect(holder('shared-pending', T0, { targetInstanceId: 'third-instance' })).toBe(BEHIND.instanceId);
  });

  it('releases the hold at the first sweep where the peer carries the local schema', async () => {
    respond(OLDER, [entry('shared-pending')]);
    await syncCosTasksFromPeer(BEHIND);
    expect(holder('shared-pending', T0)).toBe(BEHIND.instanceId);

    respond(PORTOS_SCHEMA_VERSIONS.cosTasks, [entry('shared-pending')], 'updated');
    await syncCosTasksFromPeer(BEHIND);
    expect(holder('shared-pending', T0)).toBeNull();
  });

  it('releases the hold when the peer jumps ahead of the local schema, while still skipping its payload', async () => {
    respond(OLDER, [entry('shared-pending')]);
    await syncCosTasksFromPeer(BEHIND);
    respond(PORTOS_SCHEMA_VERSIONS.cosTasks + 1, [entry('shared-pending')], 'ahead');
    expect(await syncCosTasksFromPeer(BEHIND)).toEqual({ merged: 0, skipped: 'schema-ahead' });
    expect(holder('shared-pending', T0)).toBeNull();
  });

  it('lapses once the peer has gone a whole lease without a successful sweep', async () => {
    respond(OLDER, [entry('shared-pending')]);
    await syncCosTasksFromPeer(BEHIND);

    vi.mocked(peerFetch).mockRejectedValue(new Error('Synthetic network failure'));
    clock.mockReturnValue(T0 + LEASE_DURATION_MS);
    expect(await syncCosTasksFromPeer(BEHIND)).toEqual({ merged: 0, skipped: 'unreachable' });
    expect(holder('shared-pending', T0 + LEASE_DURATION_MS)).toBe(BEHIND.instanceId);
    expect(holder('shared-pending', T0 + LEASE_DURATION_MS + 1)).toBeNull();
  });

  it('keeps holding across unchanged sweeps, however long the peer stays behind', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    respond(OLDER, [entry('shared-pending')]);
    await syncCosTasksFromPeer(BEHIND);

    clock.mockReturnValue(T0 + LEASE_DURATION_MS);
    expect(await syncCosTasksFromPeer(BEHIND)).toEqual({ merged: 0, skipped: 'unchanged' });
    expect(holder('shared-pending', T0 + LEASE_DURATION_MS + 1)).toBe(BEHIND.instanceId);
    // The window is announced when it opens, not on every sweep of it.
    const announced = log.mock.calls.filter(([line]) => String(line).includes('cannot see claims made here'));
    log.mockRestore();
    expect(announced).toHaveLength(1);
  });

  it('follows the latest payload: a task the peer finished or dropped is no longer held', async () => {
    respond(OLDER, [entry('shared-pending'), entry('finishing')]);
    await syncCosTasksFromPeer(BEHIND);
    respond(OLDER, [entry('finishing', 'completed')], 'next');
    await syncCosTasksFromPeer(BEHIND);
    expect(holder('shared-pending', T0)).toBeNull();
    expect(holder('finishing', T0)).toBeNull();
  });

  // The restart that installs a newer schema opens the window, so the spawn guard
  // waits on the first all-peers sweep of the process. Once per module instance.
  it('lets the first dispatch wait for the first all-peers sweep, which records the hold', async () => {
    vi.mocked(getPeers).mockResolvedValue([BEHIND]);
    let answer;
    vi.mocked(peerFetch).mockReturnValue(new Promise((resolve) => { answer = resolve; }));

    const sweep = syncCosTasksWithAllPeers();
    let known = false;
    const waiting = behindPeersKnown().then(() => { known = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(known).toBe(false);
    expect(holder('shared-pending', T0)).toBeNull();

    answer(payloadRes({ schemaVersion: OLDER, listHash: sha('boot'), tasks: [entry('shared-pending')] }));
    await waiting;
    await sweep;
    expect(peerFetch).toHaveBeenCalledTimes(1);
    expect(holder('shared-pending', T0)).toBe(BEHIND.instanceId);
  });

  it('holds nothing for a peer on the local schema', async () => {
    respond(PORTOS_SCHEMA_VERSIONS.cosTasks, [entry('shared-pending')], 'current');
    await syncCosTasksFromPeer(BEHIND);
    expect(holder('shared-pending', T0)).toBeNull();
  });
});
