/**
 * Rollback OWNERSHIP for the gates that revert an arc round they just verified —
 * the autopilot's arc gate (`seriesAutopilot/childRuns.js`) and the foundation
 * gate's structure repair (`foundationJudge.js`). It sits beside them rather
 * than inside `seriesAutopilot/` because the autopilot already imports the
 * foundation judge; a shared helper one level down would point the dependency
 * back the way it came.
 *
 * `restoreArcState` can put an episode's planning synopsis back, but nothing in
 * a snapshot says who wrote the difference: the rollback used to treat every
 * episode that differed from the pre-resolve snapshot as the rejected round's
 * own work, so a write that arrived from anywhere else during the round's
 * several provider calls was reverted with the candidate. The arc-SPINE gate
 * made that visible — its resolver may not touch episodes at all, yet a paused
 * run reported `resolve:round episodesEdited: 0` followed by
 * `resolve:rollback episodesReverted: 1`.
 *
 * This ledger is the answer: the resolver reports the episodes it wrote (see
 * `resolvedEpisodeEdits`), and a rollback is handed exactly the writes recorded
 * AFTER its snapshot was taken. Everything else in the store keeps whatever it
 * has.
 *
 * One ledger serves a whole gate — the arc gate's round loop AND its per-finding
 * isolation pass, or the structure repair's first resolve AND its bounded
 * correction passes — because a checkpoint outlives the round that took it:
 * rewinding to a `bestVerified` from three rounds back has to undo every
 * resolve that landed since. Two hand-rolled accumulators is how they drift
 * while a reader assumes they haven't (the same argument
 * `seriesAutopilot/discardedEvidence.js` makes for findings evidence).
 *
 * Pure except for the ledger's own closed-over state: no I/O, no broadcast, and
 * no import of the arc planner — the caller derives the writes and hands them
 * over, so this stays a bookkeeping module rather than a second door into the
 * store graph.
 */

/**
 * A gate-lifetime ledger of resolver-owned episode writes.
 *
 *   hold(snapshot)  → mark where this snapshot sits in the write history
 *   note(edits)     → append one resolve pass's writes
 *   since(snapshot) → the writes recorded after that snapshot was held
 *
 * Snapshots are keyed in a `WeakMap`, so holding one costs nothing and the
 * ledger never keeps a snapshot (arc + volumes + every episode's synopsis)
 * alive past the caller's own reference to it. A snapshot that was never held
 * yields no writes, which restores no episode at all — the conservative answer,
 * since an unheld snapshot is one this ledger cannot vouch for.
 *
 * Nothing is ever removed. A write a rollback already undid stays in the
 * history and is simply skipped by the restore's own "is this still the value
 * the resolver wrote?" check, so there is no clear-after-restore rule for a
 * caller to forget.
 */
export function createArcMutationLedger() {
  const writes = [];
  const heldAt = new WeakMap();

  return {
    hold: (snapshot) => {
      if (snapshot) heldAt.set(snapshot, writes.length);
      return snapshot;
    },
    note: (edits) => {
      if (Array.isArray(edits) && edits.length) writes.push(...edits);
    },
    since: (snapshot) => {
      const from = snapshot ? heldAt.get(snapshot) : undefined;
      return from === undefined ? [] : writes.slice(from);
    },
  };
}
