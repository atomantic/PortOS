/**
 * Merge Gate contract check (#5876)
 *
 * A worktree agent handed the INLINE PR lifecycle — the plain `git`/`gh` steps,
 * because its host cannot type `/do:pr` — gets a "Merge Gate" section that ends
 * with "Confirm the merge before exiting: … must return MERGED". Nothing
 * verified that it actually did —
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
 * Did this run's own prompt ask it to work a Merge Gate?
 *
 * Only the AND of all three counts, and `rendersInlinePrLifecycle` is the
 * narrow one: there is a gate to hold the agent to only when the prompt
 * actually rendered that section. A run PortOS opens or merges the PR for
 * (`taskOpenPR` false, or a lean `--bare` session / read-only / no-code-output
 * run / HTTP `api` provider) never owed one; nor does a run whose prompt hands
 * the PR to a human (`leaveOpen` true — JIRA hand-off, claim flow, or an exempt
 * task type; see `leavesPrForHuman` in `prDisposition.js`); nor does a
 * slashdo-capable run, whose `/do:pr` merges inside that one command and whose
 * prompt therefore carries no Merge Gate steps for the re-prompt to point back
 * at. Callers pass `prOpenedBy === 'agent-inline'` (#6869).
 *
 * @param {{taskOpenPR: boolean, rendersInlinePrLifecycle: boolean, leaveOpen: boolean}} params
 * @returns {boolean}
 */
export function mergeGateOwed({ taskOpenPR, rendersInlinePrLifecycle, leaveOpen }) {
  return !!taskOpenPR && !!rendersInlinePrLifecycle && !leaveOpen;
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
 * - `merge-handoff-queued` — the server's pending-merge coordinator holds a
 *   verified receipt for the published head (#12247); finalize without claiming
 *   it has merged. The branch is the coordinator's until it merges or recovers.
 * - `leave-open-stated` — the agent said, in its own words, that it is
 *   deliberately leaving the PR open; that is a correct terminal state.
 * - `needs-reprompt` — the PR is open and the summary names no blocker: send
 *   one corrective re-prompt.
 *
 * @param {object} params
 * @param {{prState: string|null, readable: boolean, autoMergeEnabled?: boolean, mergeHandoffQueued?: boolean}|null} params.prProbe
 * @param {string|null|undefined} params.summary
 * @returns {'merged'|'no-pr-action'|'leave-open-stated'|'merge-handoff-queued'|'needs-reprompt'}
 */
export function resolveMergeGateVerdict({ prProbe, summary }) {
  if (!prProbe || prProbe.readable === false) return 'no-pr-action';
  if (prProbe.prState === 'MERGED') return 'merged';
  if (prProbe.prState !== 'OPEN') return 'no-pr-action';
  if (prProbe.mergeHandoffQueued === true) return 'merge-handoff-queued';
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
    'Work through the Merge Gate steps from your original instructions now: use a persisted PortOS pending-merge receipt only when the server accepts measured CI backlog under the configured policy; otherwise watch required CI to green, merge with `gh pr merge "<PR_URL>" --merge --match-head-commit <verified-head>`, and confirm `gh pr view "<PR_URL>" --json state -q .state` returns `MERGED` before exiting.',
    'If it truly cannot merge (a required check is red after a genuine fix attempt, or there is a conflict only a human can resolve), say so explicitly and leave it open.',
  ].join('\n');
}

// A queued handoff is temporary ownership, not an indefinite exemption from
// recovery. Unknown check shapes and hour-old requests fail closed.
export function hasHealthyAutoMergeRequest(pr, now = Date.now()) {
  const enabledAt = Date.parse(pr?.autoMergeRequest?.enabledAt);
  if (pr?.state !== 'OPEN' || pr.isDraft !== false || !Number.isFinite(enabledAt)
    || enabledAt > now || now - enabledAt >= 60 * 60 * 1000
    || !Array.isArray(pr.statusCheckRollup) || pr.statusCheckRollup.length === 0) return false;
  return pr.statusCheckRollup.every(check => {
    if (check?.__typename === 'StatusContext') return ['SUCCESS', 'PENDING', 'EXPECTED'].includes(check.state);
    if (check?.__typename !== 'CheckRun') return false;
    return check.status === 'COMPLETED'
      ? ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion)
      : ['QUEUED', 'IN_PROGRESS', 'REQUESTED', 'WAITING', 'PENDING'].includes(check.status);
  });
}

/** Shared GitHub handoff contract for inline, review-follow-up and recovery prompts. */
export function buildAutoMergeHandoffInstructions(prRef, { review = true } = {}) {
  return `**Own delivery through completion:** By default stay responsible for ${prRef} through all required CI${review ? ', review' : ''}, confirmed MERGED and safe cleanup. GitHub auto-merge enabled is not completion and does not transfer failure recovery or cleanup. Early finish is allowed only with an explicit persisted PortOS pending-merge receipt for the exact published${review ? '/reviewed' : ''} head, accepted after the server observes the configured CI backlog threshold. The app setting \`mergeHandoffMinQueuedRuns\` is opt-in: absent/null means keep ownership; no threshold is inferred from elapsed time. Unknown backlog, refused handoff or failed receipt persistence means continue in-session. The receipt owns CI failure recovery, changed heads, merge confirmation and preserved cleanup across restarts. Report its receipt ID and PR/head as pending, never merged; preserve the checkout and issue until the successor confirms completion. Intentional leave-open policies remain unchanged. Native GitHub auto-merge is allowed when the provider accepts it; continue observing the exact PR until MERGED. A refused optional PortOS handoff does not add a merge-certification requirement.`;
}

/** Shared delivery and cleanup contract for every managed checkout delivery prompt. */
export const MANAGED_WORKTREE_CLEANUP_CONTRACT = `**Managed-worktree delivery and cleanup:** Keep each merge attempt pinned to the CI-verified head, and keep swarm children within their assigned repository and PR scope. First verify the hosting provider reports the exact PR as MERGED. Do not checkout or pull the default branch in the primary workspace, and do not touch worktrees or branches owned by other active agents. Once the PR is confirmed MERGED (or when no code changes were needed), PortOS cleans up the managed worktree and branch automatically after completion—or you may remove your own merged claim worktree cleanly. Report normal completion in your completion sentinel; do not report a cleanup hold or create checkout archives.`;

/** Review/completion agents use the same concrete delivery and cleanup contract. */
export const MANAGED_WORKTREE_COMPLETION_HANDOFF = MANAGED_WORKTREE_CLEANUP_CONTRACT;

/** Executable GitHub claim merge phase; GitHub enforces repository policy. */
export function buildManagedGithubMergeScript() {
  return [
    '# CI_VERIFIED_HEAD is the exact head whose required checks and configured reviews passed.',
    ': "${CI_VERIFIED_HEAD:?Missing CI-verified head}"',
    '[ "$(git rev-parse HEAD)" = "$CI_VERIFIED_HEAD" ] || exit 1',
    'PR_URL=$(gh pr view --json url -q .url) || exit 1',
    'case "$PR_URL" in https://*/pull/[0-9]*) BASE_REPO_URL="${PR_URL%/pull/*}" ;; *) exit 1 ;; esac',
    'portos_read_merge_state() {',
    '  PR_SNAPSHOT=$(gh pr view "$PR_URL" --json state,headRefOid,mergeStateStatus,isDraft,reviewDecision) || return 1',
    `  printf '%s' "$PR_SNAPSHOT" | node -e 'const fs = require("node:fs"); const p = JSON.parse(fs.readFileSync(0, "utf8")); if (p.headRefOid !== process.argv[1] || !["OPEN", "MERGED"].includes(p.state)) process.exit(1); if (p.state === "OPEN" && p.isDraft !== false) process.exit(1); process.stdout.write(p.state);' "$CI_VERIFIED_HEAD"`,
    '}',
    'STATE=$(portos_read_merge_state) || exit 1',
    'if [ "$STATE" != "MERGED" ]; then',
    '  for MERGE_METHOD in merge squash rebase; do',
    '    case "$MERGE_METHOD" in',
    '      merge) CAPABILITY=mergeCommitAllowed ;;',
    '      squash) CAPABILITY=squashMergeAllowed ;;',
    '      rebase) CAPABILITY=rebaseMergeAllowed ;;',
    '    esac',
    '    ALLOWED=$(gh repo view "$BASE_REPO_URL" --json "$CAPABILITY" -q ".$CAPABILITY") || exit 1',
    '    [ "$ALLOWED" = "false" ] && continue',
    '    [ "$ALLOWED" = "true" ] || exit 1',
    '    [ "$(git rev-parse HEAD)" = "$CI_VERIFIED_HEAD" ] || exit 1',
    '    STATE=$(portos_read_merge_state) || exit 1',
    '    [ "$STATE" = "MERGED" ] && break',
    '    STATE=$(portos_read_merge_state) || exit 1',
    '    [ "$STATE" = "MERGED" ] && break',
    '    if gh pr merge "$PR_URL" "--$MERGE_METHOD" --match-head-commit "$CI_VERIFIED_HEAD"; then MERGE_EXIT=0; else MERGE_EXIT=$?; fi',
    '    STATE=$(portos_read_merge_state) || exit 1',
    '    [ "$STATE" = "MERGED" ] && break',
    '    # An attempted mutation has no verified success: never try another method.',
    '    [ "$MERGE_EXIT" = "0" ] || exit "$MERGE_EXIT"',
    '    echo "Expected MERGED, got $STATE" >&2; exit 1',
    '  done',
    'fi',
    '[ "$STATE" = "MERGED" ] || { echo "No verified merge" >&2; exit 1; }',
  ].join('\n');
}
