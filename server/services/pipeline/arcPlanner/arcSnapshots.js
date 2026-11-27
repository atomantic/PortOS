// Captures and restores the series and episode fields an arc resolution can change.

import { getSeries, updateSeries } from '../series.js';
import { listIssuesForSeries, recomputeIssueNumbersForSeries, updateIssue, updateStagesWithLatest } from '../issues.js';
import { emitRecordUpdated, withReexportSuppressed } from '../../sharing/recordEvents.js';

export const EPISODE_METADATA_FIELDS = ['arcRole', 'lengthProfile', 'pageTarget', 'minutesTarget'];
export const episodeMetadataOf = (issue) => Object.fromEntries(EPISODE_METADATA_FIELDS.map((field) => [field, issue[field] ?? null]));

// The three `idea`-stage fields an auto-resolve round can rewrite, normalized so
// the snapshot and the restore's dirty-check read the record the same way — a
// fourth field would otherwise have to be added to two hand-rolled default lists
// kept in lockstep.
export const ideaSnapshotOf = (stage) => ({
  input: stage?.input ?? '',
  output: stage?.output ?? '',
  status: stage?.status ?? 'empty',
});

const sameIdea = (a, b) => a.input === b.input && a.output === b.output && a.status === b.status;

/**
 * The episode-synopsis writes ONE resolve pass actually landed, as
 * `[{ issueId, idea?, metadata?, metadataGuard? }]` — the exact-mutation manifest a rollback needs so it can
 * tell its own round's edits from a write that arrived from somewhere else while
 * the verification was running. Derived from the applier's own report — an entry
 * carries `idea` only when the write went through, never when it was skipped or
 * failed — so the manifest cannot claim an edit that never happened.
 *
 * Empty for an arc-spine round: that gate's resolver may not touch episodes at
 * all (`selectFindingKeyedEdits` discards them), which is exactly why a
 * spine-scope rollback must leave every episode `idea` field alone.
 */
export const resolvedEpisodeEdits = (resolved) => (Array.isArray(resolved?.episodesResolved)
  ? resolved.episodesResolved
    .filter((entry) => entry?.issueId && (entry.idea || entry.metadata))
    .map((entry) => ({
      issueId: entry.issueId,
      ...(entry.idea ? { idea: entry.idea } : {}),
      ...(entry.metadata ? { metadata: entry.metadata, metadataGuard: entry.metadataGuard } : {}),
    }))
  : []);

// Every issue in the series, without per-stage run history: `listIssues` caps at
// 1000 (a longer series would lose its tail from the snapshot, making those
// episodes unrestorable) and carries history payloads this projection throws
// away. Shared by the snapshot and the restore.
const listEpisodesForSnapshot = (seriesId) => listIssuesForSeries(seriesId, { withHistory: false });

/**
 * Capture everything ONE auto-resolve round can rewrite — the series arc,
 * per-character arcs, volume records, and each episode's planning synopsis and role/length metadata
 * (plus which volume it sits under) — so a round that leaves verification WORSE
 * can be reverted instead of committed. Read-only; the caller holds the snapshot
 * for the duration of the round (see `runArcVerify`'s regression guard).
 *
 * Deep-cloned: `getSeries` hands back the store record un-cloned, and a snapshot
 * that aliases the record it is meant to restore is no snapshot at all.
 */
export async function snapshotArcState(seriesId) {
  const [series, issues] = await Promise.all([getSeries(seriesId), listEpisodesForSnapshot(seriesId)]);
  return {
    seriesId,
    arc: structuredClone(series.arc ?? null),
    characterArcs: structuredClone(series.characterArcs || []),
    seasons: structuredClone(series.seasons || []),
    episodes: issues.map((iss) => ({
      id: iss.id,
      seasonId: iss.seasonId ?? null,
      idea: ideaSnapshotOf(iss.stages?.idea),
      metadata: episodeMetadataOf(iss),
    })),
  };
}

/**
 * Put a `snapshotArcState` capture back, restoring only what actually differs:
 * the series arc, per-character arcs, volume list, any episode whose volume the
 * round re-pointed, and any episode synopsis the round rewrote. Returns what it
 * touched.
 *
 * Deliberately NOT routed through `commitSeasonsWithRemap`: that path merges,
 * preserves and re-mints, which is right for applying a rewrite and wrong for
 * undoing one — a rollback wants the exact prior record back, and it restores
 * the child issues' `seasonId` itself so a volume the round minted can't strand
 * the episodes it took. For the same reason it doesn't re-check `locked.arc`:
 * the arc was writable when the round ran, and refusing to undo that round's
 * damage because a lock flipped mid-run would strand the user with the damage.
 * A locked `idea` stage IS skipped — the resolve pass never touched it.
 *
 * `options.episodeEdits` is the round's exact mutation manifest (see
 * `resolvedEpisodeEdits`): pass it and only those episodes' recorded idea and
 * metadata changes are eligible, and only while the value the resolver wrote is still the one
 * standing — "differs from the snapshot" was never proof the round owned the
 * difference. Two deliberate limits on that:
 *   - Volume reassignment is never manifest-gated. The volume list is being
 *     restored wholesale, so an episode left pointing at a volume that is about
 *     to disappear would be stranded.
 *   - Neither are the arc, character arcs and volume records themselves. Nothing
 *     records what the resolver wrote at that altitude, and a non-spine round is
 *     expected to rewrite all three, so the false-revert exposure is small — but
 *     it is the same reasoning, and closing it needs a manifest one level up.
 *
 * Omit `episodeEdits` and every differing episode is restored. The one caller
 * that still wants that is `restoreFoundationState`, which verifies its own
 * restore fidelity by diffing episodes wholesale. Both rollback loops that judge
 * a round by re-verifying it — the arc gate and the foundation gate's structure
 * repair — pass a manifest.
 *
 * Callers must re-verify after every resolve so they can distinguish a
 * regressive round from a good one. The arc convergence loop uses this to keep
 * its best verified checkpoint; foundation structure repair uses it to restore
 * the pre-repair plan when its bounded verify/correct pass is still blocked.
 * The manual `/arc/resolve` route remains an explicit unguarded user edit.
 */
export async function restoreArcState(seriesId, snapshot, { episodeEdits = null } = {}) {
  if (!snapshot || snapshot.seriesId !== seriesId || !Array.isArray(snapshot.episodes)) {
    return { restored: false, episodesRestored: 0, reassignedIssueCount: 0 };
  }
  const issues = await listEpisodesForSnapshot(seriesId);
  const byId = new Map(issues.map((iss) => [iss.id, iss]));
  // What the round is on record as having written to each episode, or null when
  // the caller kept the pre-manifest "restore every difference" contract.
  const ownedEdits = Array.isArray(episodeEdits) ? new Map() : null;
  for (const edit of Array.isArray(episodeEdits) ? episodeEdits : []) {
    const prior = ownedEdits.get(edit.issueId) || {};
    const metadata = edit.metadata || {};
    const lengthChanged = EPISODE_METADATA_FIELDS.slice(1).some((field) => Object.hasOwn(metadata, field));
    ownedEdits.set(edit.issueId, {
      ...prior, ...edit,
      metadata: { ...prior.metadata, ...metadata },
      // A role-only repair records a fresh full metadata guard, but it does not
      // take ownership of the length choice. Keep the guard from the last edit
      // that actually changed length fields so a later authored target remains
      // outside this round's rollback scope.
      metadataGuard: lengthChanged
        ? (edit.metadataGuard || metadata)
        : (prior.metadataGuard || prior.metadata),
    });
  }
  const stageUpdates = [];
  const metadataUpdates = [];
  const reassign = [];
  for (const snap of snapshot.episodes) {
    const cur = byId.get(snap.id);
    // Gone since the snapshot — nothing to restore onto (auto-resolve never
    // deletes issues, so this is a concurrent user edit, not the round).
    if (!cur) continue;
    if ((cur.seasonId ?? null) !== snap.seasonId) reassign.push(snap);
    if (cur.stages?.idea?.locked === true) continue;
    const idea = ideaSnapshotOf(cur.stages?.idea);
    const owned = ownedEdits?.get(snap.id);
    let metadataPatch = {};
    // Legacy snapshots do not own metadata. For current snapshots, restore only
    // fields this round changed and only while its result still stands. Length
    // is one choice: a later page-count edit must not have its profile reset.
    if (snap.metadata) {
      const lengthFields = EPISODE_METADATA_FIELDS.slice(1);
      const lengthStillOwned = !ownedEdits || (owned?.metadata && lengthFields.every((field) => {
        const guard = owned.metadataGuard || owned.metadata;
        return !Object.hasOwn(guard, field) || (cur[field] ?? null) === guard[field];
      }));
      metadataPatch = Object.fromEntries(EPISODE_METADATA_FIELDS.filter((field) => (
        Object.hasOwn(snap.metadata, field) && (cur[field] ?? null) !== snap.metadata[field]
        && (!ownedEdits || (Object.hasOwn(owned?.metadata || {}, field)
          && (cur[field] ?? null) === owned.metadata[field]
          && (field === 'arcRole' || lengthStillOwned)))
      )).map((field) => [field, snap.metadata[field]]));
      if (Object.keys(metadataPatch).length) metadataUpdates.push({ issueId: snap.id, patch: metadataPatch });
    }
    if (!sameIdea(idea, snap.idea) && (!ownedEdits || (owned?.idea && sameIdea(idea, owned.idea)))) {
      const restoredMetadata = { ...episodeMetadataOf(cur), ...metadataPatch };
      const metadataStillChanged = snap.metadata && EPISODE_METADATA_FIELDS
        .some((field) => restoredMetadata[field] !== snap.metadata[field]);
      // A later author choice can keep a new length or role. Restore our old
      // synopsis, but never resurrect beats sized for the superseded plan.
      const restoredIdea = metadataStillChanged && snap.idea.output
        ? { ...snap.idea, output: '', status: 'empty' }
        : snap.idea;
      stageUpdates.push({ issueId: snap.id, stageId: 'idea', computeFn: () => ({ ...restoredIdea, errorMessage: '' }) });
    }
  }
  // Same write ordering as `commitSeasonsWithRemap`: seasons first, so a crash
  // between writes can't leave an issue pointing at a volume that isn't in
  // `series.seasons[]`.
  await withReexportSuppressed('series', seriesId, async () => {
    await updateSeries(seriesId, {
      arc: { ...snapshot.arc, seriesDesign: (await getSeries(seriesId)).arc?.seriesDesign },
      seasons: snapshot.seasons,
      ...(Array.isArray(snapshot.characterArcs) ? { characterArcs: snapshot.characterArcs } : {}),
    });
    for (const snap of reassign) {
      await updateIssue(snap.id, { seasonId: snap.seasonId }, { skipRenumber: true });
    }
    if (reassign.length) await recomputeIssueNumbersForSeries(seriesId);
    for (const { issueId, patch } of metadataUpdates) await updateIssue(issueId, patch);
    await updateStagesWithLatest(seriesId, stageUpdates);
  });
  emitRecordUpdated('series', seriesId);
  console.log(`↩️ arc-resolve: reverted a regressive round for series ${seriesId.slice(0, 12)} — ${stageUpdates.length} episode synopsis(es), ${reassign.length} reassignment(s)`);
  const episodesRestored = new Set([...stageUpdates, ...metadataUpdates].map((entry) => entry.issueId)).size;
  return { restored: true, episodesRestored, reassignedIssueCount: reassign.length };
}
