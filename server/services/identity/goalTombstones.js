/**
 * Goal deletion tombstones for the `goals` snapshot category (#9816).
 *
 * The goals snapshot merges by union, which cannot represent a delete (the peer still
 * holding the goal re-adds it). A deletion therefore leaves `{ id, deletedAt }` in the goals
 * document under `goalTombstones`, written inside the goals write queue; the list unions in
 * both directions and suppresses a stale live copy. Rules, inherited from `lib/tombstones.js`:
 *  - Timestamps parse to epoch ms; an unparseable stamp never wins.
 *  - A goal survives its tombstone only when its live stamp (newer of `createdAt` /
 *    `updatedAt`) is STRICTLY newer than `deletedAt`: an edit after the delete beats it.
 *  - A legacy document with no `goalTombstones` field is an empty list; no migration.
 *
 * Resurrection horizon: capped at `DEFAULT_TOMBSTONE_LIMIT` (200), oldest dropped first, so
 * a peer offline across more later deletions can resurrect an old goal. A pre-#9816 receiver
 * ignores the field; an upgraded one keeps tombstones it holds when such a peer omits them.
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
function goalLiveStamp(goal) {
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
 * Apply a tombstone list to a goals array. Pure: returns new arrays.
 *
 *  1. Goals the tombstones cover (and not edited after the deletion) are removed.
 *  2. Their children are reparented to the deleted goal's own parent (walking up through
 *     other removed goals), replaying `deleteGoal`'s cleanup for a peer's deletion. The
 *     stamp is deterministic (`supersedingTimestamp` anchored on the tombstone) so peers
 *     converge. Only runs when this side still holds the removed goal's record; otherwise
 *     the child is left alone (a missing parent renders as a root).
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
