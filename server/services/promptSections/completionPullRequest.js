/** Builds the commit, publication, and review steps shared by CLI and TUI completion. */

import { DEFAULT_REVIEWER, REVIEW_UNAVAILABLE_REPORTING_NOTE, ZERO_REVIEWER_COVERAGE_NOTE, hasRequiredReviewer, isCliReviewer, isToolFreeReviewer, normalizeReviewUsernames, buildReviewerEffortNote, buildReviewWithArgs } from '../../lib/reviewerConfig.js';
import { canTypeSlashCommands, agentOwnsPrWorkflow, PR_OPENED_BY } from '../../lib/slashdoInvocation.js';
import { shellQuote } from '../../lib/shellQuote.js';
import { LOCAL_REVIEW_LIFECYCLE_SCRIPT } from '../../lib/localReviewBridge.js';
import { PR_COMPLETIONS, leavesPrForHuman, resolvePrCompletion } from '../../lib/prDisposition.js';
import { LIGHT_CONTEXT_PROVIDER_TYPES } from './constants.js';
import { buildCiMergeGateSteps, buildReviewLoopFollowUpSection, reviewPolicyToLoopMetadata } from './reviewLifecycle.js';
import { isTruthyMeta } from '../../lib/metadataFlags.js';

// The one commit-hygiene sentence every manual commit step composes — the
// slashdo-free TUI workflow, the PR-owning CLI workflow and the auto-merge
// commit step — so a hygiene change lands in all three at once.
export const COMMIT_HYGIENE_SENTENCE = 'Stage only the files you changed (never `git add -A` / `git add .`) and commit with a conventional message (`feat:`/`fix:`/`breaking:` prefix, no Co-Authored-By annotations)';

/**
 * The commit step of a completion workflow whose branch PortOS merges back
 * (`portosMergesBranchOnExit`). One string for the Claude TUI and Claude CLI
 * workflows so the two cannot drift into different pushing advice.
 *
 * @param {string|null} [baseBranch] - the branch the worktree was cut from
 * @returns {string}
 */
export function buildAutoMergeCommitStep(baseBranch = null) {
  const target = baseBranch ? `\`${baseBranch}\`` : 'the source branch';
  return `${COMMIT_HYGIENE_SENTENCE}. Do NOT push and do NOT open a PR: PortOS merges this branch into ${target} in the source checkout after you exit and deletes it, so a pushed copy is never read — it is only left behind on origin.`;
}

/**
 * Build the merge-and-verify steps that follow `/do:pr` in completion blocks.
 * Returns `{ lines, nextStep }` — append `lines` to the workflow array and
 * assign `nextStep` back to the caller's step counter so any subsequent
 * numbered steps stay continuous.
 *
 * The agent must drive the merge itself — `/do:pr` runs the review loop but
 * exits without merging, so without this step the PR sits open and the branch
 * leaks. Mirrors the merge contract in the review-loop follow-up section so
 * both agent flows converge on the same final state. `reviewers` /
 * `optionalReviewers` only color the wording — the merge gate itself is
 * reviewer-agnostic, because slashdo's loop has already applied `~opt` when it
 * computed the aggregate this step reads.
 *
 * `prCompletion` selects the review gate or CI-only merge gate. Leave-open
 * callers do not invoke this helper.
 */
export function buildPostPRMergeSteps(startStep, { prCompletion = PR_COMPLETIONS.REVIEW_THEN_MERGE, reviewPolicy, forgeCli = 'gh', mergeAdmission = false, mergeHandoff = false }) {
  const { reviewers, optionalReviewers, reviewStopMode } = reviewPolicy;
  const usernames = normalizeReviewUsernames(reviewPolicy.forgeReviewerUsernames);
  const mergeGateForge = forgeCli === 'glab' ? 'gitlab' : 'github';
  // No review loop → CI is the whole gate, so emit the shared CI procedure that
  // the manual-TUI workflow and the merge follow-up agent also use. The PR URL
  // isn't known when this prompt is written, hence the placeholder.
  if (prCompletion === PR_COMPLETIONS.MERGE_ON_GREEN) {
    // Under merge admission `/do:pr` runs with --no-merge, so no saved default merges it.
    const gate = buildCiMergeGateSteps(startStep, { prRef: '"<PR_URL>"', forge: 'unknown', mergeHandoff, ...(mergeAdmission ? { alreadyMergedHint: '' } : {}) });
    return {
      lines: [
        '   **No review loop is configured for this task, so nothing and nobody else will merge this PR** — `/do:pr` opens it and exits. Capture the PR URL it printed, then:',
        ...gate.lines,
      ],
      nextStep: gate.nextStep
    };
  }
  // Trailing space when present so the sentence reads "the Copilot review loop"
  // (lone copilot, no usernames) or "the review loop" (multi/CLI/username) —
  // never "the the review loop".
  const reviewerLabel = (reviewers.length === 1 && reviewers[0] === DEFAULT_REVIEWER && usernames.length === 0) ? 'Copilot ' : '';
  // Under an explicit stop-mode, the multi-reviewer loop can exit `partial` (later
  // reviewers intentionally skipped after the short-circuit) — that's a successful
  // outcome the user opted into, so merge on it too. Match the known stop-modes
  // explicitly so an unknown/invalid value falls through to the safe default
  // (only `clean`/`too-large` mergeable).
  const explicitStopMode = reviewStopMode === 'on-findings' || reviewStopMode === 'on-clean';
  const mergeStatuses = explicitStopMode
    ? '`clean`, `partial` (a stop-mode short-circuit you opted into), or `too-large`'
    : '`clean` (or `too-large`)';
  // An EMPTY list is "no reviewer configured", not "every reviewer optional".
  const allReviewersOptional = (reviewers.length + usernames.length) > 0
    && !hasRequiredReviewer([...reviewers, ...usernames.map(u => `@${u}`)], optionalReviewers);
  // `~opt` is honored by the LOOP, not by this gate: slashdo excludes an
  // optional pass's missing verdict from the aggregate, so an all-optional run
  // whose reviewers time out comes back `clean` and merges here already. Do NOT
  // relax the skip list for it — the one thing `~opt` never excuses is
  // `push-failed`, which is exactly what an `inconclusive` aggregate means when
  // every reviewer is optional, and merging it would land a tree that is not
  // the tree the reviewers read (slashdo `lib/multi-reviewer-loop.md`).
  const optionalMergeNote = allReviewersOptional
    ? ' Every configured reviewer is optional (`~opt`), so a reviewer that timed out or returned no verdict does NOT make the loop inconclusive and is never your reason to skip the merge — the loop already excluded it. An `inconclusive` that still appears despite that is a real blocker (fixes committed but not pushed), and stands.'
    : '';
  const localReviewers = reviewers.filter(reviewer => isCliReviewer(reviewer) || isToolFreeReviewer(reviewer));
  const localReviewRequired = hasRequiredReviewer(localReviewers, optionalReviewers);
  const reviewNames = [
    ...reviewers.filter(reviewer => !localReviewers.includes(reviewer)),
    ...usernames.map(username => `@${username}`),
  ];
  const gate = buildCiMergeGateSteps(startStep + 1, {
    prRef: '"<PR_URL>"',
    forge: mergeGateForge,
    alreadyMergedHint: '',
    mergeHandoff,
    localReviewers,
    localReviewRequired,
    reviewRecheckReviewers: reviewNames,
  });
  const lines = [
    `${startStep}. **Enter the CI merge gate only when the ${reviewerLabel}review loop reports ${mergeStatuses}** — \`/do:pr\` opens the PR and runs the review loop but does NOT merge. Capture the PR URL printed by \`/do:pr\`, then follow the current-head CI gate below. Do not merge directly from a review verdict; skip the gate if the loop ended \`timeout\`, \`error\`, \`inconclusive\`, \`review-blocked\`, or \`guardrail\` and leave the PR open for human follow-up. ${REVIEW_UNAVAILABLE_REPORTING_NOTE}${optionalMergeNote}`,
    ...gate.lines,
  ];
  return { lines, nextStep: gate.nextStep };
}

/**
 * Resolve the review-loop invocation shared by buildTuiCompletionSection and
 * buildCliCompletionSection: the normalized reviewer usernames, the
 * `--review-with ...` argument text, and the effort-pin note. Both callers
 * used to re-derive this identical trio from the same reviewer policy
 * independently.
 */
export function resolveReviewInvocation({ willOpenPR, runsReviewLoop, reviewPolicy }) {
  const { reviewers, optionalReviewers, reviewerMaxRounds, reviewerModels, reviewerEfforts, reviewerCatalogs, reviewStopMode, reviewerApplies } = reviewPolicy;
  const reviewUsernames = normalizeReviewUsernames(reviewPolicy.forgeReviewerUsernames);
  const reviewArgs = willOpenPR
    ? (runsReviewLoop ? buildReviewWithArgs(reviewers, { stopMode: reviewStopMode, reviewerApplies, usernames: reviewUsernames, optionalReviewers, reviewerMaxRounds, reviewerModels, reviewerEfforts, reviewerCatalogs }) : '--review-with none')
    : '';
  // Effort pins ride the emitted `--review-with` tokens as `~effort=<level>`, so
  // the prose note is suppressed whenever that suffix is present — it only speaks
  // for an invocation that pins no reviewer list (see buildReviewerEffortNote).
  const effortNote = willOpenPR && runsReviewLoop
    ? buildReviewerEffortNote(reviewers, reviewerEfforts, { reviewWith: reviewArgs, reviewerModels, reviewerCatalogs })
    : '';
  return { reviewUsernames, reviewArgs, effortNote };
}

/**
 * Keep the manual pre-PR gate aligned with the review loop's `~opt` contract.
 * Defaulting to required preserves the fail-closed behavior for direct callers
 * that provide a local section without its reviewer metadata.
 */
export function localReviewCompletionInstruction(localReviewRequired = true) {
  if (!localReviewRequired) {
    return `Complete the **Local Review Before Opening the PR/MR** section below. All local reviewers are optional, so missing/inconclusive results (including skipped, timeout, malformed, or no-verdict) may continue. If every configured reviewer returns a configuration fault and none produces a verdict, report this distinct run-summary state: ${ZERO_REVIEWER_COVERAGE_NOTE} It remains non-blocking because every reviewer is \`~opt\`; do not use that wording when any reviewer produces a verdict. Set aggregate \`LOCAL_OVERALL_STATUS=clean\` for clean, configured capped with all accepted findings resolved, or optional inconclusive with no unresolved accepted findings; use \`partial\` only for a qualifying stop, never raw statuses. Hard errors, failed build/test, rejection, or unpushed fixes block. Still run each reviewer and fix its findings.`;
  }
  return `Complete the **Local Review Before Opening the PR/MR** section below. Commit its fixes. A missing/timed-out/quota/provider/transport-failed/malformed/inconclusive REQUIRED review blocks merging, not publication: record aggregate \`LOCAL_OVERALL_STATUS=review-blocked\`, do not self-review, continue to publish the PR/MR, and leave it open. ${REVIEW_UNAVAILABLE_REPORTING_NOTE} An OPTIONAL inconclusive result may continue. If every configured reviewer returns a configuration fault and none produces a verdict, report this distinct run-summary state: ${ZERO_REVIEWER_COVERAGE_NOTE} It remains non-blocking when every reviewer is marked \`~opt\`; do not use that wording when any reviewer produces a verdict. Set aggregate \`LOCAL_OVERALL_STATUS=clean\` for clean, configured capped with all accepted findings resolved, or optional inconclusive with no unresolved accepted findings; use \`partial\` only for a qualifying stop, never raw statuses. An unresolved accepted finding or rejection, failed build/test, unpushed fix, or state/publication failure blocks publication.`;
}

/**
 * Which numbered step of the manual completion workflow the inline review-loop /
 * merge-gate section is. The manual workflow always emits step 1 (simplify, or
 * an explicit "disabled — skip" placeholder) and step 2 (commit) before the PR
 * steps, so the number is stable and the two sections can cross-reference each
 * other without threading a counter between them.
 */
/** Same coercion the callers pass in; a default so external callers needn't. */
/**
 * A git ref rendered into a shell command line in the prompt, or `fallback` when
 * there is no ref to render. Branch names are usually PortOS's own, but a
 * JIRA-derived one is external input and this text is pasted straight into an
 * agent's terminal — so it goes through `shellQuote`, which leaves a bare-safe
 * ref readable and single-quotes anything else into inertness.
 */
function promptRef(ref, fallback) {
  return (typeof ref === 'string' && ref) ? shellQuote(ref) : fallback;
}

/**
 * The push + open-a-PR steps of the manual (slashdo-free) completion workflow.
 *
 * `$PR_URL` / `$PR_NUMBER` are captured into shell variables here because the
 * inline review-loop and merge-gate sections address the PR by those names —
 * they are rendered before the PR exists, so a literal URL is impossible.
 */
export function buildManualPrCreateStep(step, { branchName, baseBranch, forgeCli = 'gh', localReviewStateRequired = false, localReviewRequired = false }) {
  const branch = promptRef(branchName, '<branch>');
  const hasBaseBranch = typeof baseBranch === 'string' && baseBranch && baseBranch !== '<base-branch>';
  const base = hasBaseBranch ? promptRef(baseBranch, '<base-branch>') : '"$BASE_BRANCH"';
  const gitlab = forgeCli === 'glab';
  return [
    `${step}. Publish the branch and open the pull request yourself, capturing its URL and number. On resume follow the lifecycle guide first; an existing PR continues hosted handling rather than replaying this initial-publication block:`,
    '',
    '   ```bash',
    ...(hasBaseBranch ? [] : [
      '   if ! git fetch origin; then echo "Unable to fetch origin while resolving the default branch" >&2; exit 1; fi',
      '   if ! git remote set-head origin --auto; then echo "Unable to resolve origin/HEAD while resolving the default branch" >&2; exit 1; fi',
      '   BASE_BRANCH=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed \'s#^origin/##\')',
      '   if [ -z "$BASE_BRANCH" ]; then echo "Unable to resolve the repository default branch" >&2; exit 1; fi',
    ]),
    ...(localReviewStateRequired ? [
      '   LOCAL_REVIEW_STATE_FILE="$(git rev-parse --git-path portos-local-review-state)"',
      '   if [ ! -s "$LOCAL_REVIEW_STATE_FILE" ]; then echo "Local review state is missing; refusing to publish an unverified branch" >&2; exit 1; fi',
      '   . "$LOCAL_REVIEW_STATE_FILE"',
      '   LOCAL_REVIEW_BASELINE_FILE="$(git rev-parse --git-path portos-local-review-baseline)"',
      '   if [ ! -s "$LOCAL_REVIEW_BASELINE_FILE" ]; then echo "Local review publication baseline is missing; refusing to publish" >&2; exit 1; fi',
      '   LOCAL_PRE_REBASE_REMOTE=$(grep -m1 "^LOCAL_PRE_REBASE_REMOTE=" "$LOCAL_REVIEW_BASELINE_FILE" | cut -d= -f2-)',
      '   LOCAL_PRE_REBASE_HEAD_SHA=$(grep -m1 "^LOCAL_PRE_REBASE_HEAD_SHA=" "$LOCAL_REVIEW_BASELINE_FILE" | cut -d= -f2-)',
      '   LOCAL_PRE_REBASE_REMOTE_SHA=$(grep -m1 "^LOCAL_PRE_REBASE_REMOTE_SHA=" "$LOCAL_REVIEW_BASELINE_FILE" | cut -d= -f2-)',
      '   if [ -z "$LOCAL_PRE_REBASE_REMOTE" ] || [ -z "$LOCAL_PRE_REBASE_HEAD_SHA" ]; then echo "Local review publication baseline is invalid; refusing to publish" >&2; exit 1; fi',
      '   CURRENT_HEAD_SHA=$(git rev-parse HEAD)',
      '   case "$LOCAL_OVERALL_STATUS" in clean|partial|review-blocked) ;; *) echo "Local review did not finish with an acceptable status; refusing to publish" >&2; exit 1 ;; esac',
      `   LOCAL_REMEDIATED_HEAD_SHA=$(node ${shellQuote(LOCAL_REVIEW_LIFECYCLE_SCRIPT)} publication-head ${base} "$LOCAL_OVERALL_STATUS") || exit 1`,
      '   if [ "$LOCAL_REMEDIATED_HEAD_SHA" != "$CURRENT_HEAD_SHA" ]; then echo "Local review phase completed at $LOCAL_REMEDIATED_HEAD_SHA, but HEAD is $CURRENT_HEAD_SHA; refusing to publish a changed branch" >&2; exit 1; fi',
    ] : []),
    `   BRANCH=${branch}`,
    '   PUSH_REMOTE=$(git config --get "branch.${BRANCH}.pushRemote")',
    '   PUSH_REMOTE_SOURCE=branch.pushRemote',
    '   if [ -z "$PUSH_REMOTE" ] || [ "$PUSH_REMOTE" = "." ]; then PUSH_REMOTE=$(git config --get remote.pushDefault); PUSH_REMOTE_SOURCE=remote.pushDefault; fi',
    '   if [ -z "$PUSH_REMOTE" ] || [ "$PUSH_REMOTE" = "." ]; then PUSH_REMOTE=$(git config --get "branch.${BRANCH}.remote"); PUSH_REMOTE_SOURCE=branch.remote; fi',
    '   if [ -z "$PUSH_REMOTE" ] || [ "$PUSH_REMOTE" = "." ]; then PUSH_REMOTE=origin; PUSH_REMOTE_SOURCE=default; fi',
    '   PUSH_REF=$(git config --get "branch.${BRANCH}.merge")',
    '   PUBLISH_ERROR="publish failed; refusing PR/MR"',
    '   publish_reviewed_branch() { git push --no-follow-tags "$@" || { echo "$PUBLISH_ERROR" >&2; exit 1; }; }',
    '   if [ "$PUSH_REMOTE_SOURCE" = "branch.remote" ] && [ -n "$PUSH_REF" ]; then',
    '     if [ "$PUSH_REF" != "refs/heads/$BRANCH" ] && [ "$PUSH_REF" != "$BRANCH" ]; then echo "Configured upstream $PUSH_REMOTE/$PUSH_REF does not name $BRANCH; refusing to publish" >&2; exit 1; fi',
    '   fi',
    '   if git ls-remote --exit-code --heads "$PUSH_REMOTE" "$BRANCH" >/dev/null 2>&1; then',
    '     PUBLISH_REMOTE="$PUSH_REMOTE"',
    '   else',
    '     publish_reviewed_branch -u "$PUSH_REMOTE" "$BRANCH"',
    '     PUBLISH_REMOTE=',
    '   fi',
    '   if [ -n "$PUBLISH_REMOTE" ]; then',
    '     if ! git fetch "$PUBLISH_REMOTE" "+refs/heads/${BRANCH}:refs/remotes/${PUBLISH_REMOTE}/${BRANCH}"; then echo "Unable to fetch the remote branch before publishing" >&2; exit 1; fi',
    '     REMOTE_BRANCH_SHA=$(git rev-parse "refs/remotes/$PUBLISH_REMOTE/$BRANCH" 2>/dev/null) || { echo "Unable to read the remote branch before publishing" >&2; exit 1; }',
    '     if git merge-base --is-ancestor "$REMOTE_BRANCH_SHA" HEAD; then',
    '       if [ -n "$PUSH_REF" ]; then publish_reviewed_branch "$PUBLISH_REMOTE" "HEAD:refs/heads/$BRANCH"; else publish_reviewed_branch -u "$PUBLISH_REMOTE" "HEAD:refs/heads/$BRANCH"; fi',
    '     elif [ "$PUBLISH_REMOTE" = "${LOCAL_PRE_REBASE_REMOTE:-}" ] && [ "$REMOTE_BRANCH_SHA" = "${LOCAL_PRE_REBASE_REMOTE_SHA:-}" ] && [ -n "${LOCAL_PRE_REBASE_HEAD_SHA:-}" ] && git merge-base --is-ancestor "$REMOTE_BRANCH_SHA" "$LOCAL_PRE_REBASE_HEAD_SHA" ]; then',
    '       if [ -n "$PUSH_REF" ]; then publish_reviewed_branch --force-with-lease="refs/heads/${BRANCH}:${REMOTE_BRANCH_SHA}" "$PUBLISH_REMOTE" "HEAD:refs/heads/$BRANCH"; else publish_reviewed_branch --force-with-lease="refs/heads/${BRANCH}:${REMOTE_BRANCH_SHA}" -u "$PUBLISH_REMOTE" "HEAD:refs/heads/$BRANCH"; fi',
    '     else',
    '       echo "Remote $PUBLISH_REMOTE/$BRANCH contains commits not in HEAD, or changed during synchronization; refusing to overwrite them" >&2; exit 1',
    '     fi',
    '   fi',
    ...(gitlab ? [] : [
      '   PUSH_OWNER=$(gh repo view "$(git remote get-url --push "$PUSH_REMOTE" 2>/dev/null)" --json owner -q .owner.login 2>/dev/null) || { echo "Unable to resolve PR head; refusing PR" >&2; exit 1; }',
      '   [ -n "$PUSH_OWNER" ] || { echo "Missing PR head owner; refusing PR" >&2; exit 1; }',
      '   PR_HEAD="$PUSH_OWNER:$BRANCH"',
    ]),
    gitlab
      ? `   PR_URL=$(glab mr create --source-branch ${branch} --target-branch ${base} --title "<conventional title>" --description "<description>" | grep -Eo 'https?://[^[:space:]]+' | tail -n 1)`
      : '   PR_URL=$(gh pr create --base ' + base + ' --head "$PR_HEAD" --title "<conventional title>" --body "<description>")',
    gitlab
      ? '   PR_NUMBER=$(glab mr view "$PR_URL" --output json | jq -r .iid)'
      : '   PR_NUMBER=$(gh pr view "$PR_URL" --json number -q .number)',
    '   ```',
    // `--fill` on a one-line commit produces an empty description; PortOS used
    // to generate the body server-side, so spell out what it must contain now
    // that the agent writes it.
    gitlab
      ? '   Write a real `--description`: a **Summary** section and a **Test plan** section, with no AI-attribution footer. If `glab` reports the merge request already exists, adopt its URL and IID before continuing.'
      : '   Write a real `--body`: a **Summary** section and a **Test plan** section, no AI-attribution footer. Do NOT use `--fill`. If `gh` reports the pull request already exists, adopt it instead of failing: `PR_URL=$(gh pr view --json url -q .url)`.',
    ...(localReviewStateRequired ? [`   Bind the created/recovered PR receipt: \`node ${shellQuote(LOCAL_REVIEW_LIFECYCLE_SCRIPT)} publish ${base} "$PR_URL"\`. Repair write failures without another review; follow the lifecycle guide for retries.`] : []),
    gitlab
      ? '   The GitLab MR URL and IID are captured in `$PR_URL` and `$PR_NUMBER`; use those variables for every review, merge, and verification command below.'
      : `   On a GitLab remote use \`glab mr create --source-branch ${branch} --target-branch ${base} --title "…" --description "…"\` and read the MR URL/IID back with \`glab mr view\`.`,
    ...(localReviewStateRequired && localReviewRequired ? [
      `   If \`LOCAL_OVERALL_STATUS=review-blocked\`, the following Merge Gate must leave the PR/MR open and must not merge it. ${REVIEW_UNAVAILABLE_REPORTING_NOTE}`,
    ] : []),
  ];
}

/**
 * WHO opens this run's pull request, per the prompt the sections above render
 * for it — a `PR_OPENED_BY` value, never null, so no caller has to invent a
 * meaning for "absent".
 *
 * This is the one gate; `inlinePrLifecycleSection` below is a projection of it.
 * They used to be the same predicate under a name that answered a narrower
 * question — `metadata.ownsPrWorkflow` meant "did the prompt render the INLINE
 * `git`/`gh` PR section", which is FALSE for a slashdo-capable Claude host,
 * because that host drives the whole lifecycle through `/do:pr` instead. Every
 * consumer read the name as "the agent opens its own PR" and got the opposite
 * answer for the host that most often does, so cleanup re-pushed the branch and
 * called `git.createPR` for a PR the agent had already opened (#6869).
 *
 * The three answers, in the order the prompt decides them:
 * - `PORTOS` — the run is not a local harness, is a lean `--bare` session, or
 *   its task shape hands the change request back to PortOS. Every exclusion
 *   below is one of those completion contracts.
 * - `AGENT_SLASHDO` — the session can type `/do:pr`, and the completion section
 *   emits it: `buildTuiCompletionSection`'s `cmd` for a TUI, the
 *   `WORKTREE_NO_PUSH` arm of `buildCliCompletionSection` for a CLI. Both are
 *   exactly "worktree + `openPR` + none of the exclusions below", which is what
 *   this gate has already established by the time we ask.
 * - `AGENT_INLINE` — everything else that clears the gate: a real harness that
 *   cannot type a slash command (codex / grok / agy / OpenCode), handed the
 *   plain `git`/`gh` steps plus the inline Review Loop / Merge Gate section.
 *
 * Not re-checked here: the claim-flow contract, whose completion mode also
 * emits no `/do:pr`. Every claim task type pins `useWorktree: false,
 * openPR: false` (see `taskScheduleRegistry.js`, which also protects both keys
 * from override), so the worktree and `openPR` gates below already exclude it —
 * and a claim prompt that somehow reached here would be answered correctly
 * anyway, since it opens and merges its own PR from its own procedure.
 *
 * @returns {string} a `PR_OPENED_BY` value
 */
export function promptOpensOwnPr(task, { providerType, providerId, providerCommand, leanMode, worktreeInfo }) {
  if (!LIGHT_CONTEXT_PROVIDER_TYPES.has(providerType)) return PR_OPENED_BY.PORTOS;
  if (!agentOwnsPrWorkflow({ providerType, leanMode })) return PR_OPENED_BY.PORTOS;
  // No worktree ⇒ no branch to name in `git push -u origin <branch>`, and the
  // one production shape here is a JIRA-ticket run (agentWorkspacePrep skips
  // worktree creation when a jiraBranch is set). Its PR is PortOS's to open and
  // a human's to land; telling the agent to open one too yields a PR opened
  // against a branch it had to guess at, and then a second `gh pr create` from
  // cleanup that fails "a pull request already exists".
  if (!worktreeInfo) return PR_OPENED_BY.PORTOS;

  const metadata = task?.metadata || {};
  if (!isTruthyMeta(metadata.openPR)) return PR_OPENED_BY.PORTOS;
  // The completion branches that hand back a contract which never opens a PR.
  if (isTruthyMeta(metadata.noCodeOutput) || metadata.creativeDirector) return PR_OPENED_BY.PORTOS;
  if (isTruthyMeta(metadata.discardWorktree)) return PR_OPENED_BY.PORTOS;
  if (isTruthyMeta(metadata.readOnly)) return PR_OPENED_BY.PORTOS;
  if (isTruthyMeta(metadata.reviewLoopFollowUp)) return PR_OPENED_BY.PORTOS;
  // A PR a human lands gets neither a review loop nor a merge gate.
  if (resolvePrCompletion(metadata) === PR_COMPLETIONS.LEAVE_OPEN || leavesPrForHuman(task)) return PR_OPENED_BY.PORTOS;

  return canTypeSlashCommands({ providerId, providerCommand, leanMode })
    ? PR_OPENED_BY.AGENT_SLASHDO
    : PR_OPENED_BY.AGENT_INLINE;
}

/**
 * Which inline PR-lifecycle section — if any — a run gets after its manual
 * completion workflow: `'review-loop'`, `'merge-gate'` (no reviewer configured,
 * so CI is the whole gate), or `null`.
 *
 * ONE definition, used by both the prompt assembly that renders the section and
 * the `buildAgentPrompt` preload that decides whether to read + stage the ~56KB
 * CLI-reviewer recipe for it. They were two conditions at opposite ends of the
 * file, and the loose one paid for a 56KB read and an `atomicWrite` on every
 * read-only / leave-open / merge-gate run whose section never rendered — while
 * the strict one restated four branches of the completion if/else chain by hand,
 * 130 lines away from the chain it mirrored.
 *
 * The section exists only on the inline path: a `/do:pr` run reviews and merges
 * inside that one command, so `promptOpensOwnPr` answering `AGENT_SLASHDO` is a
 * `null` here — which is exactly why the two questions need separate names.
 *
 * @returns {'review-loop'|'merge-gate'|null}
 */
export function inlinePrLifecycleSection(task, opts) {
  if (promptOpensOwnPr(task, opts) !== PR_OPENED_BY.AGENT_INLINE) return null;
  return resolvePrCompletion(task?.metadata || {}) === PR_COMPLETIONS.REVIEW_THEN_MERGE
    ? 'review-loop'
    : 'merge-gate';
}

/**
 * The inline review-loop (or, with no reviewer configured, merge-gate) section
 * for an agent that opened its own PR under the manual completion workflow.
 *
 * Deliberately the SAME builder the `sys-rl-*` follow-up agent gets, driven off
 * a synthesized `reviewLoop*` metadata shape: the procedure a follow-up runs and
 * the procedure an inline run needs are the same procedure, and the whole
 * regression this fixes came from having two of them. The PR coordinates are the
 * shell variables `buildManualPrCreateStep` captured, because the section is
 * rendered before the PR exists.
 */
export function buildInlineReviewLoopSection({
  taskId, branchName, runsReviewLoop, leaveOpen, localAgentLoopBody, localAgentLoopBodyPath = null, writesSentinel = false,
  reviewPolicy, localPhaseReviewers = [], localPhaseCanShortCircuit = false, localPhaseReviewRequired = false, reviewerPositions = [], forgeCli = 'gh', workflowStep, mergeHandoff = false,
}) {
  // Where control goes after the merge. A TUI run still owes PortOS its
  // `.agent-done` sentinel — telling it to "exit" here is how a finished merge
  // can otherwise sit without recording completion — while a CLI run signals completion by exiting.
  const inlineExitStep = writesSentinel
    ? 'Return to the **Completion Workflow** above and write the completion sentinel — the run is not done until you have. Do NOT open a second PR.'
    : 'You are done — exit. Do NOT open a second PR or push anything further.';
  return buildReviewLoopFollowUpSection({
    reviewLoopPRUrl: '$PR_URL',
    reviewLoopPRNumber: '$PR_NUMBER',
    reviewLoopPRBranch: branchName || '<branch>',
    ...reviewPolicyToLoopMetadata(reviewPolicy),
    reviewLoopLeaveOpen: leaveOpen,
    // No reviewer configured ⇒ the merge-gate variant (CI is the whole gate),
    // exactly as the merge-only follow-up gets.
    reviewLoopMergeOnly: !runsReviewLoop,
    sourceTaskId: taskId || 'unknown',
  }, { verbose: false, localAgentLoopBody, localAgentLoopBodyPath, inlineExitStep, forgeCli, inlineWorkflowStep: workflowStep, localPhaseReviewers, localPhaseCanShortCircuit, localPhaseReviewRequired, reviewerPositions, mergeHandoff });
}
