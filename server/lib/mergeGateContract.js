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
 * - `auto-merge-enabled` — GitHub confirms a pending handoff; finalize without
 *   claiming it has merged.
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
 * @returns {'merged'|'no-pr-action'|'leave-open-stated'|'auto-merge-enabled'|'merge-handoff-queued'|'needs-reprompt'}
 */
export function resolveMergeGateVerdict({ prProbe, summary }) {
  if (!prProbe || prProbe.readable === false) return 'no-pr-action';
  if (prProbe.prState === 'MERGED') return 'merged';
  if (prProbe.prState !== 'OPEN') return 'no-pr-action';
  if (prProbe.autoMergeEnabled === true) return 'auto-merge-enabled';
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
    'Work through the Merge Gate steps from your original instructions now: use the verified PortOS pending-merge handoff (or, outside merge admission, the GitHub auto-merge handoff) when eligible, otherwise watch required CI to green, merge with `gh pr merge "<PR_URL>" --merge --match-head-commit <verified-head>`, and confirm `gh pr view "<PR_URL>" --json state -q .state` returns `MERGED` before exiting.',
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
export function buildAutoMergeHandoffInstructions(prRef) {
  return `**GitHub auto-merge handoff (before waiting for CI):** If this run requires repository merge admission, do not enable GitHub auto-merge: a deferred GitHub merge cannot honor the local lease. Use the normal in-session CI wait and immediate admission-gated merge below. The remaining handoff applies only to workflows explicitly outside local admission. After local validation and all configured reviews pass on the published head, inspect \`gh pr view ${prRef} --json state,isDraft,headRefOid,mergeable,statusCheckRollup,reviewDecision\` and \`gh api repos/{owner}/{repo}\` (the PR's BASE repository). Require \`allow_auto_merge: true\`, a ready/non-draft conflict-free PR, satisfied reviews, no failed checks, and CI queued or running on that head. Read \`gh pr checks ${prRef} --required --json name,state\` and compare with every outstanding check in the workflow's CI gate: every such check must be enforced by GitHub. Missing/unknown required-check policy or any outstanding unenforced check means wait for all workflow checks and use the normal immediate merge gate. Only then enable \`gh pr merge ${prRef} --auto --merge --match-head-commit <published-head>\`. Use \`--squash\` or \`--rebase\` only if merge commits are disallowed. Never use \`--admin\`, change branch protection, or enable repository auto-merge settings. Read back \`gh pr view ${prRef} --json state,headRefOid,autoMergeRequest\`: require the same published head and OPEN with a non-null \`autoMergeRequest.enabledAt\`, or confirm MERGED. Exit status alone is not proof. A verified pending handoff is successful only outside local admission: report the PR URL and head, explicitly say auto-merge enabled with CI pending, write the completion sentinel if required, and stop without waiting for MERGED. Preserve the unmerged branch; do not close its issue or claim it landed. This eligible handoff overrides later in-session CI waits and MERGED-only completion instructions, including delegated slashdo workflows. If unavailable, rejected, or unverified, follow the normal CI/merge gate below; failed checks require a real fix.`;
}

/** Shared preservation ordering for every managed checkout delivery prompt. */
export const MANAGED_WORKTREE_CLEANUP_CONTRACT = `**Managed-worktree preservation and explicit cleanup:** Merge commands must preserve local checkouts and branches on every GitHub CLI version; do not ask gh to delete branches at merge time. Keep every merge-method attempt pinned to the CI-verified head. The parent owns merge admission for swarm children too. First verify remote state is exactly MERGED, then release any owned merge-admission lease and require released:true. Only afterwards begin cleanup.
Recheck live claim/worktree ownership, the exact checkout path and holder branch, the exact local branch tip, and the exact remote head ref on its verified remote. Limit all mutations to this task's allowlisted branch and checkout; refuse the default branch. A late unpublished commit or any changed ownership/ref invalidates cleanup: keep the checkout and refs intact and leave a tracked handoff. A missing remote ref (including repository auto-deletion) proves neither local preservation nor archive completion; a failed lookup is not proof of absence.
Inventory and preserve ALL unique tracked, untracked AND ignored content outside the checkout, including test results and scratch artifacts; do not follow dependency symlinks into shared installations. Verify the archive manifest and copied bytes before removal, and recheck ownership, local tip and inventory again after archiving. Archive failure or an ownership/ref/inventory change keeps the checkout and branch intact; record the owner, blocker and next step in the owning tracker. Never infer preservation from a clean git status.
After those proofs, when this workflow owns remote cleanup, delete an existing remote head only with an exact-ref compare-and-delete: \`git push --force-with-lease=refs/heads/<branch>:<verified-head> <verified-remote> :refs/heads/<branch>\`. A lease rejection preserves the advanced ref and stops cleanup. Verify that exact remote ref is absent. Fetch the verified remote’s intended default branch explicitly and require \`git merge-base --is-ancestor <exact-local-tip> <fetched-intended-default>\` before local removal; an upstream or a squash/rebase merge alone is not ancestry proof. If ancestry is unproven, preserve both checkout and branch for reconciliation. Then remove only the authorized worktree and delete the explicitly named local branch with \`git branch -d <branch>\`; never force local branch deletion. Do not checkout or pull the default branch. A refusal leaves the surviving checkout/ref for reconciliation. Managed review/completion agents that hand teardown to PortOS must leave the local checkout and branch intact for that owner to apply these same gates.`;


/** Review/completion agents hand teardown to PortOS rather than removing it. */
export const MANAGED_WORKTREE_COMPLETION_HANDOFF = '**Managed-worktree cleanup handoff:** Verify remote MERGED, release admission (released:true), then recheck ownership and exact local/remote refs. Verify preservation of all unique tracked, untracked and ignored bytes before cleanup. Archive failure or changed ownership/refs preserves the checkout and branch with a tracked handoff. Remote auto-deletion proves no archive. Leave local teardown to PortOS. Any authorized remote deletion must compare-and-delete only the exact ref at the CI-verified head; no default-branch checkout/pull or forced local deletion.';

/** Executable GitHub claim merge phase; admission is supplied by its registered parent. */
export function buildManagedGithubMergeScript() {
  return [
    '# CI_VERIFIED_HEAD is the exact head whose required checks and configured reviews passed.',
    ': "${CI_VERIFIED_HEAD:?Missing CI-verified head}"',
    '[ "$(git rev-parse HEAD)" = "$CI_VERIFIED_HEAD" ] || exit 1',
    'PR_URL=$(gh pr view --json url -q .url) || exit 1',
    'case "$PR_URL" in https://*/pull/[0-9]*) BASE_REPO_URL="${PR_URL%/pull/*}" ;; *) exit 1 ;; esac',
    'portos_read_merge_state() {',
    '  PR_SNAPSHOT=$(gh pr view "$PR_URL" --json state,headRefOid,mergeStateStatus,isDraft,reviewDecision) || return 1',
    `  printf '%s' "$PR_SNAPSHOT" | node -e 'const fs = require("node:fs"); const p = JSON.parse(fs.readFileSync(0, "utf8")); if (p.headRefOid !== process.argv[1] || !["OPEN", "MERGED"].includes(p.state)) process.exit(1); if (p.state === "OPEN" && (p.isDraft !== false || !["CLEAN", "UNSTABLE", "HAS_HOOKS"].includes(p.mergeStateStatus) || ![null, "", "APPROVED"].includes(p.reviewDecision))) process.exit(1); process.stdout.write(p.state);' "$CI_VERIFIED_HEAD"`,
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
    '    gh pr checks "$PR_URL" --required || exit 1',
    '    # Source the registered parent’s check function from Repository merge admission first.',
    '    command -v portos_check_merge_admission >/dev/null || { echo "Missing registered merge-admission check" >&2; exit 1; }',
    '    portos_check_merge_admission || exit 1',
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
