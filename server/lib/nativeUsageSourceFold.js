// The coverage counters a native usage reader keeps, and how one source's share of
// them folds into a total. Reading sources separately and folding the results must
// report the same counters as reading them all at once (#15255), so this stays
// commutative and associative. Identity-derived counts (duplicates, conflicts,
// measured records) are not here: readers derive them after folding the records.
const SUMMED = ['files', 'records', 'missingUsageRecords', 'missingIdentityRecords', 'invalidLines', 'undatedRecords',
  'unreadableFiles', 'skippedLinks', 'oversizedLines', 'unfinalizedRecords', 'fieldInconsistentRecords'];
const MAX_RUNTIME_VERSIONS = 32;

export const emptyNativeCoverage = () => ({ files: 0, records: 0, measuredRecords: 0, missingUsageRecords: 0, missingIdentityRecords: 0,
  duplicateRecords: 0, conflictingRecords: 0, invalidLines: 0, undatedRecords: 0, unreadableFiles: 0,
  skippedLinks: 0, missingSource: false, capped: false, stoppedEarly: false, oversizedLines: 0, streamingSupersededRecords: 0,
  unfinalizedRecords: 0, fieldInconsistentRecords: 0, runtimeVersions: [], steps: null, cacheOverlap: null, costTickRecords: null,
  firstObservedAt: null, lastObservedAt: null, retention: 'unknown' });

/** One finished source's share of the coverage, without zero counters. */
export function compactNativeCoverage(coverage) {
  const compact = Object.fromEntries(SUMMED.filter(field => coverage[field]).map(field => [field, coverage[field]]));
  if (coverage.capped) compact.capped = true;
  if (coverage.firstObservedAt) compact.firstObservedAt = coverage.firstObservedAt;
  if (coverage.lastObservedAt) compact.lastObservedAt = coverage.lastObservedAt;
  if (coverage.runtimeVersions.length) compact.runtimeVersions = coverage.runtimeVersions;
  return compact;
}

export function foldNativeCoverage(target, share) {
  for (const field of SUMMED) target[field] += share[field] ?? 0;
  target.capped ||= share.capped === true;
  if (share.firstObservedAt && (!target.firstObservedAt || share.firstObservedAt < target.firstObservedAt)) target.firstObservedAt = share.firstObservedAt;
  if (share.lastObservedAt && (!target.lastObservedAt || share.lastObservedAt > target.lastObservedAt)) target.lastObservedAt = share.lastObservedAt;
  // Keep the same bounded evidence regardless of the order sources fold in.
  if (share.runtimeVersions?.length) target.runtimeVersions = [...new Set([...target.runtimeVersions, ...share.runtimeVersions])].sort().slice(0, MAX_RUNTIME_VERSIONS);
  return target;
}

/** Plain integer tallies, such as a reader's provider-specific coverage block. */
export function foldNativeCounts(target, share) {
  for (const [field, value] of Object.entries(share)) target[field] = (target[field] ?? 0) + value;
  return target;
}
