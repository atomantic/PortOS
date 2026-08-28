/**
 * Completion workflow, worktree, and sentinel prompt sections.
 */

import { DEFAULT_REVIEWER, DEFAULT_REVIEWERS, DEFAULT_REVIEW_STOP_MODE, normalizeReviewUsernames, resolveClaimReviewerConfig, buildReviewerPinNote, buildReviewerEffortNote, buildReviewWithArgs } from '../../lib/validation.js';
import { PROGRAMMATIC_OUTPUT_COMPLETION_HEADING } from '../../lib/agentSentinel.js';
import { canTypeSlashCommands, agentOwnsPrWorkflow } from '../../lib/slashdoInvocation.js';
import { shellQuote } from '../../lib/shellQuote.js';
import { PR_COMPLETIONS, leavesPrForHuman, resolvePrCompletion } from '../../lib/prDisposition.js';
import { LIGHT_CONTEXT_PROVIDER_TYPES, SIMPLIFY_INLINE_REVIEW } from './constants.js';
import { buildCiMergeGateSteps, buildReviewLoopFollowUpSection, LEAVE_PR_OPEN_STEP } from './reviewLifecycle.js';

export const NO_CHANGE_AUDIT_GUIDANCE = 'This audit may legitimately conclude that no change is needed. First verify the data this audit owns against authoritative sources. If the audited data is current, leave the worktree clean and do not run the commit, push, PR, or review steps below; write the completion sentinel when this provider uses one, or exit without committing when it does not. If a change is needed, continue through the normal workflow below.';

function withNoChangeAuditGuidance(guidance, noChangeSuccess) {
  return noChangeSuccess && guidance
    ? `${NO_CHANGE_AUDIT_GUIDANCE}\n\n${guidance}`
    : guidance;
}

/**
 * Build the single "## Guidelines" completion-handoff bullet for the full
 * (api) prompt path. Mirrors the helper pattern the light path already uses
 * (`worktreeCommitGuidance`, `buildTuiCompletionSection`) — same 4-branch
 * decision tree (read-only / TUI / worktree+PR / worktree-only / default) but
 * flattened into a function so reading is linear instead of a nested ternary.
 *
 * Returns the bullet body WITHOUT the leading `- ` marker (caller prepends),
 * or `null` when the branch produces no text (the legacy empty-string tail).
 *
 * @param {Object} opts
 * @param {boolean} opts.isReadOnly
 * @param {boolean} opts.isTui
 * @param {string} opts.tuiCompletionCommand - `/do:pr` or `/do:push`
 * @param {boolean} [opts.slashdoFree] - TUI without slashdo: the bullet points
 *   at the manual commit + system-handoff workflow instead of a `/do:*` command.
 * @param {Object|null} opts.worktreeInfo
 * @param {boolean} opts.willOpenPR
 * @param {'review-then-merge'|'merge-on-green'|'leave-open'} opts.prCompletion
 * @param {boolean} [opts.noChangeSuccess] - The task may succeed after a
 *   verified clean branch instead of producing a commit/PR.
 * @returns {string|null}
 */
export function buildCompletionGuidelineBullet({
  isReadOnly, isTui, tuiCompletionCommand, slashdoFree = false,
  worktreeInfo, willOpenPR, prCompletion = PR_COMPLETIONS.MERGE_ON_GREEN, discardWorktree = false, noCodeOutput = false,
  leavePrOpen = false, isPrFollowUp = false, claimFlow = false, noChangeSuccess = false, whenDone = null,
}) {
  // A PR follow-up (review-loop or merge-only) already carries its own PRIMARY
  // OBJECTIVE section with the full procedure, and its cleanup runs with
  // `skipMerge`. The generic "your branch is merged back automatically" bullet
  // would contradict both — and a merge-only run legitimately makes no commit.
  if (isPrFollowUp && !discardWorktree && !noCodeOutput && !isReadOnly) {
    return 'Follow the follow-up section above — it is the whole task. Commit and push only fixes you actually make; the deliverable is the PR\'s final state, not a commit. Do NOT open a new PR, and do NOT expect this branch to be merged back for you.';
  }
  // `noCodeOutput` is checked FIRST because the two flags answer different
  // questions: `discardWorktree` decides what happens to the checkout, while
  // `noCodeOutput` decides where the deliverable goes. A task that sets both —
  // "do your work through an API/CLI action during the run, and never land
  // code" — must be told its output channel is that action, NOT the sentinel.
  // Telling it "write your result to the sentinel" is how a run files nothing
  // and reports its findings into a file that gets thrown away (PLAN.md records
  // this exact hazard from the 2026-07-16 codex review). No pre-existing task
  // sets both, so this ordering changes nothing that shipped before it.
  if (noCodeOutput) {
    return '**This task produces no code output.** Its result is the API request or command your instructions describe (a PortOS endpoint call, a filed tracker issue, …) — do NOT run `/do:push`, `/do:pr`, `/simplify`, `git commit`, `git push`, or open a PR. Write the completion sentinel (see the Completion section) and stop.';
  }
  if (discardWorktree) {
    return '**This is a reasoning-only task.** The worktree is discarded on exit — do NOT commit, push, merge, or open a PR. Write your result to the completion sentinel (see the Completion section) and stop.';
  }
  if (claimFlow) {
    return '**This is a self-managed claim flow.** Follow the claim prompt above through its phase-specific worktree, PR/MR, review, merge or human-handoff, and cleanup steps. Do NOT stop after committing or hand the lifecycle back to PortOS.';
  }
  if (isReadOnly) {
    return '**This is a read-only task.** Do NOT commit, push, or modify any files in the repository. Only read data and generate reports.';
  }
  if (isTui) {
    // NOTE: in production this branch is only reachable from the full/api prompt
    // path, where `isTui` is currently always false (TUI providers route through
    // buildLightContextPrompt, which emits the live TUI completion via
    // buildTuiCompletionSection — not this bullet). It's kept provider-aware and
    // directly unit-tested so the guideline stays correct if that routing changes.
    const howTo = slashdoFree
      ? 'the Completion Workflow above (plain `git` commit + PortOS handoff — this provider has no slashdo commands)'
      : `the Completion Workflow above (\`${tuiCompletionCommand}\`)`;
    return withNoChangeAuditGuidance(`On successful completion, YOU run ${howTo}, then write the sentinel and stop — PortOS closes the session once it sees the sentinel; do NOT run \`/quit\`.`, noChangeSuccess);
  }
  if (worktreeInfo && willOpenPR) {
    const policyLeavesOpen = prCompletion === PR_COMPLETIONS.LEAVE_OPEN;
    const runsReviewLoop = prCompletion === PR_COMPLETIONS.REVIEW_THEN_MERGE;
    const reviewSuffix = policyLeavesOpen
      ? ' This task is configured to leave the PR OPEN for you to inspect — no follow-up agent will review or merge it automatically.'
      : leavePrOpen
        ? ' This task is tracked in JIRA, so the PR is left OPEN for a human to land alongside the ticket — nothing merges it automatically.' + (runsReviewLoop ? ' A follow-up agent still runs the configured reviewers against it.' : '')
      : runsReviewLoop
        ? ' For GitHub PRs, a Copilot code review will also be requested automatically (skipped on GitLab and other non-GitHub forges) — do NOT run `/do:rpr` or attempt to address review comments yourself; you will have already exited.'
        : ' No review was requested for this task, so a follow-up agent merges the PR once CI is green — do NOT try to merge it yourself; you will have already exited.';
    return withNoChangeAuditGuidance(`On successful completion, the system will push your branch and open a pull request — do NOT open a PR manually. (If the task fails, no PR is opened; the worktree is then cleaned up unless a safety check preserves it for manual recovery.)${reviewSuffix}`, noChangeSuccess);
  }
  if (worktreeInfo) {
    return withNoChangeAuditGuidance('Your worktree branch will be automatically merged back to the source branch when your task completes — do NOT open a PR.', noChangeSuccess);
  }
  return whenDone === null ? null : whenDone === 'commit-push'
    ? 'Commit and push your changes to the default branch (see Git Hygiene below).'
    : 'Leave your code changes uncommitted in the default branch; do not commit or push.';
}

// One-line worktree note for a discard (reasoning-only) task, replacing the
// "commit / push / auto-merge" guidance the normal worktree section emits. The
// worktree exists only so the reasoner can make scratch edits without touching
// the real tree — cleanup discards it with no commit/merge/PR (see
// `discardWorktree` in agentWorktreeCleanup.js).
export const DISCARD_WORKTREE_NOTE = 'Do NOT commit, push, or open a PR — this worktree is discarded on exit. Make any scratch edits that help you reason; only the completion sentinel is kept.';

/**
 * Is this worktree attached to a branch a PR already points at — i.e. the
 * review-loop follow-up, whose guidance is "push review fixes here, the PR
 * points at this branch"?
 *
 * Identified POSITIVELY, off the follow-up's own `reviewLoopFollowUp` marker,
 * rather than as "any `existingBranch` worktree". `existingBranch` means only
 * "attach to this branch" and now has two producers: the follow-up, and a retry
 * resuming a dead agent's branch (`resumedFromAgentId`), which follows the task's
 * ordinary push/PR flow and may have no PR at all. Keying on the marker means a
 * THIRD producer defaults to the ordinary flow instead of silently inheriting
 * review-fix instructions for a PR that doesn't exist.
 */
export function isPrBranchWorktree(task, worktreeInfo) {
  return worktreeInfo?.existingBranch === true && !!task?.metadata?.reviewLoopFollowUp;
}

/**
 * Is this worktree a RESUME of a previous failed agent's branch? Keyed on
 * `resumedFromAgentId`, which only the resume path stamps (see
 * agentCompletionCleanup.js).
 */
function isResumedWorktree(task, worktreeInfo) {
  return worktreeInfo?.existingBranch === true && !!task?.metadata?.resumedFromAgentId;
}

/**
 * Resume banner for a retry picking up what a PREVIOUS unfinished agent left
 * behind (`metadata.existingBranch` + `resumedFromAgentId`, stamped by
 * `recordTaskResumePointer` when a dead run's branch — or whole worktree —
 * survived cleanup).
 *
 * Without this the retry sees an ordinary worktree that just happens to have
 * work in it and redoes what is already done — the failure mode the
 * agent-d2ae0352 incident exposed (reaped 30s after its PR merged; the
 * replacement agent started the shipped work over). Telling it to read the log
 * FIRST is the whole point: the prior run may have gone as far as opening or even
 * merging a PR, in which case there is nothing left to build.
 *
 * An ADOPTED worktree (`worktreeInfo.adopted` — the shape a server restart leaves,
 * killed mid-edit before committing) additionally carries the dead run's
 * uncommitted edits and untracked files, so the banner points at `git status`
 * as the primary record rather than the commit log.
 *
 * Returns '' when this isn't a resume, so callers can interpolate unconditionally.
 */
export function buildResumeSection(task, worktreeInfo) {
  if (!isResumedWorktree(task, worktreeInfo)) return '';
  const priorAgentId = task.metadata.resumedFromAgentId;
  const carriedWork = worktreeInfo.adopted
    ? `**You are in its actual working directory** — its commits are on your branch \`${worktreeInfo.branchName}\`
AND any edits it had not committed yet are still in your working tree, exactly as it left them.`
    : `**Its commits are already on your branch** \`${worktreeInfo.branchName}\` — you are
continuing its run, not starting over.`;
  return `
## Resuming Unfinished Work — Read This First
A previous agent (\`${priorAgentId}\`) worked this same task and did NOT finish cleanly
(it hung, timed out, or was terminated — a server restart kills runs mid-edit).
${carriedWork}

Before you write any code, establish what is already done:
1. \`git status\` — anything it left uncommitted. Treat these as YOUR in-progress
   changes: review them, finish them, and commit them. Do not discard them wholesale.
2. \`git log --oneline ${worktreeInfo.baseBranch || 'origin/HEAD'}..HEAD\` — the commits it already made.
3. Check whether it already shipped: look for an open or merged PR for this branch
   — \`gh pr list --head ${worktreeInfo.branchName} --state all\` on GitHub,
   \`glab mr list --source-branch ${worktreeInfo.branchName}\` on GitLab.

Then do only what remains. If a PR is already **merged**, the work is done — go
straight to your completion step and report that. If a PR is already **open**,
finish/land that PR rather than opening a second one. Do NOT redo completed work,
and do NOT revert its commits unless they are actually wrong.
`;
}

/**
 * Completion block for a **programmatic-output** (throwaway-worktree) task: the
 * agent reasons in a worktree that is discarded on exit, so it must NOT commit,
 * push, merge, or open a PR. Its only channel out is the `.agent-done` sentinel,
 * whose exact payload shape is specified by the task instructions (a task-type
 * output hook — see `taskTypeHooks.js` / `layeredIntelligenceHooks.js`). This
 * replaces the normal `/do:push`+markdown-sentinel completion workflow, which
 * would tell the agent to push code (defeating the discard guarantee) and write
 * a markdown summary (breaking the hook's structured-JSON sentinel contract).
 */
export function buildProgrammaticOutputCompletionSection(sentinelPath) {
  return [
    // Shared constant: a pre-spawn task-type hook's prompt points here BY NAME.
    `## ${PROGRAMMATIC_OUTPUT_COMPLETION_HEADING}`,
    'This is a reasoning task, not a code change. The worktree you are in is **discarded on exit** — any commits, pushes, or PRs are thrown away and have no effect. Do NOT run `/do:push`, `/do:pr`, `git commit`, `git push`, or open a pull request.',
    '',
    `When you have finished reasoning, write your result to \`${sentinelPath}\` in the exact payload format described in your task instructions, then stop. PortOS watches this sentinel and finalizes the run shortly after it appears — do NOT run \`/quit\` and do NOT wait for anything after writing the sentinel.`
  ].join('\n');
}

/**
 * Completion block for a **read-only** task (e.g. reference-watch, pr-reviewer's
 * scan stage). The agent must NOT commit/push/modify source; its real output is
 * recorded elsewhere DURING the run (a tracker issue, PLAN.md, a report).
 *
 * A TUI agent still needs a `.agent-done` sentinel to signal completion — the
 * sentinel watcher in `spawnTuiAgent` is the primary finalize path and the channel
 * that ingests the run summary. Without it a read-only TUI run relies on shell
 * exit, so the resolution summary is not captured cleanly (the bug this
 * repairs). CLI/API read-only agents complete on process exit and never poll a
 * sentinel, so they get the bare notice only.
 */
export function buildReadOnlyCompletionSection({ isTui = false, sentinelPath = null } = {}) {
  const notice = '## Read-Only Task\nDo NOT commit, push, or modify any files. Read data and report findings only.';
  if (!isTui || !sentinelPath) return notice;
  return [
    notice,
    '',
    `When you have finished, write a short markdown summary of what you found (and where you recorded it) to \`${sentinelPath}\`, then stop. PortOS watches this sentinel and finalizes the run shortly after it appears — do NOT run \`/quit\` and do NOT wait for anything after writing the sentinel.`
  ].join('\n');
}

/**
 * Completion block for a **no-code / API-action** task (e.g. a Creative Director
 * plan/treatment/evaluate agent). The agent's deliverable is the HTTP request its
 * task instructions already describe (a PATCH to a PortOS endpoint), NOT a code
 * change — so the normal `/do:push`+PR completion workflow is wrong: there is
 * nothing to commit or push, and telling the agent to run `/do:push` just makes it
 * load that skill for no reason (and can contradict the task prompt's own
 * "on a 200 your task is complete"). A TUI agent still writes a `.agent-done`
 * sentinel so the watcher finalizes it promptly instead of waiting for a runtime
 * reaper.
 */
export function buildActionOutputCompletionSection({ isTui = false, sentinelPath = null } = {}) {
  const notice = '## Completion (No Code Output)\nThis task produces **no code change** — its result is delivered DURING the run by the API request or command your instructions describe (a PATCH to a PortOS endpoint, a filed tracker issue, …), not by a commit and not by this sentinel. Do NOT run `/do:push`, `/do:pr`, `/simplify`, `git commit`, `git push`, or open a pull request; there is nothing to push.';
  if (!isTui || !sentinelPath) return notice;
  return [
    notice,
    '',
    `Your task is complete once that request succeeds. Then write a one-line summary to \`${sentinelPath}\` and stop — PortOS watches this sentinel and finalizes the run shortly after it appears. Do NOT run \`/quit\` and do NOT wait for anything after writing the sentinel.`
  ].join('\n');
}

/**
 * The `--review-with` token list a claim task's prompt names, read back off the
 * task record. The claim generators persist the bundle they rendered into
 * `{reviewers}` (`reviewerConfigMetadata`), so this reproduces that CSV exactly.
 *
 * A claim task queued before #4770 carries no reviewer metadata, so this falls
 * through to the install's Code Review Defaults — routed through the claim
 * resolver so an in-flight legacy task can't be pinned to a bare `copilot`,
 * which a claim agent has no CLI to invoke (#2507).
 */
export function claimReviewersCsv(task, codeReviewDefaults, defaultReviewers) {
  return resolveClaimReviewerConfig(task?.metadata, codeReviewDefaults, defaultReviewers).csv;
}

/**
 * Completion handoff for claim prompts that create their own worktree and own
 * the forge lifecycle. `openPR: false` must remain the CoS provisioning posture,
 * so claimFlow is the explicit signal that keeps these prompts out of the
 * generic commit-only handoff.
 *
 * This is also the ONE emitter of the reviewer pin (#4770). Every claim
 * generator persists the reviewer bundle it rendered into `{reviewers}` onto the
 * task, so `resolveClaimReviewerConfig(task.metadata, …)` here reproduces that
 * exact CSV — which means the pin covers all five claim task types from one call
 * site, instead of three prose appends in `cosTaskGenerator.js` that a new claim
 * generator could forget.
 *
 * @param {string} [reviewersCsv] - the emitted `--review-with` token list to pin;
 *   empty suppresses the block (`buildReviewerPinNote` returns '').
 */
export function buildClaimFlowCompletionSection({ isTui = false, sentinelPath = null, reviewersCsv = '' } = {}) {
  const pin = buildReviewerPinNote(reviewersCsv);
  const lines = [
    ...(pin ? [pin, ''] : []),
    '## Claim Workflow Handoff',
    'This is a self-managed claim flow. The claim prompt above owns its claim worktree, branch, PR/MR, review, merge or human-handoff, and cleanup. Follow its phase-specific exit conditions — do NOT stop after a code commit or hand the lifecycle back to PortOS.',
    '',
    'For a successful claim, signal completion only after the prompt\'s prescribed PR/MR and cleanup steps are complete. For a clean no-work, blocked, or review-stuck exit, follow the prompt\'s prescribed leave-open/cleanup path first.'
  ];
  if (isTui && sentinelPath) {
    lines.push('', 'When that path is complete, write the completion sentinel and stop:', '', ...buildSentinelWriteSteps(1, sentinelPath, '   ## PR/MR\n   <PR or MR URL, or explain the clean exit>'));
  } else {
    lines.push('', 'After the prompt\'s prescribed final step, exit so PortOS can record the completed claim.');
  }
  return lines.join('\n');
}

/**
 * Worktree commit-guidance helper for the light prompt. Picks the right
 * single-sentence instruction based on whether the agent will run its own
 * push workflow (TUI or Claude Code CLI with slashdo), reuse an existing PR
 * branch (review fixes), or hand off to PortOS's post-exit push.
 */
export function worktreeCommitGuidance({ isTui, hasSlashdo, ownsPrWorkflow = false, isWorktreeOnExistingBranch, willOpenPR, discardWorktree, claimFlow = false, noChangeSuccess = false }) {
  if (discardWorktree) return DISCARD_WORKTREE_NOTE;
  if (claimFlow) return 'The claim workflow in the Completion section owns the push, PR/MR, review, merge or human-handoff, and cleanup steps.';
  if (isTui) return withNoChangeAuditGuidance('Commit your changes to this branch — see **Completion Workflow** below.', noChangeSuccess);
  if (isWorktreeOnExistingBranch) {
    return withNoChangeAuditGuidance('Commit and **push** any review-fix commits to this branch (the PR points at it). Use `git pull --rebase` before pushing if needed.', noChangeSuccess);
  }
  if (hasSlashdo && willOpenPR) {
    return withNoChangeAuditGuidance('Commit your changes here — the **Completion** section below drives the push and PR.', noChangeSuccess);
  }
  if (hasSlashdo) {
    return withNoChangeAuditGuidance('Commit your changes here — the **Completion** section below drives the push.', noChangeSuccess);
  }
  if (ownsPrWorkflow && willOpenPR) {
    return withNoChangeAuditGuidance('Commit your changes here — the **Completion** section below drives the push, the PR, the review loop, and the merge.', noChangeSuccess);
  }
  if (willOpenPR) {
    return withNoChangeAuditGuidance('Commit your changes here. The system will push and open a PR after you exit — do NOT push or open a PR yourself.', noChangeSuccess);
  }
  return withNoChangeAuditGuidance('Commit your changes here. Your branch will be merged back automatically when the task completes.', noChangeSuccess);
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
 * both agent flows converge on the same final state. `reviewers` only colors
 * the wording — the merge step itself is reviewer-agnostic.
 *
 * `prCompletion` selects the review gate or CI-only merge gate. Leave-open
 * callers do not invoke this helper.
 */
function buildPostPRMergeSteps(startStep, { prCompletion = PR_COMPLETIONS.REVIEW_THEN_MERGE, reviewers = DEFAULT_REVIEWERS, usernames = [], reviewStopMode = DEFAULT_REVIEW_STOP_MODE } = {}) {
  // No review loop → CI is the whole gate, so emit the shared CI procedure that
  // the manual-TUI workflow and the merge follow-up agent also use. The PR URL
  // isn't known when this prompt is written, hence the placeholder.
  if (prCompletion === PR_COMPLETIONS.MERGE_ON_GREEN) {
    const gate = buildCiMergeGateSteps(startStep, { prRef: '"<PR_URL>"', forge: 'unknown' });
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
  const lines = [
    `${startStep}. **Merge the PR immediately when the ${reviewerLabel}review loop reports ${mergeStatuses}** — \`/do:pr\` opens the PR and runs the review loop but does NOT merge. Capture the PR URL printed by \`/do:pr\` and run the exact command below (flags: \`--merge --delete-branch\`, nothing else — a true merge commit keeps the branch tip in main's history so automated worktree cleanup can prove the branch is merged; any merge-deferral flag leaves the PR open after you exit). Skip the merge if the loop ended \`timeout\`, \`error\`, \`inconclusive\`, or \`guardrail\`; leave the PR open for human follow-up.`,
    '   ```bash',
    '   gh pr merge "<PR_URL>" --merge --delete-branch',
    '   ```',
    `${startStep + 1}. Confirm the merge before exiting: \`gh pr view "<PR_URL>" --json state -q .state\` must return \`MERGED\`. If it returns \`OPEN\` or \`CLOSED\`, investigate (failing check, unresolved thread, branch protection), fix, and retry. Do NOT exit until state is \`MERGED\` (or you have explicitly decided not to merge per the rule above).`
  ];
  return { lines, nextStep: startStep + 2 };
}

/**
 * Resolve the review-loop invocation shared by buildTuiCompletionSection and
 * buildCliCompletionSection: the normalized reviewer usernames, the
 * `--review-with ...` argument text, and the effort-pin note. Both callers
 * used to re-derive this identical trio from the same 8-field reviewer-config
 * bundle independently.
 */
function resolveReviewInvocation({ willOpenPR, runsReviewLoop, reviewers, usernames, optionalReviewers, reviewerMaxRounds, reviewerModels, reviewerEfforts, reviewStopMode, reviewerApplies }) {
  const reviewUsernames = normalizeReviewUsernames(usernames);
  const reviewArgs = willOpenPR
    ? (runsReviewLoop ? buildReviewWithArgs(reviewers, { stopMode: reviewStopMode, reviewerApplies, usernames: reviewUsernames, optionalReviewers, reviewerMaxRounds, reviewerModels, reviewerEfforts }) : '--review-with none')
    : '';
  // Effort pins ride the emitted `--review-with` tokens as `~effort=<level>`, so
  // the prose note is suppressed whenever that suffix is present — it only speaks
  // for an invocation that pins no reviewer list (see buildReviewerEffortNote).
  const effortNote = willOpenPR && runsReviewLoop
    ? buildReviewerEffortNote(reviewers, reviewerEfforts, { reviewWith: reviewArgs, reviewerModels })
    : '';
  return { reviewUsernames, reviewArgs, effortNote };
}

/**
 * The `.agent-done` sentinel-write instruction block shared by
 * buildTuiCompletionSection and buildManualTuiCompletionSection: the "write a
 * short summary, then stop" instruction plus the fenced heredoc template.
 * Returns the lines to splice into the caller's own line array — output must
 * stay byte-identical since this is agent-facing prompt text.
 */
export function buildSentinelWriteSteps(stepNumber, sentinelPath, sentinelTail) {
  return [
    `${stepNumber}. Write a short markdown summary (~5–15 lines) to the completion sentinel, then stop — this sentinel is the done signal. PortOS watches it and finalizes the run shortly after it appears. Do NOT run \`/quit\` (it's a UI command, not something you can invoke) and do NOT wait for anything after writing the sentinel.`,
    '',
    '   ```bash',
    `   cat > "${sentinelPath}" <<'EOF'`,
    '   ## Summary',
    '   <one-sentence statement of what was accomplished>',
    '',
    '   ## Changes',
    '   - <key file or area>: <what changed and why>',
    '',
    sentinelTail,
    '   EOF',
    '   ```'
  ];
}

/**
 * Keep the manual pre-PR gate aligned with the review loop's `~opt` contract.
 * Defaulting to required preserves the fail-closed behavior for direct callers
 * that provide a local section without its reviewer metadata.
 */
function localReviewCompletionInstruction(localReviewRequired = true) {
  if (!localReviewRequired) {
    return 'Complete the **Local Review Before Opening the PR/MR** section below. All local reviewers are optional, so missing/inconclusive results (including skipped, timeout, malformed, or no-verdict) may continue. Set aggregate `LOCAL_OVERALL_STATUS=clean` for clean, configured capped, or optional inconclusive; use `partial` only for a qualifying stop, never raw statuses. Hard errors, failed build/test, rejection, or unpushed fixes block. Still run each reviewer and fix its findings.';
  }
  return 'Complete the **Local Review Before Opening the PR/MR** section below. Commit its fixes. A missing/timed-out/malformed/inconclusive REQUIRED review blocks publication; an OPTIONAL inconclusive result may continue. Set aggregate `LOCAL_OVERALL_STATUS=clean` for clean, configured capped, or optional inconclusive; use `partial` only for a qualifying stop, never raw statuses. Hard errors, failed build/test, rejection, or unpushed fixes block.';
}

/**
 * TUI completion-workflow block. The TUI owns its own commit → push → PR
 * pipeline via slashdo commands and signals "done" with a sentinel file.
 *
 * When `slashdoFree` is set — any TUI that does NOT load Claude Code slash
 * commands: OpenCode, codex/antigravity/grok/kimi, or a lean `--bare` Claude
 * session — the agent can't run `/do:pr` / `/do:push`, so it delegates to the
 * plain-git/`gh` variant below (same sentinel handshake, no slashdo). The caller
 * resolves that flag once via `canTypeSlashCommands` (#3114); past the early
 * return this IS a Claude session, so `/simplify` and `/do:pr` are both safe to
 * emit without a second provider check.
 */
export function buildTuiCompletionSection({ willOpenPR, prCompletion = PR_COMPLETIONS.MERGE_ON_GREEN, simplifyEnabled, sentinelPath, slashdoFree = false, ownsPrWorkflow = false, branchName = null, baseBranch = null, leavePrOpen = false, reviewers = DEFAULT_REVIEWERS, usernames = [], optionalReviewers = [], reviewerMaxRounds = {}, reviewerModels = {}, reviewerEfforts = {}, reviewStopMode = DEFAULT_REVIEW_STOP_MODE, reviewerApplies = false, forgeCli = 'gh', noChangeSuccess = false, localReviewSection = '', localReviewRequired = true, postPrReview = null }) {
  const policyLeavesOpen = prCompletion === PR_COMPLETIONS.LEAVE_OPEN;
  const runsReviewLoop = prCompletion === PR_COMPLETIONS.REVIEW_THEN_MERGE;
  if (slashdoFree) {
    // Plain `git`/`gh` instead of `/do:pr` — but still the whole lifecycle when
    // the session is a real coding harness (`ownsPrWorkflow`); the reviewer
    // procedure it needs is inlined in the Review Loop section that follows.
    return buildManualTuiCompletionSection({ willOpenPR, prCompletion, simplifyEnabled, sentinelPath, branchName, baseBranch, leavePrOpen, ownsPrWorkflow, forgeCli, noChangeSuccess, localReviewSection, localReviewRequired, postPrReview });
  }
  const cmd = willOpenPR ? '/do:pr' : '/do:push';
  // `/do:pr` may inherit a saved `review-with` default. Explicitly opt out
  // when the task's Review Loop control is off so that default cannot start a
  // Copilot (or other external) review unexpectedly.
  const { reviewUsernames, reviewArgs, effortNote } = resolveReviewInvocation({ willOpenPR, runsReviewLoop, reviewers, usernames, optionalReviewers, reviewerMaxRounds, reviewerModels, reviewerEfforts, reviewStopMode, reviewerApplies });
  // A saved slashdo `merge: true` default would otherwise merge a PR that must
  // stay open — dropping our own merge steps isn't enough, `/do:pr` has to be
  // told not to merge (see lib/prDisposition.js).
  const mergeArg = (willOpenPR && (leavePrOpen || policyLeavesOpen)) ? ' --no-merge' : '';
  const reviewerArg = (reviewArgs ? ` ${reviewArgs}` : '') + mergeArg;
  const copilotOnly = reviewers.length === 1 && reviewers[0] === DEFAULT_REVIEWER && reviewUsernames.length === 0;
  const reviewerListLabel = [...reviewers, ...reviewUsernames.map(u => `@${u}`)].join(', ');
  // Ordering matters to the agent: `/do:pr` partitions the list and runs every
  // local reviewer BEFORE it creates the PR, so the PR opens against an
  // already-review-clean branch and only the cloud-side reviewers (Copilot,
  // `@login`) plus CI remain. Saying "after the PR opens" of the whole list had
  // agents expecting — and sometimes hand-rolling — a post-PR local pass.
  const reviewSuffix = willOpenPR && runsReviewLoop
    ? (copilotOnly
        ? ' — `/do:pr` runs the Copilot review loop after the PR opens.'
        : ` — \`/do:pr\` runs the review loop for ${reviewerListLabel} in order: local reviewers before it opens the PR, then the PR-side reviewers (Copilot / \`@login\`) once it is open.`)
    : (willOpenPR ? ' — external review is disabled for this task.' : '');
  // Reached only for a Claude TUI (a non-Claude one took the slashdoFree branch
  // above), so `/simplify` — a Claude Code built-in — is invokable here.
  const simplifyStep = simplifyEnabled ? '1. `/simplify`' : '1. (simplify disabled — skip)';
  const sentinelTail = willOpenPR
    ? (noChangeSuccess
        ? '   ## PR\n   <PR URL, or "No change needed; no PR opened." if the audit made no change>'
        : '   ## PR\n   <PR URL>')
    : '   ## Branch\n   <branch name>';
  // A PR gets merge steps — gated on the review verdict when a loop runs, on CI
  // alone when it doesn't (nothing else merges a no-review-loop PR). The one
  // exception is a PR a human lands (JIRA-tracked; see lib/prDisposition.js).
  const merge = (willOpenPR && !leavePrOpen && !policyLeavesOpen)
    ? buildPostPRMergeSteps(3, { prCompletion, reviewers, usernames: reviewUsernames, reviewStopMode })
    : { lines: (leavePrOpen || policyLeavesOpen) && willOpenPR ? [LEAVE_PR_OPEN_STEP(3, leavePrOpen)] : [], nextStep: (leavePrOpen || policyLeavesOpen) && willOpenPR ? 4 : 3 };
  const sentinelStep = merge.nextStep;

  return [
    '## Completion Workflow',
    ...(noChangeSuccess ? ['', NO_CHANGE_AUDIT_GUIDANCE, ''] : []),
    'When the task is complete, run these in order:',
    '',
    simplifyStep,
    `2. \`${cmd}${reviewerArg}\`${reviewSuffix}`,
    ...(effortNote ? [`   ${effortNote}`] : []),
    ...merge.lines,
    ...buildSentinelWriteSteps(sentinelStep, sentinelPath, sentinelTail)
  ].join('\n');
}

/**
 * Which numbered step of the manual completion workflow the inline review-loop /
 * merge-gate section is. The manual workflow always emits step 1 (simplify, or
 * an explicit "disabled — skip" placeholder) and step 2 (commit) before the PR
 * steps, so the number is stable and the two sections can cross-reference each
 * other without threading a counter between them.
 */

/** Same coercion the callers pass in; a default so external callers needn't. */
const isTruthyMetaDefault = (v) => v === true || v === 'true';

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
function buildManualPrCreateStep(step, { branchName, baseBranch, forgeCli = 'gh', localReviewStateRequired = false }) {
  const branch = promptRef(branchName, '<branch>');
  const hasBaseBranch = typeof baseBranch === 'string' && baseBranch && baseBranch !== '<base-branch>';
  const base = hasBaseBranch ? promptRef(baseBranch, '<base-branch>') : '"$BASE_BRANCH"';
  const gitlab = forgeCli === 'glab';
  return [
    `${step}. Publish the branch and open the pull request yourself, capturing its URL and number:`,
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
      '   case "$LOCAL_OVERALL_STATUS" in clean|partial) ;; *) echo "Local review did not finish with an acceptable status; refusing to publish" >&2; exit 1 ;; esac',
      '   if [ "$LOCAL_REVIEWED_HEAD_SHA" != "$CURRENT_HEAD_SHA" ]; then echo "Local review covered $LOCAL_REVIEWED_HEAD_SHA, but HEAD is $CURRENT_HEAD_SHA; refusing to publish an unreviewed branch" >&2; exit 1; fi',
    ] : []),
    `   BRANCH=${branch}`,
    '   PUSH_REMOTE=$(git config --get "branch.${BRANCH}.pushRemote")',
    '   PUSH_REMOTE_SOURCE=branch.pushRemote',
    '   if [ -z "$PUSH_REMOTE" ] || [ "$PUSH_REMOTE" = "." ]; then PUSH_REMOTE=$(git config --get remote.pushDefault); PUSH_REMOTE_SOURCE=remote.pushDefault; fi',
    '   if [ -z "$PUSH_REMOTE" ] || [ "$PUSH_REMOTE" = "." ]; then PUSH_REMOTE=$(git config --get "branch.${BRANCH}.remote"); PUSH_REMOTE_SOURCE=branch.remote; fi',
    '   if [ -z "$PUSH_REMOTE" ] || [ "$PUSH_REMOTE" = "." ]; then PUSH_REMOTE=origin; PUSH_REMOTE_SOURCE=default; fi',
    '   PUSH_REF=$(git config --get "branch.${BRANCH}.merge")',
    '   PUBLISH_ERROR="publish failed; refusing PR/MR"',
    '   publish_reviewed_branch() { git push "$@" || { echo "$PUBLISH_ERROR" >&2; exit 1; }; }',
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
    '     if ! git fetch "$PUBLISH_REMOTE" "+refs/heads/$BRANCH:refs/remotes/$PUBLISH_REMOTE/$BRANCH"; then echo "Unable to fetch the remote branch before publishing" >&2; exit 1; fi',
    '     REMOTE_BRANCH_SHA=$(git rev-parse "refs/remotes/$PUBLISH_REMOTE/$BRANCH" 2>/dev/null) || { echo "Unable to read the remote branch before publishing" >&2; exit 1; }',
    '     if git merge-base --is-ancestor "$REMOTE_BRANCH_SHA" HEAD; then',
    '       if [ -n "$PUSH_REF" ]; then publish_reviewed_branch "$PUBLISH_REMOTE" "HEAD:refs/heads/$BRANCH"; else publish_reviewed_branch -u "$PUBLISH_REMOTE" "HEAD:refs/heads/$BRANCH"; fi',
    '     elif [ "$PUBLISH_REMOTE" = "${LOCAL_PRE_REBASE_REMOTE:-}" ] && [ "$REMOTE_BRANCH_SHA" = "${LOCAL_PRE_REBASE_REMOTE_SHA:-}" ] && [ -n "${LOCAL_PRE_REBASE_HEAD_SHA:-}" ] && git merge-base --is-ancestor "$REMOTE_BRANCH_SHA" "$LOCAL_PRE_REBASE_HEAD_SHA" ]; then',
    '       if [ -n "$PUSH_REF" ]; then publish_reviewed_branch --force-with-lease="refs/heads/$BRANCH:$REMOTE_BRANCH_SHA" "$PUBLISH_REMOTE" "HEAD:refs/heads/$BRANCH"; else publish_reviewed_branch --force-with-lease="refs/heads/$BRANCH:$REMOTE_BRANCH_SHA" -u "$PUBLISH_REMOTE" "HEAD:refs/heads/$BRANCH"; fi',
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
    gitlab
      ? '   The GitLab MR URL and IID are captured in `$PR_URL` and `$PR_NUMBER`; use those variables for every review, merge, and verification command below.'
      : `   On a GitLab remote use \`glab mr create --source-branch ${branch} --target-branch ${base} --title "…" --description "…"\` and read the MR URL/IID back with \`glab mr view\`.`,
  ];
}

/**
 * Manual (slashdo-free) completion-workflow block — every provider that can't
 * type `/do:pr` (codex, grok/agy, OpenCode, a lean `--bare` Claude session).
 *
 * When `ownsPrWorkflow` is set the agent drives the WHOLE lifecycle in one
 * session: commit → push → open the PR → run the inline review loop → merge.
 * That is the point of the flag — see `agentOwnsPrWorkflow`. Not typing a slash
 * command never meant "can't run `gh`", but this block used to conclude exactly
 * that, so every agy/grok/codex task ended in a commit and PortOS bought a
 * second cold agent (`sys-rl-*`) just to review and land the PR.
 *
 * `ownsPrWorkflow: false` (lean mode) keeps the original handoff: commit and
 * stop, PortOS owns the post-exit push / PR / review / merge lifecycle.
 */
function buildManualTuiCompletionSection({ willOpenPR, prCompletion = PR_COMPLETIONS.REVIEW_THEN_MERGE, simplifyEnabled, sentinelPath, branchName = null, baseBranch = null, leavePrOpen = false, ownsPrWorkflow = false, forgeCli = 'gh', noChangeSuccess = false, localReviewSection = '', localReviewRequired = true, postPrReview = null }) {
  const policyLeavesOpen = prCompletion === PR_COMPLETIONS.LEAVE_OPEN;
  const runsReviewLoop = postPrReview ?? (prCompletion === PR_COMPLETIONS.REVIEW_THEN_MERGE);
  // `ownsPrWorkflow` already folds in `willOpenPR`, the worktree, and the
  // leave-open exclusions — it is `inlinePrLifecycleSection() !== null` (see the
  // caller). Re-testing any of them here is how the two drifted apart before.
  const drivesOwnPr = ownsPrWorkflow;
  const simplifyStep = simplifyEnabled
    ? `1. Before committing, ${SIMPLIFY_INLINE_REVIEW} and fix any findings.`
    : '1. (simplify disabled — skip)';
  const sentinelTail = drivesOwnPr
    ? (noChangeSuccess
        ? '   ## PR\n   <PR URL, or "No change needed; no PR opened." if the audit made no change>'
        : '   ## PR\n   <PR URL>')
    : '   ## Branch\n   <branch name>';

  const lines = [
    '## Completion Workflow',
    ...(noChangeSuccess ? ['', NO_CHANGE_AUDIT_GUIDANCE, ''] : []),
    drivesOwnPr
      ? `This provider does NOT have slashdo (\`/do:*\`) commands, so drive the handoff with plain \`git\` and \`${forgeCli}\`. **You own this ${forgeCli === 'glab' ? 'MR' : 'PR'} end to end — nothing else will open, review, or merge it.** Run these in order:`
      : 'This provider does NOT have slashdo (`/do:*`) commands, so finish the handoff with plain `git`. Run these in order:',
    '',
    simplifyStep,
    '2. Stage only the files you changed (never `git add -A` / `git add .`) and commit with a conventional message (`feat:`/`fix:`/`breaking:` prefix, no Co-Authored-By annotations):',
    '',
    '   ```bash',
    '   git add <file> [<file> ...]',
    '   git commit -m "feat: <description>"',
    '   ```',
  ];

  let step = 3;
  if (drivesOwnPr) {
    if (localReviewSection) {
      lines.push(`${step++}. ${localReviewCompletionInstruction(localReviewRequired)}`);
      lines.push('', localReviewSection, '');
    }
    lines.push(...buildManualPrCreateStep(step++, { branchName, baseBranch, forgeCli, localReviewStateRequired: Boolean(localReviewSection) }));
    lines.push(`${step++}. Work through the **${runsReviewLoop ? 'Review Loop' : 'Merge Gate'}** section below in full — it ends by merging the PR. Come back here when it is done.`);
  } else if (willOpenPR) {
    const handoff = policyLeavesOpen
      ? 'PortOS will push the branch, create a pull request with your completion summary as its description, and leave it open for inspection.'
      : leavePrOpen
      ? 'PortOS will push the branch and create a pull request for the JIRA-linked human handoff.'
      : runsReviewLoop
        ? 'PortOS will push the branch, create a pull request with your completion summary as its description, run the configured reviewer follow-up, and merge only after review and CI pass.'
        : 'PortOS will push the branch, create a pull request with your completion summary as its description, and merge it once CI is green.';
    lines.push(`${step++}. Do NOT push, open, or merge a pull request yourself. ${handoff}`);
  } else {
    lines.push(`${step++}. Do NOT push this worktree branch yourself. PortOS will merge it back after completion.`);
  }

  lines.push(...buildSentinelWriteSteps(step, sentinelPath, sentinelTail));

  return lines.join('\n');
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
 * @returns {'review-loop'|'merge-gate'|null}
 */
export function inlinePrLifecycleSection(task, { providerType, providerId, providerCommand, leanMode, worktreeInfo, isTruthyMetaFn = isTruthyMetaDefault }) {
  if (!LIGHT_CONTEXT_PROVIDER_TYPES.has(providerType)) return null;
  if (!agentOwnsPrWorkflow({ providerType, leanMode })) return null;
  // A slashdo-capable session drives all of this through `/do:pr` instead.
  if (canTypeSlashCommands({ providerId, providerCommand, leanMode })) return null;
  // No worktree ⇒ no branch to name in `git push -u origin <branch>`, and the
  // one production shape here is a JIRA-ticket run (agentWorkspacePrep skips
  // worktree creation when a jiraBranch is set). Its PR is PortOS's to open and
  // a human's to land; telling the agent to open one too yields a PR opened
  // against a branch it had to guess at, and then a second `gh pr create` from
  // cleanup that fails "a pull request already exists".
  if (!worktreeInfo) return null;

  const metadata = task?.metadata || {};
  if (!isTruthyMetaFn(metadata.openPR)) return null;
  // The completion branches that hand back a contract which never opens a PR.
  if (isTruthyMetaFn(metadata.noCodeOutput) || metadata.creativeDirector) return null;
  if (isTruthyMetaFn(metadata.discardWorktree)) return null;
  if (isTruthyMetaFn(metadata.readOnly)) return null;
  if (isTruthyMetaFn(metadata.reviewLoopFollowUp)) return null;
  // A PR a human lands gets neither a review loop nor a merge gate.
  const prCompletion = resolvePrCompletion(metadata);
  if (prCompletion === PR_COMPLETIONS.LEAVE_OPEN || leavesPrForHuman(task)) return null;

  return prCompletion === PR_COMPLETIONS.REVIEW_THEN_MERGE ? 'review-loop' : 'merge-gate';
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
  reviewers, usernames, optionalReviewers, reviewerMaxRounds, reviewerModels, reviewerEfforts, reviewStopMode, reviewerApplies, localPhaseReviewers = [], localPhaseCanShortCircuit = false, reviewerPositions = [], forgeCli = 'gh', workflowStep,
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
    reviewLoopReviewers: reviewers,
    reviewLoopReviewerUsernames: usernames,
    reviewLoopOptionalReviewers: optionalReviewers,
    reviewLoopReviewerMaxRounds: reviewerMaxRounds,
    reviewLoopReviewerModels: reviewerModels,
    reviewLoopReviewerEfforts: reviewerEfforts,
    reviewLoopStopMode: reviewStopMode,
    reviewLoopReviewerApplies: reviewerApplies,
    reviewLoopLeaveOpen: leaveOpen,
    // No reviewer configured ⇒ the merge-gate variant (CI is the whole gate),
    // exactly as the merge-only follow-up gets.
    reviewLoopMergeOnly: !runsReviewLoop,
    sourceTaskId: taskId || 'unknown',
  }, { verbose: false, localAgentLoopBody, localAgentLoopBodyPath, inlineExitStep, forgeCli, inlineWorkflowStep: workflowStep, localPhaseReviewers, localPhaseCanShortCircuit, reviewerPositions });
}

/**
 * CLI (non-TUI) completion block.
 *
 * Claude Code CLI agents have slashdo commands available (the submodule
 * mounts them as project-level slash commands), so when `hasSlashdo` is
 * true and a PR is expected, the agent owns the full `/simplify` → `/do:pr`
 * sequence and PortOS skips its post-exit push+PR. Codex/Antigravity and other
 * CLI providers fall through to the legacy commit-only block where PortOS
 * handles push+PR on exit.
 */
export function buildCliCompletionSection({ worktreeInfo, willOpenPR, prCompletion = PR_COMPLETIONS.MERGE_ON_GREEN, hasSlashdo = false, ownsPrWorkflow = false, simplifyEnabled = false, leavePrOpen = false, reviewers = DEFAULT_REVIEWERS, usernames = [], optionalReviewers = [], reviewerMaxRounds = {}, reviewerModels = {}, reviewerEfforts = {}, reviewStopMode = DEFAULT_REVIEW_STOP_MODE, reviewerApplies = false, forgeCli = 'gh', noChangeSuccess = false, localReviewSection = '', localReviewRequired = true, postPrReview = null }) {
  const policyLeavesOpen = prCompletion === PR_COMPLETIONS.LEAVE_OPEN;
  const runsReviewLoop = postPrReview ?? (prCompletion === PR_COMPLETIONS.REVIEW_THEN_MERGE);
  if (hasSlashdo && worktreeInfo && willOpenPR) {
    const lines = ['## Completion', ...(noChangeSuccess ? ['', NO_CHANGE_AUDIT_GUIDANCE, ''] : []), 'When finished, run these in order:'];
    let step = 1;
    if (simplifyEnabled) {
      lines.push(`${step++}. \`/simplify\` — review the changed code for reuse, quality, and efficiency, and fix any findings.`);
    }
    const { reviewUsernames, reviewArgs, effortNote } = resolveReviewInvocation({ willOpenPR, runsReviewLoop, reviewers, usernames, optionalReviewers, reviewerMaxRounds, reviewerModels, reviewerEfforts, reviewStopMode, reviewerApplies });
    // `--no-merge` overrides a saved slashdo `merge: true` default, which would
    // otherwise merge a PR this task must leave open (see lib/prDisposition.js).
    const reviewerArg = (reviewArgs ? ` ${reviewArgs}` : '') + ((leavePrOpen || policyLeavesOpen) ? ' --no-merge' : '');
    const completionNote = runsReviewLoop
      ? ((reviewers.length === 1 && reviewers[0] === DEFAULT_REVIEWER && reviewUsernames.length === 0)
          ? 'and drives the Copilot review loop until clean.'
          : `and drives the review loop for ${[...reviewers, ...reviewUsernames.map(u => `@${u}`)].join(', ')} in order until clean.`)
      : 'with external review disabled.';
    lines.push(`${step++}. \`/do:pr${reviewerArg}\` — commits your changes, pushes the branch, and opens a pull request against the default branch ${completionNote}`);
    // Empty whenever the emitted `--review-with` already carries `~effort=<level>`
    // (see buildReviewerEffortNote) — this speaks only for an unpinned invocation.
    if (effortNote) lines.push(`   ${effortNote}`);
    // Merge steps follow — review-gated with a loop, CI-gated without one — unless
    // this PR is a human's to land (JIRA-tracked; see lib/prDisposition.js).
    if (leavePrOpen || policyLeavesOpen) {
      lines.push(LEAVE_PR_OPEN_STEP(step, leavePrOpen));
    } else {
      const merge = buildPostPRMergeSteps(step, { prCompletion, reviewers, usernames: reviewUsernames, reviewStopMode });
      lines.push(...merge.lines);
    }
    return lines.join('\n');
  }
  if (hasSlashdo && worktreeInfo) {
    const lines = ['## Completion', ...(noChangeSuccess ? ['', NO_CHANGE_AUDIT_GUIDANCE, ''] : []), 'When finished, run these in order:'];
    let step = 1;
    if (simplifyEnabled) {
      lines.push(`${step++}. \`/simplify\` — review the changed code for reuse, quality, and efficiency, and fix any findings.`);
    }
    lines.push(`${step++}. \`/do:push\` — commits your changes and pushes the branch.`);
    return lines.join('\n');
  }
  // Non-slashdo CLI that IS a real coding harness (codex, grok/agy, OpenCode):
  // it can't type `/do:pr`, but it can run `git push` / `gh pr create` and drive
  // the reviewer CLIs — so it owns the same end-to-end lifecycle the TUI manual
  // path does, with the reviewer procedure inlined in the section that follows.
  // `ownsPrWorkflow` already folds in `willOpenPR`, the worktree, and the
  // leave-open exclusions (it is `inlinePrLifecycleSection() !== null`).
  if (ownsPrWorkflow) {
    const lines = ['## Completion', ...(noChangeSuccess ? ['', NO_CHANGE_AUDIT_GUIDANCE, ''] : []), '**You own this PR end to end — nothing else will open, review, or merge it.** When finished, run these in order:'];
    let step = 1;
    lines.push(simplifyEnabled
      ? `${step++}. Before committing, ${SIMPLIFY_INLINE_REVIEW} and fix any findings.`
      : `${step++}. (simplify disabled — skip)`);
    lines.push(`${step++}. Stage only the files you changed (never \`git add -A\` / \`git add .\`) and commit with a conventional message (\`feat:\`/\`fix:\`/\`breaking:\` prefix, no Co-Authored-By annotations).`);
    if (localReviewSection) {
      lines.push(`${step++}. ${localReviewCompletionInstruction(localReviewRequired)}`);
      lines.push('', localReviewSection, '');
    }
    lines.push(...buildManualPrCreateStep(step++, {
      branchName: worktreeInfo?.branchName || null,
      baseBranch: worktreeInfo?.baseBranch || null,
      forgeCli,
      localReviewStateRequired: Boolean(localReviewSection),
    }));
    lines.push(`${step}. Work through the **${runsReviewLoop ? 'Review Loop' : 'Merge Gate'}** section below in full — it ends by merging the PR.`);
    return lines.join('\n');
  }
  let body;
  if (worktreeInfo && willOpenPR) {
    body = 'Commit your changes (stage specific files, `feat:`/`fix:` prefix, no Co-Authored-By). Do NOT push — PortOS will push and open the PR after you exit.';
  } else if (worktreeInfo) {
    body = 'Commit your changes to this branch. PortOS will merge it back when the task completes.';
  } else {
    body = 'Commit and push your changes (`git pull --rebase && git push`, conventional commit prefix, no `git add -A`).';
  }
  // Non-slashdo CLIs (codex/antigravity) have no `/simplify` command; when the task
  // enabled simplify, inline the equivalent self-review so the quality pass still
  // runs before they commit.
  const simplifyLine = simplifyEnabled
    ? `Before committing, ${SIMPLIFY_INLINE_REVIEW} and fix any findings. `
    : '';
  return `## Completion\n${noChangeSuccess ? `${NO_CHANGE_AUDIT_GUIDANCE} ` : ''}${simplifyLine}${body}`;
}
