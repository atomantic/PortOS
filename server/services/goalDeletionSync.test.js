import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdir, readFile, writeFile, rm } from 'fs/promises';
import { dirname, join } from 'path';
import { mockPathsDataRoot, mockNoPeers, mockNoPeerSync, mockTestIdentity } from '../lib/mockPathsDataRoot.js';

// Two peers are simulated on one temp data root by swapping which document sits
// in goals.json: the REAL deleteGoal writes it, the REAL dataSync snapshot and
// merge carry it across, and no database or live peer is touched (#9816).
const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-goal-delete-sync-' });
vi.mock('../lib/fileUtils.js', async (original) => new Proxy(makeProxy(await original()), {
  get: (target, key) => key === 'dataPath' ? (...parts) => join(tempRoot, ...parts) : target[key],
}));
vi.mock('./instances.js', async (importOriginal) => mockNoPeers({}, {
  peerLogLabel: (await importOriginal()).peerLogLabel,
  resolveEffectiveCategories: () => ({}),
  updatePeer: async () => {},
}));
vi.mock('./instanceIdentity.js', () => mockTestIdentity());
vi.mock('./sharing/peerSync.js', () => mockNoPeerSync({}, {
  getOutboundCoverageForPeer: async () => ({ universe: new Set(), pipeline: new Set(), mediaCollections: new Set() }),
}));
vi.mock('./mediaJobQueue/index.js', () => ({ getJob: () => null }));
vi.mock('./sharing/annotationIdentity.js', () => ({ resolveBucketSourceName: async () => 'Test' }));
vi.mock('../lib/peerHttpClient.js', () => ({ peerFetch: vi.fn(() => { throw new Error('Unexpected network request'); }) }));
vi.mock('./meatspaceCalendar.js', () => ({ getActivities: async () => [] }));

const dataSync = await import('./dataSync.js');
const goalService = await import('./identity/goals.js');
const { PATHS } = await import('../lib/fileUtils.js');

const goalsPath = join(PATHS.digitalTwin, 'goals.json');
const read = async () => JSON.parse(await readFile(goalsPath, 'utf8'));
const seed = async (doc) => {
  await mkdir(dirname(goalsPath), { recursive: true });
  await writeFile(goalsPath, JSON.stringify(doc));
};
const goal = (id, extra = {}) => ({
  id, title: `Goal ${id}`, status: 'active', parentId: null, progress: 0,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra,
});
const ids = (doc) => doc.goals.map((g) => g.id);

// Run `action` as the peer whose document is `doc`; return that peer's new document.
const asPeer = async (doc, action) => {
  await seed(doc);
  await action();
  return read();
};
const DELETED_AT = '2026-01-05T09:00:00.000Z';
const deleteOnPeer = (doc, goalId) => asPeer(doc, async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(DELETED_AT) });
  await goalService.deleteGoal(goalId);
  vi.useRealTimers();
});
const snapshotOf = async (doc) => {
  await seed(doc);
  const { data } = await dataSync.getSnapshot('goals');
  return data;
};
const pull = (doc, remote) => asPeer(doc, () => dataSync.applyRemote('goals', remote));

beforeEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});
afterEach(() => vi.useRealTimers());
afterAll(cleanup);

describe('goal deletion across snapshot-federated peers (#9816)', () => {
  const shared = () => ({ goals: [goal('goal-example'), goal('goal-other', { progress: 40 })], updatedAt: '2026-01-01T00:00:00.000Z' });

  it('keeps a deleted goal deleted on both peers, through repeated stale redelivery', async () => {
    const staleB = shared();
    const peerA = await deleteOnPeer(shared(), 'goal-example');
    expect(ids(peerA)).toEqual(['goal-other']);
    expect(peerA.goalTombstones).toEqual([{ id: 'goal-example', deletedAt: DELETED_AT }]);

    // B was offline for the delete; A's snapshot carries the tombstone to it.
    const peerB = await pull(staleB, await snapshotOf(peerA));
    expect(peerB.goals).toEqual([goal('goal-other', { progress: 40 })]);
    expect(peerB.goalTombstones).toEqual(peerA.goalTombstones);

    // B's answer back, and B's pre-delete snapshot replayed any number of times,
    // never bring the goal back to A.
    const backOnA = await pull(peerA, await snapshotOf(peerB));
    expect(ids(backOnA)).toEqual(['goal-other']);
    const stale = await snapshotOf(staleB);
    expect(ids(await pull(backOnA, stale))).toEqual(['goal-other']);
    await seed(backOnA);
    expect(await dataSync.applyRemote('goals', stale)).toEqual({ applied: false, count: 0 });
    expect(await read()).toEqual(backOnA);
  });

  it('rejects a stale goal from an older peer that omits tombstones, and keeps the tombstone', async () => {
    const peerA = await deleteOnPeer(shared(), 'goal-example');
    const legacyPayload = { goals: shared().goals, updatedAt: '2026-01-01T00:00:00.000Z' };
    expect(legacyPayload).not.toHaveProperty('goalTombstones');

    const after = await pull(peerA, legacyPayload);
    expect(ids(after)).toEqual(['goal-other']);
    expect(after.goalTombstones).toEqual(peerA.goalTombstones);
  });

  it('lets a goal edited after the deletion win, and retires the tombstone', async () => {
    const peerA = await deleteOnPeer(shared(), 'goal-example');
    const editedOnB = shared();
    editedOnB.goals[0] = goal('goal-example', { title: 'Edited on B', updatedAt: '2026-01-06T09:00:00.000Z' });

    const merged = await pull(peerA, await snapshotOf(editedOnB));
    expect(merged.goals.find((g) => g.id === 'goal-example')).toMatchObject({ title: 'Edited on B' });
    expect(merged.goalTombstones).toBeUndefined();

    // The converse hop: B receives A's already-retired list and keeps its edit.
    const onB = await pull(editedOnB, await snapshotOf(merged));
    expect(onB.goals.find((g) => g.id === 'goal-example')).toMatchObject({ title: 'Edited on B' });
  });

  it('keeps unrelated goals and re-parents a child edited on the offline peer', async () => {
    const tree = () => ({
      goals: [
        goal('goal-root'),
        goal('goal-parent', { parentId: 'goal-root' }),
        goal('goal-child', { parentId: 'goal-parent' }),
        goal('goal-other', { progress: 40 }),
      ],
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const peerA = await deleteOnPeer(tree(), 'goal-parent');
    expect(peerA.goals.find((g) => g.id === 'goal-child').parentId).toBe('goal-root');

    // B never saw the delete and kept working on the child after it happened.
    const peerB = tree();
    Object.assign(peerB.goals[2], { progress: 70, updatedAt: '2026-01-06T09:00:00.000Z' });
    const onB = await pull(peerB, await snapshotOf(peerA));
    expect(ids(onB)).toEqual(['goal-root', 'goal-child', 'goal-other']);
    expect(onB.goals.find((g) => g.id === 'goal-child')).toMatchObject({ parentId: 'goal-root', progress: 70 });
    expect(onB.goals.find((g) => g.id === 'goal-other').progress).toBe(40);

    // A then adopts B's newer child; the deleted parent stays gone on both.
    const onA = await pull(peerA, await snapshotOf(onB));
    expect(ids(onA)).toEqual(['goal-root', 'goal-child', 'goal-other']);
    expect(onA.goals.find((g) => g.id === 'goal-child')).toMatchObject({ parentId: 'goal-root', progress: 70 });
    expect(onA.goalTombstones).toEqual(onB.goalTombstones);
  });

  it('loads and merges a legacy document without tombstones, adding the field only on a delete', async () => {
    const legacy = shared();
    const merged = await pull(legacy, { goals: [goal('goal-remote', { updatedAt: '2026-01-03T00:00:00.000Z' })] });
    expect(ids(merged)).toEqual(['goal-example', 'goal-other', 'goal-remote']);
    expect(merged).not.toHaveProperty('goalTombstones');
    expect(await deleteOnPeer(merged, 'goal-remote')).toHaveProperty('goalTombstones', [{ id: 'goal-remote', deletedAt: DELETED_AT }]);
  });
});
