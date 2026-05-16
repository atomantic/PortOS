/**
 * Pure renumber algorithm for pipeline issues. Lives in `lib/` so the
 * one-shot migration (`scripts/migrations/010-…js`) and the live service
 * (`server/services/pipeline/issues.js`) share one implementation —
 * otherwise the two would drift as anchoring / sort-tiebreak rules evolve.
 *
 * `issue.number` is derived: it reflects the issue's position when the
 * series is walked volume-by-volume (in `season.number` ascending order) and
 * then arcPosition-by-arcPosition within each volume. Earlier volumes' numbers
 * don't move when later volumes change — `fromSeasonId` anchors the renumber
 * to the earliest affected volume so an unrelated V2 edit never reshuffles V1.
 *
 *   fromSeasonId = null              → renumber from the first volume.
 *   fromSeasonId = '<some seasonId>' → renumber from that volume onward.
 *   fromSeasonId = UNSCOPED_ANCHOR   → only the trailing unscoped tail.
 *   fromSeasonId = unknown id        → treated as UNSCOPED_ANCHOR (stale ref).
 *
 * Mutates the provided `issues` array's elements in place; returns true iff
 * any `iss.number` actually changed (callers gate their disk writes on this).
 */

export const UNSCOPED_ANCHOR = Symbol('pipelineIssueOrder.unscopedAnchor');

const byArcPosThenCreated = (a, b) => {
  const pa = a.arcPosition || 0;
  const pb = b.arcPosition || 0;
  if (pa !== pb) return pa - pb;
  return (a.createdAt || '').localeCompare(b.createdAt || '');
};

export function applyVolumeOrderedNumbers({ issues, seriesId, seasons = [], fromSeasonId = null }) {
  const orderedSeasons = [...seasons].sort((a, b) => (a?.number || 0) - (b?.number || 0));
  const knownSeasonIds = new Set(orderedSeasons.map((s) => s.id).filter(Boolean));
  const byVolume = new Map();
  const unscoped = [];
  for (const iss of issues) {
    if (iss.seriesId !== seriesId) continue;
    if (iss.seasonId && knownSeasonIds.has(iss.seasonId)) {
      const list = byVolume.get(iss.seasonId) || [];
      list.push(iss);
      byVolume.set(iss.seasonId, list);
    } else {
      unscoped.push(iss);
    }
  }

  // Resolve the anchor. A stale `fromSeasonId` (string that doesn't match any
  // current season) means the affected issue is in the unscoped bucket, so
  // collapse to unscoped-only — that way one stale-seasonId append doesn't
  // trigger a full series renumber.
  let anchorIdx = 0;
  let unscopedOnly = false;
  if (fromSeasonId === UNSCOPED_ANCHOR) {
    anchorIdx = orderedSeasons.length;
    unscopedOnly = true;
  } else if (fromSeasonId) {
    const idx = orderedSeasons.findIndex((s) => s.id === fromSeasonId);
    if (idx >= 0) anchorIdx = idx;
    else { anchorIdx = orderedSeasons.length; unscopedOnly = true; }
  }

  // Seed the counter from the highest issue.number before the anchor, so
  // pre-anchor volumes keep their persisted numbers untouched.
  let counter = 1;
  for (let i = 0; i < anchorIdx; i += 1) {
    const list = byVolume.get(orderedSeasons[i].id) || [];
    for (const iss of list) {
      if ((iss.number || 0) >= counter) counter = (iss.number || 0) + 1;
    }
  }

  let changed = false;
  if (!unscopedOnly) {
    for (let i = anchorIdx; i < orderedSeasons.length; i += 1) {
      const list = (byVolume.get(orderedSeasons[i].id) || []).sort(byArcPosThenCreated);
      for (const iss of list) {
        if (iss.number !== counter) { iss.number = counter; changed = true; }
        counter += 1;
      }
    }
  }
  // Unscoped issues trail the volumes, ordered by createdAt so the sequence
  // stays deterministic across runs.
  unscoped.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  for (const iss of unscoped) {
    if (iss.number !== counter) { iss.number = counter; changed = true; }
    counter += 1;
  }
  return changed;
}
