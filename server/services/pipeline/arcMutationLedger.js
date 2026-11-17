/**
 * Rollback OWNERSHIP for the gates that revert an arc round they just verified
 * (`seriesAutopilot/childRuns.js`, `foundationJudge.js`).
 *
 * `restoreArcState` cannot tell who wrote a difference from a snapshot, so a
 * write from elsewhere mid-round was reverted with the candidate. The resolver
 * reports its episode writes (`resolvedEpisodeEdits`); a rollback gets exactly
 * those recorded AFTER its snapshot. One ledger spans a whole gate because a
 * checkpoint outlives its round. Pure apart from closed-over state.
 */

// A gate-lifetime ledger of resolver-owned episode writes:
//   hold(snapshot)  -> mark where this snapshot sits in the write history
//   note(edits)     -> append one resolve pass's writes
//   since(snapshot) -> writes recorded after that snapshot was held
// A WeakMap keys snapshots; a never-held one yields no writes (restores nothing).
// Nothing is removed: undone writes are skipped by the restore's own "still the
// value the resolver wrote?" check.
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
