/**
 * End-to-end cover for the deleted-social-account tombstone (#3532): an account
 * the user deletes must stay deleted across a peer sync with a machine that
 * still has it, the delete must PROPAGATE to that machine, and re-adding the
 * same handle afterwards must not be suppressed.
 *
 * Exercises the real disk path (social-accounts.json) with PATHS pointed at a
 * temp dir, so the service's cached store, the merge, and the sync apply all run.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { rmSync } from 'fs';
import { join } from 'path';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// socialAccounts.js and digital-twin-sync.js both capture PATHS.digitalTwin at
// module load, so the root is fixed for the whole file and per-test isolation
// comes from wiping the dir + the store cache in beforeEach.
const tempRoot = createTempDataRoot('portos-social-tombstone-');
const twinDir = join(tempRoot, 'digital-twin');

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makePathsProxy(actual, {
    dataRoot: tempRoot,
    extraOverrides: (root) => ({ digitalTwin: join(root, 'digital-twin') }),
  });
});

const { createAccount, updateAccount, deleteAccount, getAllAccounts, loadAccounts, invalidateCache } =
  await import('./socialAccounts.js');
const { applyDigitalTwinRemote, getDigitalTwinSnapshot, mergeSocialAccounts } = await import('./digital-twin-sync.js');

const newAccount = () => createAccount({ platform: 'github', username: 'example-user' });

// createAccount returns `{ id, ...account }`; on disk the id is the map key only.
const stripId = ({ id, ...rest }) => rest;

/** The snapshot a peer that still holds the account would ship. */
const peerSnapshotWith = (account) => ({
  socialAccounts: { accounts: { [account.id]: stripId(account) }, deletedAccounts: [] },
});

const accountIds = async () => (await getAllAccounts()).map((a) => a.id);
const tombstoneIds = async () => ((await loadAccounts()).deletedAccounts || []).map((t) => t.id);

beforeEach(() => {
  rmSync(twinDir, { recursive: true, force: true });
  invalidateCache();
});

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe('social account tombstones (#3532)', () => {
  it('records a tombstone on delete and keeps the account deleted through a peer sync', async () => {
    const created = await newAccount();
    const peer = peerSnapshotWith(created);

    expect(await deleteAccount(created.id)).toBe(true);
    expect(await accountIds()).not.toContain(created.id);
    expect(await tombstoneIds()).toEqual([created.id]);

    // The peer still has the account and ships it back — the pre-#3532 bug.
    await applyDigitalTwinRemote(peer);
    expect(await accountIds()).not.toContain(created.id);

    // …and it stays deleted on every subsequent cycle, not just the first.
    await applyDigitalTwinRemote(peer);
    expect(await accountIds()).not.toContain(created.id);
    expect(await tombstoneIds()).toEqual([created.id]);
  });

  it('ships tombstones in the snapshot so peers can see the delete', async () => {
    const created = await newAccount();
    await deleteAccount(created.id);

    const { data } = await getDigitalTwinSnapshot();
    expect(data.socialAccounts.deletedAccounts.map((t) => t.id)).toEqual([created.id]);
    expect(Object.keys(data.socialAccounts.accounts)).not.toContain(created.id);
  });

  it("propagates a peer's delete: removes the local account entry", async () => {
    const created = await newAccount();

    const { applied } = await applyDigitalTwinRemote({
      socialAccounts: {
        accounts: {},
        deletedAccounts: [{ id: created.id, deletedAt: new Date(Date.now() + 60_000).toISOString() }],
      },
    });

    expect(applied).toBe(true);
    expect(await accountIds()).not.toContain(created.id);
    expect(await tombstoneIds()).toEqual([created.id]);
  });

  it('does not suppress an account re-added after the delete', async () => {
    const created = await newAccount();
    await deleteAccount(created.id);
    const staleTombstones = (await loadAccounts()).deletedAccounts;
    expect(staleTombstones).toHaveLength(1);

    // Re-adding the same handle mints a FRESH id, so a natural (platform+handle)
    // key would have wrongly suppressed it — the id key does not.
    const readded = await newAccount();
    expect(readded.id).not.toBe(created.id);

    // A peer that has not seen the re-add still ships the old tombstone.
    await applyDigitalTwinRemote({ socialAccounts: { accounts: {}, deletedAccounts: staleTombstones } });

    expect(await accountIds()).toContain(readded.id);
    expect(await tombstoneIds()).toEqual([created.id]);
  });

  it('keeps an account edited here after another machine deleted it, and drops the stale tombstone', async () => {
    const created = await newAccount();
    const edited = await updateAccount(created.id, { username: 'renamed-user' });

    // The peer's delete predates our edit, so the edit is the user's last word.
    const deletedAt = new Date(Date.parse(edited.updatedAt) - 1_000).toISOString();
    await applyDigitalTwinRemote({ socialAccounts: { accounts: {}, deletedAccounts: [{ id: created.id, deletedAt }] } });

    expect(await accountIds()).toContain(created.id);
    expect(await tombstoneIds()).toEqual([]);
  });

  it('still accepts an account the peer has that was never deleted here', async () => {
    await applyDigitalTwinRemote({
      socialAccounts: {
        accounts: { 'peer-1': { platform: 'x', username: 'example-user', updatedAt: '2026-01-01T00:00:00.000Z' } },
        deletedAccounts: [],
      },
    });
    expect(await accountIds()).toContain('peer-1');
  });
});

describe('mergeSocialAccounts tombstone semantics (#3532)', () => {
  const T1 = '2026-01-01T00:00:00.000Z';
  const T2 = '2026-02-01T00:00:00.000Z';

  it('unions tombstones in both directions and reaps the covered account', () => {
    const local = { accounts: { a1: { username: 'alice', createdAt: T1, updatedAt: T1 } }, deletedAccounts: [] };
    const remote = { accounts: {}, deletedAccounts: [{ id: 'a1', deletedAt: T2 }] };

    const { merged, changed } = mergeSocialAccounts(local, remote);
    expect(changed).toBe(true);
    expect(merged.accounts).toEqual({});
    expect(merged.deletedAccounts).toEqual([{ id: 'a1', deletedAt: T2 }]);
  });

  it('reports no change when neither the accounts nor the tombstones move', () => {
    const local = { accounts: { a1: { username: 'alice', updatedAt: T2 } }, deletedAccounts: [{ id: 'a2', deletedAt: T1 }] };
    const remote = { accounts: { a1: { username: 'older', updatedAt: T1 } }, deletedAccounts: [{ id: 'a2', deletedAt: T1 }] };
    expect(mergeSocialAccounts(local, remote).changed).toBe(false);
  });

  it('treats an older peer that sends no deletedAccounts as an empty list, not a clear', () => {
    const local = { accounts: {}, deletedAccounts: [{ id: 'a1', deletedAt: T1 }] };
    const { merged, changed } = mergeSocialAccounts(local, { accounts: { a1: { username: 'alice' } } });
    expect(changed).toBe(false);
    expect(merged.deletedAccounts).toEqual([{ id: 'a1', deletedAt: T1 }]);
    expect(merged.accounts).toEqual({});
  });

  it('converges: two peers merging each other reach the same state and then stay put', () => {
    // A deleted a1 and added a3; B still has a1, edited a2, and deleted nothing.
    let a = {
      accounts: { a2: { username: 'bob', createdAt: T1, updatedAt: T1 }, a3: { username: 'carol', createdAt: T2, updatedAt: T2 } },
      deletedAccounts: [{ id: 'a1', deletedAt: T2 }],
    };
    let b = {
      accounts: {
        a1: { username: 'alice', createdAt: T1, updatedAt: T1 },
        a2: { username: 'bob-edited', createdAt: T1, updatedAt: T2 },
      },
      deletedAccounts: [],
    };

    for (let round = 0; round < 2; round++) {
      const nextA = mergeSocialAccounts(a, b).merged;
      const nextB = mergeSocialAccounts(b, a).merged;
      a = nextA;
      b = nextB;
    }

    expect(a.accounts).toEqual(b.accounts);
    expect(a.deletedAccounts).toEqual(b.deletedAccounts);
    expect(Object.keys(a.accounts).sort()).toEqual(['a2', 'a3']);
    expect(a.accounts.a2.username).toBe('bob-edited'); // B's later edit won
    expect(a.deletedAccounts).toEqual([{ id: 'a1', deletedAt: T2 }]);

    // Fixed point: another exchange changes nothing on either side.
    expect(mergeSocialAccounts(a, b).changed).toBe(false);
    expect(mergeSocialAccounts(b, a).changed).toBe(false);
  });
});
