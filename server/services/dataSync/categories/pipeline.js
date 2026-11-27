/** Projects series and issue snapshots and applies their merges through the Pipeline services. */

import { mergeSeriesFromSync, listSeries } from '../../pipeline/series.js';
import { mergeIssuesFromSync, listAllIssues } from '../../pipeline/issues.js';
import { sanitizeStateForWire } from '../../../lib/syncWire.js';
import { computeChecksum, toExcludeSet } from '../snapshotHelpers.js';

export async function getPipelineSnapshot({ exclude } = {}) {
  const [series, issues] = await Promise.all([
    listSeries({ includeDeleted: true }),
    listAllIssues({ includeDeleted: true, withHistory: false }),
  ]);
  // The pipeline category bundles series + their child issues — a `series`
  // subscription covers the whole sub-tree via the per-record push (which
  // ships the series + every child issue). So excluding a covered series id
  // ALSO drops every issue whose `seriesId` matches; otherwise the snapshot
  // would still carry the child issues the push pipeline already delivers,
  // re-introducing the redundant transfer this fix removes. Un-subscribed
  // series (and their issues), plus tombstones for torn-down subs, still ride.
  const excludeSet = toExcludeSet(exclude);
  const scopedSeries = excludeSet.size > 0
    ? series.filter((s) => !excludeSet.has(s?.id))
    : series;
  const scopedIssues = excludeSet.size > 0
    ? issues.filter((i) => !excludeSet.has(i?.seriesId))
    : issues;
  // Wire-projection lives in `server/lib/syncWire.js` — see getUniverseSnapshot.
  const { data } = sanitizeStateForWire('pipeline', {
    series: scopedSeries,
    issues: scopedIssues,
  });
  return { data, checksum: computeChecksum(data) };
}

export async function applyPipelineRemote(remoteData, source, { senderSchemaVersions = null } = {}) {
  if (!remoteData) return { applied: false, count: 0 };
  // Routes through the service merge entry points so each incoming record
  // passes through the same sanitizer and LWW contract as local writes.
  const [seriesResult, issuesResult] = await Promise.all([
    mergeSeriesFromSync(remoteData.series || [], { source }),
    mergeIssuesFromSync(remoteData.issues || [], { source, senderSchemaVersions }),
  ]);

  const seriesChanged = seriesResult.count;
  const issuesChanged = issuesResult.count;
  if (seriesChanged === 0 && issuesChanged === 0) return { applied: false, count: 0 };

  // `count` is the total number of records actually changed/added by this
  // merge (NOT total post-merge records — that would over-report when callers
  // sum across categories or compare cycle-over-cycle deltas). `seriesChanged`
  // / `issuesChanged` are surfaced separately so per-side telemetry stays
  // distinguishable.
  console.log(`🔄 Pipeline sync: merged ${seriesChanged} series + ${issuesChanged} issue(s)`);
  return {
    applied: true,
    count: seriesChanged + issuesChanged,
    seriesChanged,
    issuesChanged,
  };
}
