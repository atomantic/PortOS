/**
 * Per-peer tombstone ack cursors for federated peer sync.
 *
 * When a record is soft-deleted (the Stage 1 tombstone refactor), it stays in
 * the JSON file with `{ deleted: true, deletedAt: <iso> }` so the LWW merge
 * can keep it from being resurrected by an out-of-date peer. The tombstone
 * itself is GC'd only once every currently-subscribed peer has acked that it
 * received and applied the deletion — otherwise pruning the tombstone too
 * early lets the next snapshot-sync from a not-yet-aware peer resurrect the
 * record by re-inserting it under its older `updatedAt`.
 *
 * Each cursor tracks two values per peer:
 *   - `lastAckedDeleteAt` — the latest `deletedAt` (ms epoch) the peer has
 *     confirmed receiving. Used by `getMinAckAcrossPeers` to decide which
 *     tombstones are safe to prune.
 *   - `subscribedSince` — the horizon at which the peer first subscribed (ms
 *     epoch). The push pipeline never replays tombstones older than this —
 *     a new peer joining a long-lived federation shouldn't have to ingest
 *     every historical deletion, just the live state plus tombstones it
 *     might still see referenced by stale peers.
 *
 * State file: `data/sharing/peer_tombstone_cursors.json`. The whole file is
 * a small object keyed by peerId, so each write rewrites the file — that's
 * fine at sharing scale (dozens of peers max).
 */

import { join } from 'path';
import { PATHS, atomicWrite, readJSONFile, ensureDir } from '../../lib/fileUtils.js';
import { isPlainObject } from '../../lib/objects.js';

const STATE_PATH = () => join(PATHS.data, 'sharing', 'peer_tombstone_cursors.json');

/**
 * Load the full cursor map. Tolerates a missing or malformed file by
 * returning `{}` — peers that have never sync'd carry no cursor.
 */
async function readState() {
  await ensureDir(join(PATHS.data, 'sharing'));
  const raw = await readJSONFile(STATE_PATH(), {}, { logError: false });
  if (!isPlainObject(raw)) return {};
  // Defensive: a hand-edited file could contain non-object entries.
  const out = {};
  for (const [peerId, cursor] of Object.entries(raw)) {
    if (typeof peerId !== 'string' || !peerId) continue;
    if (!isPlainObject(cursor)) continue;
    out[peerId] = {
      lastAckedDeleteAt: Number.isFinite(cursor.lastAckedDeleteAt) ? cursor.lastAckedDeleteAt : 0,
      subscribedSince: Number.isFinite(cursor.subscribedSince) ? cursor.subscribedSince : 0,
    };
  }
  return out;
}

async function writeState(state) {
  await ensureDir(join(PATHS.data, 'sharing'));
  await atomicWrite(STATE_PATH(), state);
}

/** Returns a snapshot of every peer's cursor. */
export async function listCursors() {
  return readState();
}

/** Returns the cursor for a single peer, or `null` if none is stored. */
export async function getCursor(peerId) {
  if (typeof peerId !== 'string' || !peerId) return null;
  const state = await readState();
  return state[peerId] || null;
}

/**
 * Initialize a peer's cursor on first subscribe. `subscribedSince` sets the
 * horizon so tombstones older than this are never pushed to this peer. If a
 * cursor already exists, keep it — re-subscribing must not reset progress.
 *
 * Pass `now` for testability; defaults to `Date.now()`.
 */
export async function initCursor(peerId, { now = Date.now() } = {}) {
  if (typeof peerId !== 'string' || !peerId) return null;
  const state = await readState();
  if (state[peerId]) return state[peerId];
  state[peerId] = { lastAckedDeleteAt: 0, subscribedSince: now };
  await writeState(state);
  return state[peerId];
}

/**
 * Advance the peer's `lastAckedDeleteAt`. Never moves backward — an out-of-
 * order ack from a delayed retransmit must not retract progress.
 *
 * Returns the persisted cursor (or `null` if `peerId` is invalid).
 */
export async function ackDeletesUpTo(peerId, deletedAtMs, { now = Date.now() } = {}) {
  if (typeof peerId !== 'string' || !peerId) return null;
  if (!Number.isFinite(deletedAtMs) || deletedAtMs < 0) return null;
  const state = await readState();
  const existing = state[peerId] || { lastAckedDeleteAt: 0, subscribedSince: now };
  if (deletedAtMs <= existing.lastAckedDeleteAt) return existing;
  state[peerId] = { ...existing, lastAckedDeleteAt: deletedAtMs };
  await writeState(state);
  return state[peerId];
}

/**
 * Remove a peer's cursor entirely — used when the last subscription to that
 * peer is torn down. Returns `true` if a cursor was removed.
 */
export async function removeCursor(peerId) {
  if (typeof peerId !== 'string' || !peerId) return false;
  const state = await readState();
  if (!(peerId in state)) return false;
  delete state[peerId];
  await writeState(state);
  return true;
}

/**
 * Across the provided peer ids, return the lowest `lastAckedDeleteAt`. A
 * tombstone with `deletedAt <= minAck` is safe to prune — every subscribed
 * peer has acked it. Returns `Infinity` when the peer list is empty (no
 * subscribers → no ack constraint, prune freely after grace).
 *
 * Peers in the list that have no stored cursor count as ack=0 (they haven't
 * received any deletion yet). This is intentional: an in-flight subscriber
 * shouldn't allow GC of a tombstone it might still need.
 */
export async function getMinAckAcrossPeers(peerIds) {
  if (!Array.isArray(peerIds) || peerIds.length === 0) return Infinity;
  const state = await readState();
  let min = Infinity;
  for (const peerId of peerIds) {
    if (typeof peerId !== 'string' || !peerId) continue;
    const cursor = state[peerId];
    const ack = cursor?.lastAckedDeleteAt ?? 0;
    if (ack < min) min = ack;
  }
  return min;
}
