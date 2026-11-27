/** Builds completion instructions for CLI runs. */

import { DEFAULT_REVIEWER, REVIEW_UNAVAILABLE_REPORTING_NOTE } from '../../lib/reviewerConfig.js';
import { COMPLETION_MODES } from '../../lib/agent/agentCompletionMode.js';
import { PR_COMPLETIONS } from '../../lib/prDisposition.js';
import { SIMPLIFY_INLINE_REVIEW } from './constants.js';
import { LEAVE_PR_OPEN_STEP } from './reviewLifecycle.js';
import { NO_CHANGE_AUDIT_GUIDANCE } from './completionFlows.js';
import {
  COMMIT_HYGIENE_SENTENCE,
  buildAutoMergeCommitStep,
  buildPostPRMergeSteps,
  resolveReviewInvocation,
  localReviewCompletionInstruction,
  buildManualPrCreateStep,
} from './completionPullRequest.js';

/**
 * CLI (non-TUI) completion block.
 *
 * Claude Code CLI agents have slashdo commands available (the submodule
 * mounts them as project-level slash commands), so when `mode` is
 * `COMPLETION_MODES.WORKTREE_NO_PUSH` and `canTypeSlashCommands` is true, the
 * agent owns the full `/simplify` → `/do:pr` sequence and PortOS skips its
 * post-exit push+PR. Codex/Antigravity and other CLI providers fall through
 * to the legacy commit-only block where PortOS handles push+PR on exit.
 *
 * Branches on `mode` first, mirroring the resolver's own rule order
 * (`lib/agent/agentCompletionMode.js`) rather than re-testing `worktreeInfo` /
 * `willOpenPR` — the caller already resolved those into `mode`.
 */
export function buildCliCompletionSection({ worktreeInfo, willOpenPR, prCompletion = PR_COMPLETIONS.MERGE_ON_GREEN, mode = null, canTypeSlashCommands = false, rendersInlinePrLifecycle = false, simplifyEnabled = false, humanLandsPr = false, reviewPolicy, forgeCli = 'gh', noChangeSuccess = false, localReviewSection = '', localReviewRequired = true, postPrReview = null, mergeAdmission = false, mergeHandoff = false }) {
  const policyLeavesOpen = prCompletion === PR_COMPLETIONS.LEAVE_OPEN;
  const runsReviewLoop = postPrReview ?? (prCompletion === PR_COMPLETIONS.REVIEW_THEN_MERGE);
  const prStaysOpen = humanLandsPr || policyLeavesOpen;
  if (canTypeSlashCommands && mode === COMPLETION_MODES.WORKTREE_NO_PUSH) {
    const lines = ['## Completion', ...(noChangeSuccess ? ['', NO_CHANGE_AUDIT_GUIDANCE, ''] : []), 'When finished, run these in order:'];
    let step = 1;
    if (simplifyEnabled) {
      lines.push(`${step++}. \`/simplify\` — review the changed code for reuse, quality, and efficiency, and fix any findings.`);
    }
    const { reviewUsernames, reviewArgs, effortNote } = resolveReviewInvocation({ willOpenPR, runsReviewLoop, reviewPolicy });
    const { reviewers } = reviewPolicy;
    // `--no-merge` overrides a saved slashdo `merge: true` default, which would
    // otherwise merge a PR this task must leave open (see lib/prDisposition.js)
    // or merge outside the admission lease the merge steps below acquire.
    const reviewerArg = (reviewArgs ? ` ${reviewArgs}` : '') + ((prStaysOpen || mergeAdmission) ? ' --no-merge' : '');
    const completionNote = runsReviewLoop
      ? ((reviewers.length === 1 && reviewers[0] === DEFAULT_REVIEWER && reviewUsernames.length === 0)
          ? 'and drives the Copilot review loop until clean.'
          : `and drives the review loop for ${[...reviewers, ...reviewUsernames.map(u => `@${u}`)].join(', ')} in order until clean.`)
      : 'with external review disabled.';
    const requiredLocalReviewBlockedNote = willOpenPR && runsReviewLoop && localReviewRequired
      ? ` A required local reviewer that cannot return a verdict is \`review-blocked\`: still open the PR and do not merge it. ${REVIEW_UNAVAILABLE_REPORTING_NOTE}`
      : '';
    lines.push(`${step++}. \`/do:pr${reviewerArg}\` — commits your changes, pushes the branch, and opens a pull request against the default branch ${completionNote}`);
    if (requiredLocalReviewBlockedNote) lines.push(`   ${requiredLocalReviewBlockedNote.trim()}`);
    // Empty whenever the emitted `--review-with` already carries `~effort=<level>`
    // (see buildReviewerEffortNote) — this speaks only for an unpinned invocation.
    if (effortNote) lines.push(`   ${effortNote}`);
    // Merge steps follow — review-gated with a loop, CI-gated without one — unless
    // this PR is a human's to land (JIRA-tracked; see lib/prDisposition.js).
    if (prStaysOpen) {
      lines.push(LEAVE_PR_OPEN_STEP(step, humanLandsPr));
    } else {
      const merge = buildPostPRMergeSteps(step, { prCompletion, reviewPolicy, forgeCli, mergeAdmission, mergeHandoff });
      lines.push(...merge.lines);
    }
    return lines.join('\n');
  }
  if (canTypeSlashCommands && mode === COMPLETION_MODES.PORTOS_MERGES) {
    const lines = ['## Completion', ...(noChangeSuccess ? ['', NO_CHANGE_AUDIT_GUIDANCE, ''] : []), 'When finished, run these in order:'];
    let step = 1;
    if (simplifyEnabled) {
      lines.push(`${step++}. \`/simplify\` — review the changed code for reuse, quality, and efficiency, and fix any findings.`);
    }
    // Slashdo + worktree + no PR (the PR case returned above) is the auto-merge
    // posture: PortOS lands the branch itself, so the step is a plain commit —
    // `/do:push` here only left a copy behind on origin (portosMergesBranchOnExit).
    lines.push(`${step++}. ${buildAutoMergeCommitStep(worktreeInfo.baseBranch || null)}`);
    return lines.join('\n');
  }
  // Non-slashdo CLI that IS a real coding harness (codex, grok/agy, OpenCode):
  // it can't type `/do:pr`, but it can run `git push` / `gh pr create` and drive
  // the reviewer CLIs — so it owns the same end-to-end lifecycle the TUI manual
  // path does, with the reviewer procedure inlined in the section that follows.
  // `rendersInlinePrLifecycle` already folds in `willOpenPR`, the worktree, and the
  // leave-open exclusions (it is `inlinePrLifecycleSection() !== null`).
  if (rendersInlinePrLifecycle) {
    const lines = ['## Completion', ...(noChangeSuccess ? ['', NO_CHANGE_AUDIT_GUIDANCE, ''] : []), '**You own this PR end to end — nothing else will open, review, or merge it.** When finished, run these in order:'];
    let step = 1;
    lines.push(simplifyEnabled
      ? `${step++}. Before committing, ${SIMPLIFY_INLINE_REVIEW} and fix any findings.`
      : `${step++}. (simplify disabled — skip)`);
    lines.push(`${step++}. ${COMMIT_HYGIENE_SENTENCE}.`);
    if (localReviewSection) {
      lines.push(`${step++}. ${localReviewCompletionInstruction(localReviewRequired)}`);
      lines.push('', localReviewSection, '');
    }
    lines.push(...buildManualPrCreateStep(step++, {
      branchName: worktreeInfo?.branchName || null,
      baseBranch: worktreeInfo?.baseBranch || null,
      forgeCli,
      localReviewStateRequired: Boolean(localReviewSection),
      localReviewRequired,
    }));
    lines.push(`${step}. Work through the **${runsReviewLoop ? 'Review Loop' : 'Merge Gate'}** section below in full — it merges the PR when eligible, but a review-blocked required review leaves it open.`);
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
