/**
 * Merge Gate contract check (#5876)
 *
 * A worktree agent told to own its own PR lifecycle (`ownsPrWorkflow`) is
 * handed a "Merge Gate" section that ends with "Confirm the merge before
 * exiting: … must return MERGED". Nothing verified that it actually did —
 * the completion sentinel was accepted on its face, and only the post-
 * teardown `agentRepoStateVerification.js` audit ever caught a run that quit
 * with the PR still open, at the cost of a whole cold recovery agent to
 * finish a 30-second merge.
 *
 * This module is the pure decision logic for a cheaper first line of
 * defense: while the agent's session is still attached, check whether its
 * own sentinel and the PR it opened agree that the Merge Gate is done, and
 * — for exactly one nudge — re-prompt instead of tearing the session down.
 * The PR lookup itself lives in `../services/prProbe.js`, and the re-prompt
 * delivery (pasting into the live PTY) lives in `agentTuiSpawning.js` — kept
 * out of here so this stays testable without either.
 */

/**
 * Did this run's own task shape ask it to own the merge?
 *
 * Only the AND of all three counts: a run PortOS itself opens or merges the
 * PR for (`taskOpenPR` false, or `ownsPrWorkflow` false — a lean `--bare`
 * session, a read-only/no-code-output run, or an HTTP `api` provider) never
 * owed one, and neither does a run whose prompt explicitly hands the PR to a
 * human (`leaveOpen` true — JIRA hand-off, claim flow, or an exempt task
 * type; see `leavesPrForHuman` in `prDisposition.js`).
 *
 * @param {{taskOpenPR: boolean, ownsPrWorkflow: boolean, leaveOpen: boolean}} params
 * @returns {boolean}
 */
export function mergeGateOwed({ taskOpenPR, ownsPrWorkflow, leaveOpen }) {
  return !!taskOpenPR && !!ownsPrWorkflow && !leaveOpen;
}

// What the Merge Gate's own step 4 asks the agent to say when it deliberately
// doesn't merge ("Do NOT exit until state is MERGED (or you have explicitly
// decided not to merge per the rule above)") — a STATED decision, not
// something inferred from the PR being open. Matches the shapes an agent's
// own prose actually uses for that decision, not every possible phrasing.
const LEAVE_OPEN_PATTERNS = [
  /\bleav(?:e|ing)\b[^.\n]{0,40}\bopen\b/i,
  /\bleft\b[^.\n]{0,40}\b(?:pr|pull request|merge request|mr)\b[^.\n]{0,20}\bopen\b/i,
  /\b(?:not merg(?:e|ed|ing)|did(?:n'?t| not) merge)\b/i,
  /\breview[- ]blocked\b/i,
];

/**
 * Does the agent's own completion summary say it decided not to merge?
 *
 * @param {string|null|undefined} summary
 * @returns {boolean}
 */
export function summaryStatesLeaveOpen(summary) {
  if (!summary) return false;
  return LEAVE_OPEN_PATTERNS.some((pattern) => pattern.test(summary));
}

/**
 * Resolve what a completing run that owed a merge should do next.
 *
 * The "send at most one nudge" decision is NOT this function's job — it lives
 * entirely in the caller (`agentTuiSpawning.js`'s `checkMergeGateCompliance`,
 * which short-circuits before ever calling this a second time this run), so
 * there is exactly one place that answer can drift out of sync with itself.
 *
 * - `merged` — the PR landed; finalize normally.
 * - `no-pr-action` — the forge lookup itself failed (`readable: false`), or it
 *   succeeded but found nothing actionable for this branch (no PR at all, or
 *   one that's CLOSED rather than merged). Either way there is nothing here
 *   to act on: finalize normally and let the post-teardown audit
 *   (`agentRepoStateVerification.js`) be the backstop, as today.
 * - `leave-open-stated` — the agent said, in its own words, that it is
 *   deliberately leaving the PR open; that is a correct terminal state.
 * - `needs-reprompt` — the PR is open and the summary names no blocker: send
 *   one corrective re-prompt.
 *
 * @param {object} params
 * @param {{prState: string|null, readable: boolean}|null} params.prProbe
 * @param {string|null|undefined} params.summary
 * @returns {'merged'|'no-pr-action'|'leave-open-stated'|'needs-reprompt'}
 */
export function resolveMergeGateVerdict({ prProbe, summary }) {
  if (!prProbe || prProbe.readable === false) return 'no-pr-action';
  if (prProbe.prState === 'MERGED') return 'merged';
  if (prProbe.prState !== 'OPEN') return 'no-pr-action';
  if (summaryStatesLeaveOpen(summary)) return 'leave-open-stated';
  return 'needs-reprompt';
}

/**
 * The corrective prompt re-pasted into the still-attached session. Names the
 * PR and points back at the Merge Gate's own numbered steps rather than
 * re-explaining the procedure — the agent already has it in context.
 *
 * @param {string} prUrl
 * @returns {string}
 */
export function buildMergeGateReprompt(prUrl) {
  return [
    `Your Merge Gate is not finished: ${prUrl} is still OPEN and your last summary did not say you were leaving it open.`,
    'Work through the Merge Gate steps from your original instructions now: watch required CI to green, merge with `gh pr merge "<PR_URL>" --merge --delete-branch`, and confirm `gh pr view "<PR_URL>" --json state -q .state` returns `MERGED` before exiting.',
    'If it truly cannot merge (a required check is red after a genuine fix attempt, or there is a conflict only a human can resolve), say so explicitly and leave it open.',
  ].join('\n');
}
