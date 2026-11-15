/**
 * `tuningNoticeChip(entry)` — the short form of how a measured local-model assessment says its launch
 * configuration did NOT take effect.
 *
 * `tuningApplied === false` covers two opposite cases and `tuningKey` separates them: a TUNED run
 * whose knobs never reached the daemon (`tuning not applied`), versus an UNTUNED run PortOS could not
 * put back on backend defaults (`not at defaults`) — #4759. Shared by `ModelThroughputReport.jsx`'s
 * table cell and `LocalModelAssessments.jsx`'s result toast; the long form is the server's exclusion
 * reason in `getAssessmentReport`.
 */

/**
 * How a measured local-model assessment describes a launch configuration that
 * did NOT take effect.
 *
 * `tuningApplied === false` covers two different failures, and they read as
 * opposite things to the person looking at the row:
 *
 *   - a TUNED run whose knobs never reached the daemon — the numbers describe
 *     some other configuration, not the one in the label;
 *   - an UNTUNED run PortOS could not put back on backend defaults, because the
 *     daemon was still carrying the previous run's tuning. Its label already
 *     says "backend defaults", so "tuning was not applied" reads as a
 *     contradiction unless the copy names what actually happened.
 *
 * `tuningKey` is what separates them: `''` is the untuned run.
 *
 * This is the SHORT form, for a dense table cell or a toast suffix. The full
 * sentence for a surface with room to say it is the server-side exclusion reason
 * in `getAssessmentReport` — keep the two in step.
 *
 * @returns {string|null} `null` when nothing is wrong with the reading.
 */
export function tuningNoticeChip(entry) {
  if (entry?.tuningApplied !== false) return null;
  return entry?.tuningKey ? 'tuning not applied' : 'not at defaults';
}
