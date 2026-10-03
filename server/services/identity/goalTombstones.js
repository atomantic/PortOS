/**
 * Goal deletion tombstones for the `goals` snapshot category (#9816).
 *
 * The goals snapshot merges by union (a goal present on either peer survives),
 * which cannot represent a delete: absence is not a signal, so the peer that
 * still holds the goal re-adds it on the next sync. A deletion therefore leaves
 * `{ id, deletedAt }` in the goals document itself (under `goalTombstones`,
 * written inside the same serialized goals queue as the delete). The list rides
 * every snapshot, unions in both directions, and suppresses a stale live copy.
 *
 * Rules, all inherited from `lib/tombstones.js`:
 *  - Timestamps parse to epoch ms; an unparseable stamp never wins.
 *  - A goal survives its tombstone only when its own live stamp (the newer of
 *    `createdAt` / `updatedAt`) is STRICTLY newer than `deletedAt` — i.e. it was
 *    edited or re-created after the deletion. That edit is the explicit
 *    "restoration" rule: a delete beats every copy that has not been touched
 *    since, and an edit made after it beats the delete and retires the
 *    tombstone so it cannot bounce back from a peer that has not seen the edit.
 *  - A legacy document with no `goalTombstones` field is an empty list. No
 *    migration invents past deletions, and the field is only written once a
 *    delete (or a peer's tombstone) puts something in it.
 *
 * Resurrection horizon: the list is capped at `DEFAULT_TOMBSTONE_LIMIT` (200)
 * deletions, oldest dropped first. A peer that stays offline across more than
 * that many later goal deletions can resurrect an old one — a bounded document
 * is preferred over unbounded growth. An older (pre-#9816) receiver ignores the
 * field entirely, so it cannot enforce a deletion until it is upgraded; an
 * upgraded receiver keeps the tombstones it already holds when such a peer omits
 * them.
 */

import { compareNewerWins, parseTsMs } from '../../lib/lwwTimestamp.js';
import {
  isTombstoned,
  pruneTombstones,
  recordTombstone,
  supersedingTimestamp,
  tombstoneTimestamp,
} from '../../lib/tombstones.js';

/** Top-level `goals.json` field holding `{ id, deletedAt }` goal tombstones. */
export const GOAL_TOMBSTONES_KEY = 'goalTombstones';

const KEY_FIELD = 'id';

/**
 * The newer of a goal's `createdAt` and `updatedAt` — the instant a deletion has
 * to beat. Null for a legacy goal carrying neither stamp.
 */
export function goalLiveStamp(goal) {
  const { createdAt, updatedAt } = goal || {};
  if (compareNewerWins(createdAt, updatedAt)) return createdAt;
  return parseTsMs(updatedAt) === null ? null : updatedAt;
}

/**
 * Record that `goal` was deleted from `doc` (the goals document). The stamp is
 * kept past the goal's own live stamp so the deletion wins over the copy the
 * user was looking at even when a peer that last edited it ran a clock ahead.
 * Mutates `doc`; call it inside the goals write queue.
 */
export function tombstoneGoal(doc, goal, now = new Date().toISOString()) {
  if (typeof goal?.id !== 'string' || !goal.id) return;
  const deletedAt = supersedingTimestamp(goalLiveStamp(goal), now);
  doc[GOAL_TOMBSTONES_KEY] = recordTombstone(doc[GOAL_TOMBSTONES_KEY], goal.id, { keyField: KEY_FIELD, deletedAt });
}

/**
 * Apply a tombstone list to a goals array. Pure: returns new arrays and never
 * mutates its inputs.
 *
 *  1. Goals the tombstones cover (and that were not edited after the deletion)
 *     are removed.
 *  2. Their children are reparented to the deleted goal's own parent (walking up
 *     through any other removed goal) — the same cleanup `deleteGoal` performs
 *     locally, replayed when a deletion arrives from a peer. The reparent is
 *     stamped deterministically (`supersedingTimestamp` over the child's own
 *     stamp, anchored on the tombstone) so every peer computes the same record
 *     and a replay settles instead of ping-ponging. It only runs when this side
 *     still holds the removed goal's record: without it the parent is unknown and
 *     the child is left as it is (a missing parent already renders as a root).
 *  3. Tombstones a surviving goal has superseded are pruned.
 *
 * @returns {{ goals: object[], tombstones: object[] }}
 */
export function reconcileGoalTombstones(goals, tombstones) {
  const list = Array.isArray(goals) ? goals : [];
  const removed = new Map();
  const survivors = [];
  for (const goal of list) {
    if (typeof goal?.id === 'string' && goal.id && isTombstoned(tombstones, goal.id, goalLiveStamp(goal), KEY_FIELD)) {
      removed.set(goal.id, goal);
    } else {
      survivors.push(goal);
    }
  }

  const reparented = removed.size === 0 ? survivors : survivors.map((goal) => {
    const parent = removed.get(goal?.parentId);
    if (!parent) return goal;
    // Nearest ancestor still alive; `seen` also stops a corrupt parent cycle.
    const seen = new Set([goal.id, goal.parentId]);
    let nextParentId = parent.parentId || null;
    while (nextParentId && removed.has(nextParentId) && !seen.has(nextParentId)) {
      seen.add(nextParentId);
      nextParentId = removed.get(nextParentId).parentId || null;
    }
    if (nextParentId && seen.has(nextParentId)) nextParentId = null;
    const deletedAt = tombstoneTimestamp(tombstones, goal.parentId, KEY_FIELD);
    return { ...goal, parentId: nextParentId, updatedAt: supersedingTimestamp(goal.updatedAt, deletedAt) };
  });

  const stamps = reparented.map((goal) => ({ id: goal?.id, stamp: goalLiveStamp(goal) }));
  return {
    goals: reparented,
    tombstones: pruneTombstones(tombstones, stamps, { keyField: KEY_FIELD, timestampField: 'stamp' }),
  };
}
