import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// Redirect PATHS.data to a per-test tmpdir so each test gets a clean
// peer_tombstone_cursors.json without stomping on real data.
import { PATHS } from '../../lib/fileUtils.js';
import {
  listCursors,
  getCursor,
  initCursor,
  ackDeletesUpTo,
  removeCursor,
  getMinAckAcrossPeers,
  __drainForTests,
} from './peerTombstoneCursors.js';

let originalDataPath;
let tmp;

beforeEach(async () => {
  originalDataPath = PATHS.data;
  tmp = join(tmpdir(), `portos-peer-cursors-${Date.now()}-${Math.random()}`);
  await mkdir(join(tmp, 'sharing'), { recursive: true });
  PATHS.data = tmp;
});

afterEach(async () => {
  // Drain any in-flight cursor writes before rm-rf'ing the tmpdir.
  await __drainForTests();
  await rm(tmp, { recursive: true, force: true });
  PATHS.data = originalDataPath;
});

describe('peerTombstoneCursors', () => {
  describe('readState resilience', () => {
    it('returns {} for a missing file', async () => {
      expect(await listCursors()).toEqual({});
    });

    it('tolerates a non-object root and returns {} (defensive against hand-edits)', async () => {
      await writeFile(join(PATHS.data, 'sharing', 'peer_tombstone_cursors.json'), '"not an object"');
      expect(await listCursors()).toEqual({});
    });

    it('skips non-object cursor entries from a corrupted file', async () => {
      await writeFile(
        join(PATHS.data, 'sharing', 'peer_tombstone_cursors.json'),
        JSON.stringify({ ok: { lastAckedDeleteAt: 5, subscribedSince: 1 }, bad: 'string' }),
      );
      const state = await listCursors();
      expect(state.ok).toEqual({ lastAckedDeleteAt: 5, subscribedSince: 1 });
      expect(state.bad).toBeUndefined();
    });

    it('defaults non-finite numeric fields to 0', async () => {
      await writeFile(
        join(PATHS.data, 'sharing', 'peer_tombstone_cursors.json'),
        JSON.stringify({ p: { lastAckedDeleteAt: 'not-a-num', subscribedSince: null } }),
      );
      expect(await getCursor('p')).toEqual({ lastAckedDeleteAt: 0, subscribedSince: 0 });
    });
  });

  describe('initCursor', () => {
    it('creates a cursor with subscribedSince=now and lastAckedDeleteAt=0', async () => {
      const result = await initCursor('peer-a', { now: 1000 });
      expect(result).toEqual({ lastAckedDeleteAt: 0, subscribedSince: 1000 });
      // Verify persisted
      expect(await getCursor('peer-a')).toEqual({ lastAckedDeleteAt: 0, subscribedSince: 1000 });
    });

    it('is idempotent — re-init never resets progress', async () => {
      await initCursor('peer-a', { now: 1000 });
      await ackDeletesUpTo('peer-a', 5000);
      // Re-subscribe; cursor must NOT be reset (would lose ack progress).
      const reInited = await initCursor('peer-a', { now: 9999 });
      expect(reInited).toEqual({ lastAckedDeleteAt: 5000, subscribedSince: 1000 });
    });

    it('null for invalid peerId', async () => {
      expect(await initCursor('')).toBeNull();
      expect(await initCursor(null)).toBeNull();
      expect(await initCursor(42)).toBeNull();
    });
  });

  describe('ackDeletesUpTo', () => {
    it('advances lastAckedDeleteAt when newer', async () => {
      await initCursor('peer-a', { now: 1000 });
      const result = await ackDeletesUpTo('peer-a', 5000);
      expect(result.lastAckedDeleteAt).toBe(5000);
      expect(result.subscribedSince).toBe(1000);
    });

    it('never moves backward — an out-of-order ack from a delayed retransmit is ignored', async () => {
      await initCursor('peer-a', { now: 1000 });
      await ackDeletesUpTo('peer-a', 5000);
      const result = await ackDeletesUpTo('peer-a', 3000);
      expect(result.lastAckedDeleteAt).toBe(5000);
    });

    it('treats equal-value ack as a no-op (returns current state)', async () => {
      await initCursor('peer-a', { now: 1000 });
      await ackDeletesUpTo('peer-a', 5000);
      const result = await ackDeletesUpTo('peer-a', 5000);
      expect(result.lastAckedDeleteAt).toBe(5000);
    });

    it('initializes a cursor on first ack if one does not exist', async () => {
      const result = await ackDeletesUpTo('peer-a', 5000, { now: 2000 });
      expect(result).toEqual({ lastAckedDeleteAt: 5000, subscribedSince: 2000 });
    });

    it('null for invalid args', async () => {
      expect(await ackDeletesUpTo('', 100)).toBeNull();
      expect(await ackDeletesUpTo('peer-a', NaN)).toBeNull();
      expect(await ackDeletesUpTo('peer-a', -1)).toBeNull();
      expect(await ackDeletesUpTo('peer-a', 'not-a-number')).toBeNull();
    });

    it('serializes concurrent acks so the highest deletedAtMs always wins (no clobber)', async () => {
      // Regression: without the cursor write-lock, two concurrent acks both
      // read the pre-existing lastAckedDeleteAt, each correctly chooses the
      // higher value, but the LATER writer clobbers the EARLIER writer's
      // update. The persisted cursor then reflects only one of the two acks.
      await Promise.all([
        ackDeletesUpTo('peer-a', 100),
        ackDeletesUpTo('peer-a', 5000),
        ackDeletesUpTo('peer-a', 2500),
        ackDeletesUpTo('peer-a', 9999),
        ackDeletesUpTo('peer-a', 750),
      ]);
      const cursor = await getCursor('peer-a');
      expect(cursor.lastAckedDeleteAt).toBe(9999);
    });
  });

  describe('removeCursor', () => {
    it('removes an existing cursor and returns true', async () => {
      await initCursor('peer-a', { now: 1000 });
      expect(await removeCursor('peer-a')).toBe(true);
      expect(await getCursor('peer-a')).toBeNull();
    });

    it('returns false when no cursor exists for the peer', async () => {
      expect(await removeCursor('peer-a')).toBe(false);
    });
  });

  describe('getMinAckAcrossPeers', () => {
    it('returns Infinity for an empty peer list (no GC constraint when nobody is subscribed)', async () => {
      // Critical: tombstones with no subscribers can be pruned freely after
      // grace. Returning 0 here would block all GC forever.
      expect(await getMinAckAcrossPeers([])).toBe(Infinity);
      expect(await getMinAckAcrossPeers(null)).toBe(Infinity);
    });

    it('returns the minimum across known peers', async () => {
      await ackDeletesUpTo('peer-a', 1000, { now: 0 });
      await ackDeletesUpTo('peer-b', 5000, { now: 0 });
      await ackDeletesUpTo('peer-c', 3000, { now: 0 });
      expect(await getMinAckAcrossPeers(['peer-a', 'peer-b', 'peer-c'])).toBe(1000);
    });

    it('counts a peer with no stored cursor as ack=0 (in-flight subscriber must not unblock GC)', async () => {
      // Regression: if a new peer just subscribed but hasn't acked anything,
      // pruning every tombstone deletedAt > 0 would silently drop deletions
      // the peer should still receive.
      await ackDeletesUpTo('peer-a', 1000, { now: 0 });
      expect(await getMinAckAcrossPeers(['peer-a', 'peer-b-fresh'])).toBe(0);
    });

    it('skips invalid peer-id entries silently', async () => {
      await ackDeletesUpTo('peer-a', 1000, { now: 0 });
      expect(await getMinAckAcrossPeers(['peer-a', '', null])).toBe(1000);
    });
  });
});
