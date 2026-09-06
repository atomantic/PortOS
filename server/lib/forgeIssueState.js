/**
 * Normalize a forge issue/PR/MR state string to `open` / `closed`. GitLab
 * reports `opened` (and `closed`/`locked`); GitHub reports `open`/`closed`.
 * Anything unrecognized is treated as open, so an unfamiliar state string
 * never reads as "already resolved" and short-circuits a scan that depends on
 * catching every still-open item (dedup/park/blocker checks). (`merged` never
 * applies to issues, only PRs/MRs.)
 *
 * Shared by `layeredIntelligence/forgeFiler.js` and `blockedIssueReconcile.js`
 * — lifted here (rather than duplicated, or imported cross-subsystem from
 * `layeredIntelligence/`) per the Import scoping convention in
 * `server/AGENTS.md`.
 * @param {string} state
 * @returns {'open'|'closed'}
 */
export function normalizeIssueState(state) {
  const s = (state || '').toLowerCase();
  if (s === 'closed' || s === 'locked') return 'closed';
  return 'open';
}
