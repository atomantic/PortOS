/**
 * Pipeline mutation epoch — the dataSync federation-invisibility signal (#1015).
 *
 * Thin wrappers over the shared change-token registry (../changeToken.js, #1031).
 * Pipeline series + issues used to live in per-record dirs under
 * data/pipeline-series/{id} and data/pipeline-issues/{id}. dataSync's `pipeline`
 * snapshot-cache fingerprint stats those directories to decide WHEN to re-send
 * the pipeline snapshot to peers. As of #1015 the records live in PostgreSQL
 * (`pipeline_series` / `pipeline_issues`), so a record edit no longer touches
 * those directories — without help, the dir fingerprint would never invalidate
 * and peers would silently stop receiving pipeline edits.
 *
 * The fix folds a single monotonic counter — bumped on every series/issue record
 * write/delete — into the `pipeline` fingerprint (and the `mediaCollections`
 * fingerprint, which filters collections by their linked series' ephemeral state)
 * via a sentinel key, so the checksum cache invalidates on a DB edit just as it
 * did on a file edit. Under the file backend the dirs still change too (harmless
 * double-signal).
 *
 * Series AND issues share the one counter because dataSync's `pipeline` category
 * covers both record kinds together — any pipeline mutation must invalidate that
 * one checksum. The shared registry is module-level (a domain-keyed singleton) so
 * dataSync reads ONE monotonic counter regardless of how many times the
 * series/issues facades are rebuilt (test PATHS.data swaps).
 */

import { bumpChangeToken, getChangeToken } from '../changeToken.js';

/** Current pipeline mutation epoch — folded into dataSync's fingerprint. */
export function getPipelineMutationEpoch() {
  return getChangeToken('pipeline');
}

/** Bump the epoch — called by the series/issues stores on every record write/delete. */
export function bumpPipelineMutationEpoch() {
  bumpChangeToken('pipeline');
}
