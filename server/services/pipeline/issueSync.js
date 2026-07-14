/**
 * Pipeline — Issue peer-sync merge + tombstone GC (#2531)
 *
 * mergeIssuesFromSync (LWW merge of a remote peer's issues) and
 * pruneTombstonedIssues (tombstone GC). Split out of the former monolithic
 * `issues.js`. Both serialize on the store's single type-index write tail
 * (`store().queueTypeIndexWrite`) for one consistent merge/prune snapshot.
 */

import { isStr } from '../../lib/storyBible.js';
import { emitRecordUpdated } from '../sharing/recordEvents.js';
import * as seriesSvc from './series.js';
import {
  maybeJournalBeforeOverwrite, setSyncBaseHash, contentHashForRecord,
  flushBaseHashes, deleteSyncBaseHash,
} from '../../lib/conflictJournal.js';
import { store, readState, saveIssuesNow, renumberInline, sanitizeIssue } from './issuesShared.js';

/**
 * Sync-orchestrator entry point. Merges a remote peer's issues array into
 * local state through the collection store's type-index queue for one
 * consistent merge snapshot. Each incoming record passes through
 * `sanitizeIssue` for shape enforcement (stage statuses, trimmed fields,
 * valid id format). LWW by `updatedAt`; returns `{ applied, count }` where
 * `count` is the number of issues actually changed/added.
 */
export async function mergeIssuesFromSync(remoteIssues, { source = { via: 'sync', peerId: null } } = {}) {
  if (!Array.isArray(remoteIssues)) return { applied: false, count: 0 };
  // Series IDs whose issue set saw at least one delete-transition — drives a
  // post-write renumber so the receiver's issue numbering catches up with the
  // sender's (otherwise a synced tombstone would leave a gap).
  //
  // Edit-only merges (no delete-transitions) do NOT emit `recordUpdated` for
  // the parent series — see `mergeUniversesFromSync` for the rationale (the
  // Stage 2 per-record peer-sync push owns sync-time edit emits). Delete-
  // transitions DO emit per series so subscribers know to drop the issue.
  const seriesNeedingRenumber = new Set();
  // Build the set of locally-ephemeral series ids BEFORE the queue. The
  // per-record push pipeline (applyIncomingPush) already gates the bundled
  // issues batch by parent-ephemeral, but the snapshot pipeline path
  // (applyPipelineRemote → mergeIssuesFromSync) bypasses that check. Without
  // this filter, a peer with `pipeline` sync enabled can create/update/
  // tombstone issues under a locally-private series and overwrite the
  // user's private fork.
  const ephemeralSeriesIds = new Set(
    (await seriesSvc.listSeries({ includeDeleted: true }).catch(() => []))
      .filter((s) => s?.ephemeral === true)
      .map((s) => s.id),
  );
  return store().queueTypeIndexWrite(async () => {
    const state = await readState();
    const localById = new Map(state.issues.map((i) => [i.id, i]));
    let changed = 0;
    // Track only the issue IDs that were inserted or overwritten so we persist
    // the changed subset rather than every issue in the store (avoids unbounded
    // Promise.all / EMFILE on large catalogs).
    const changedIds = new Set();
    for (const remote of remoteIssues) {
      if (!remote || typeof remote !== 'object' || !isStr(remote.id)) continue;
      // Drop issues whose parent series is locally ephemeral, BEFORE any
      // mutation. This covers create/update/tombstone uniformly — the
      // sanitized.seriesId may be either the existing local series or a
      // remote-only target; reject either way.
      if (ephemeralSeriesIds.has(remote.seriesId)) continue;
      const sanitized = sanitizeIssue(remote);
      if (!sanitized) continue;
      // Strip inbound `ephemeral` — see mergeUniversesFromSync.
      if ('ephemeral' in sanitized) delete sanitized.ephemeral;
      const local = localById.get(sanitized.id);
      // Belt-and-suspenders: if the existing local issue belongs to an
      // ephemeral series, refuse the merge even though the inbound
      // sanitized.seriesId might point elsewhere (a peer could ship an
      // issue id whose local copy is under a private series and try to
      // move it).
      if (local && ephemeralSeriesIds.has(local.seriesId)) continue;
      if (!local) {
        // No local counterpart — accept the record but don't trigger a
        // renumber pass. A tombstone for an issue we never had has nothing
        // to compact; firing `emitRecordUpdated('series', …)` for a series
        // we may not even own would spuriously re-export.
        localById.set(sanitized.id, sanitized);
        // Seed the conflict-journal base hash so a FUTURE divergence on this
        // issue is detected. Issues are pushed under their parent series'
        // subscription, so peerSync never seeds an `issue`-keyed base hash —
        // this merge path (and the importer) own it.
        await setSyncBaseHash('issue', sanitized.id, contentHashForRecord('issue', sanitized));
        changedIds.add(sanitized.id);
        changed++;
      } else if (local.ephemeral === true) {
        // Local-ephemeral issues are immune to inbound merges. See
        // mergeUniversesFromSync for the contract.
        continue;
      } else {
        const localTs = local.updatedAt || '';
        const remoteTs = sanitized.updatedAt || '';
        if (remoteTs > localTs) {
          // Non-blocking conflict journal — archive the losing local issue on
          // a true 3-way divergence; always advances the base hash. Never
          // throws into the merge (convergence wins).
          await maybeJournalBeforeOverwrite({ kind: 'issue', id: sanitized.id, local, remote: sanitized, source });
          localById.set(sanitized.id, sanitized);
          changedIds.add(sanitized.id);
          // Renumber on EITHER direction of the transition: a delete leaves
          // a gap, a resurrection (deleted→live) reintroduces a previously-
          // compacted number and can collide with live siblings until some
          // unrelated edit triggers a renumber. Cover both here.
          if (sanitized.deleted !== local.deleted) {
            seriesNeedingRenumber.add(sanitized.seriesId);
            // A resurrection may move from the OLD seriesId to a different
            // one in the inbound record (rare, but possible) — renumber both.
            if (local.seriesId && local.seriesId !== sanitized.seriesId) {
              seriesNeedingRenumber.add(local.seriesId);
            }
          }
          changed++;
        }
      }
    }
    if (changed === 0) return { applied: false, count: 0 };
    state.issues = Array.from(localById.values());
    // Compact issue numbers for each affected series — the merge may have
    // tombstoned (gap) or resurrected (collision) an issue. renumberInline
    // skips tombstones, so the resulting numbering is always contiguous
    // across live issues. Single renumber per series, all inside the queue.
    // renumberInline updates state.issues in-place; collect the renumbered
    // issue ids so they are also persisted.
    for (const seriesId of seriesNeedingRenumber) {
      const before = new Map(state.issues.map((i) => [i.id, i.number]));
      await renumberInline(state, seriesId, null);
      for (const i of state.issues) {
        if (i.seriesId === seriesId && i.number !== before.get(i.id)) {
          changedIds.add(i.id);
        }
      }
    }
    // Persist only the issues that were actually changed/renumbered, not the
    // entire catalog — avoids EMFILE + write-amplification on large stores.
    const changedIssues = state.issues.filter((i) => changedIds.has(i.id));
    await saveIssuesNow(changedIssues);
    // Re-emit a series-updated for each touched series so any active share
    // subscription re-exports the post-merge issue set.
    for (const seriesId of seriesNeedingRenumber) {
      emitRecordUpdated('series', seriesId);
    }
    // Persist the batched conflict-journal base-hash updates (seeds on insert,
    // advances on overwrite) accumulated in the loop above.
    await flushBaseHashes();
    return { applied: true, count: changed };
  });
}

/**
 * Garbage-collect issue tombstones older than `beforeMs`. See
 * `pruneTombstonedUniverses` for the contract — pure mechanical prune; the
 * caller owns the policy. Tombstones with unparseable `deletedAt` are kept.
 *
 * Issue tombstones ride series pushes (the receiver bundles child issues
 * with each series push) so the relevant ack horizon is "peers subscribed
 * to the parent series." The caller resolves that.
 */
export async function pruneTombstonedIssues(beforeMs) {
  if (!Number.isFinite(beforeMs)) return { pruned: 0 };
  return store().queueTypeIndexWrite(async () => {
    const { issues } = await readState();
    const prunable = issues.filter((i) => {
      if (!i?.deleted) return false;
      const t = Date.parse(i.deletedAt || '');
      if (!Number.isFinite(t)) return false;
      return t < beforeMs;
    });
    await Promise.all(prunable.map((i) => store().deleteOne(i.id)));
    // Evict each pruned issue's conflict-journal base hash. Issues seed an
    // `issue:<id>` base hash when their parent series is pushed (peerSync's
    // pushRecordToPeer), but no eviction existed — so a pruned issue's key
    // would linger in sync_base_hashes.json forever. Mirrors the universe /
    // series / collection prune paths.
    await Promise.all(prunable.map((i) => deleteSyncBaseHash('issue', i.id)));
    return { pruned: prunable.length };
  });
}
