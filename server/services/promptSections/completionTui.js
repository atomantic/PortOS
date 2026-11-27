/** Builds completion instructions for slashdo-capable and manual TUI runs. */

import { DEFAULT_REVIEWER, REVIEW_UNAVAILABLE_REPORTING_NOTE } from '../../lib/reviewerConfig.js';
import { LOCAL_REVIEW_LIFECYCLE_SCRIPT, LOCAL_REVIEW_LIFECYCLE_GUIDE } from '../../lib/localReviewBridge.js';
import { COMPLETION_MODES } from '../../lib/agent/agentCompletionMode.js';
import { PR_COMPLETIONS } from '../../lib/prDisposition.js';
import { SIMPLIFY_INLINE_REVIEW } from './constants.js';
import { LEAVE_PR_OPEN_STEP } from './reviewLifecycle.js';
import { NO_CHANGE_AUDIT_GUIDANCE, buildSentinelWriteSteps } from './completionFlows.js';
import {
  COMMIT_HYGIENE_SENTENCE,
  buildAutoMergeCommitStep,
  buildPostPRMergeSteps,
  resolveReviewInvocation,
  localReviewCompletionInstruction,
  buildManualPrCreateStep,
} from './completionPullRequest.js';

/**
 * TUI completion-workflow block. The TUI owns its own commit → push → PR
 * pipeline via slashdo commands and signals "done" with a sentinel file.
 *
 * When `mode` is `COMPLETION_MODES.TUI_SLASHDO_FREE` — any TUI that does NOT
 * load Claude Code slash commands: OpenCode, codex/antigravity/grok/kimi, or a
 * lean `--bare` Claude session — the agent can't run `/do:pr` / `/do:push`, so
 * it delegates to the plain-git/`gh` variant below (same sentinel handshake,
 * no slashdo). The caller resolves that mode once via `resolveCompletionMode`,
 * itself derived from `canTypeSlashCommands` (#3114); past the early return
 * this IS a Claude session, so `/simplify` and `/do:pr` are both safe to emit
 * without a second provider check.
 */
export function buildTuiCompletionSection({ willOpenPR, prCompletion = PR_COMPLETIONS.MERGE_ON_GREEN, simplifyEnabled, sentinelPath, mode = COMPLETION_MODES.TUI, rendersInlinePrLifecycle = false, portosMergesBranch = false, branchName = null, baseBranch = null, humanLandsPr = false, reviewPolicy, forgeCli = 'gh', noChangeSuccess = false, localReviewSection = '', localReviewRequired = true, postPrReview = null, mergeAdmission = false, mergeHandoff = false }) {
  const policyLeavesOpen = prCompletion === PR_COMPLETIONS.LEAVE_OPEN;
  const runsReviewLoop = prCompletion === PR_COMPLETIONS.REVIEW_THEN_MERGE;
  const prStaysOpen = humanLandsPr || policyLeavesOpen;
  if (mode === COMPLETION_MODES.TUI_SLASHDO_FREE) {
    // Plain `git`/`gh` instead of `/do:pr` — but still the whole lifecycle when
    // the session is a real coding harness (`rendersInlinePrLifecycle`); the reviewer
    // procedure it needs is inlined in the Review Loop section that follows.
    return buildManualTuiCompletionSection({ willOpenPR, prCompletion, simplifyEnabled, sentinelPath, branchName, baseBranch, humanLandsPr, rendersInlinePrLifecycle, forgeCli, noChangeSuccess, localReviewSection, localReviewRequired, postPrReview });
  }
  const cmd = willOpenPR ? '/do:pr' : '/do:push';
  // `/do:pr` may inherit a saved `review-with` default. Explicitly opt out
  // when the task's Review Loop control is off so that default cannot start a
  // Copilot (or other external) review unexpectedly.
  const { reviewUsernames, reviewArgs, effortNote } = resolveReviewInvocation({ willOpenPR, runsReviewLoop, reviewPolicy });
  const { reviewers } = reviewPolicy;
  // A saved slashdo `merge: true` default would otherwise merge a PR that must
  // stay open — dropping our own merge steps isn't enough, `/do:pr` has to be
  // told not to merge (see lib/prDisposition.js). Under merge admission the
  // gate below merges inside the lease, so `/do:pr` must not merge first.
  const mergeArg = (willOpenPR && (prStaysOpen || mergeAdmission)) ? ' --no-merge' : '';
  const reviewerArg = (reviewArgs ? ` ${reviewArgs}` : '') + mergeArg;
  const copilotOnly = reviewers.length === 1 && reviewers[0] === DEFAULT_REVIEWER && reviewUsernames.length === 0;
  const reviewerListLabel = [...reviewers, ...reviewUsernames.map(u => `@${u}`)].join(', ');
  const requiredLocalReviewBlockedNote = willOpenPR && runsReviewLoop && localReviewRequired
    ? ` If a required local reviewer cannot return a verdict because of a quota/provider or transport failure, timeout, malformed/empty response, or no-verdict result, treat the local phase as \`review-blocked\`: \`/do:pr\` must still open the PR and skip its merge. ${REVIEW_UNAVAILABLE_REPORTING_NOTE}`
    : '';
  // Ordering matters to the agent: `/do:pr` partitions the list and runs every
  // local reviewer BEFORE it creates the PR, so the PR opens against an
  // already-review-clean branch and only the cloud-side reviewers (Copilot,
  // `@login`) plus CI remain. Saying "after the PR opens" of the whole list had
  // agents expecting — and sometimes hand-rolling — a post-PR local pass.
  const reviewSuffix = willOpenPR && runsReviewLoop
    ? (copilotOnly
        ? ` — \`/do:pr\` runs the Copilot review loop after the PR opens.${requiredLocalReviewBlockedNote}`
        : ` — \`/do:pr\` runs the review loop for ${reviewerListLabel} in order: local reviewers before it opens the PR, then the PR-side reviewers (Copilot / \`@login\`) once it is open.${requiredLocalReviewBlockedNote}`)
    : (willOpenPR ? ' — external review is disabled for this task.' : '');
  // Reached only for a Claude TUI (a non-Claude one took the TUI_SLASHDO_FREE
  // branch above), so `/simplify` — a Claude Code built-in — is invokable here.
  const simplifyStep = simplifyEnabled ? '1. `/simplify`' : '1. (simplify disabled — skip)';
  const sentinelTail = willOpenPR
    ? (noChangeSuccess
        ? '   ## PR\n   <PR URL, or "No change needed; no PR opened." if the audit made no change>'
        : '   ## PR\n   <PR URL>')
    : '   ## Branch\n   <branch name>';
  // A PR gets merge steps — gated on the review verdict when a loop runs, on CI
  // alone when it doesn't (nothing else merges a no-review-loop PR). The one
  // exception is a PR a human lands (JIRA-tracked; see lib/prDisposition.js).
  const merge = (willOpenPR && !prStaysOpen)
    ? buildPostPRMergeSteps(3, { prCompletion, reviewPolicy, forgeCli, mergeAdmission, mergeHandoff })
    : { lines: prStaysOpen && willOpenPR ? [LEAVE_PR_OPEN_STEP(3, humanLandsPr)] : [], nextStep: prStaysOpen && willOpenPR ? 4 : 3 };
  const sentinelStep = merge.nextStep;

  return [
    '## Completion Workflow',
    ...(noChangeSuccess ? ['', NO_CHANGE_AUDIT_GUIDANCE, ''] : []),
    'When the task is complete, run these in order:',
    '',
    simplifyStep,
    // No command under the auto-merge posture: PortOS lands the branch itself,
    // so step 2 is a plain commit and any push is debris (portosMergesBranchOnExit).
    portosMergesBranch
      ? `2. ${buildAutoMergeCommitStep(baseBranch)}`
      : `2. \`${cmd}${reviewerArg}\`${reviewSuffix}`,
    ...(effortNote ? [`   ${effortNote}`] : []),
    ...(willOpenPR && runsReviewLoop && !copilotOnly ? [`   Before any local reviewer, read \`${LOCAL_REVIEW_LIFECYCLE_GUIDE}\` and use \`${LOCAL_REVIEW_LIFECYCLE_SCRIPT}\` to check/complete/publish the PR-bound receipt. This lifecycle rule overrides delegated pre-PR resets: later feedback/CI pushes do not repeat successful local review. Preserve original model/head receipts and current-head hosted gates.`] : []),
    ...merge.lines,
    ...buildSentinelWriteSteps(sentinelStep, sentinelPath, sentinelTail)
  ].join('\n');
}

/**
 * Manual (slashdo-free) completion-workflow block — every provider that can't
 * type `/do:pr` (codex, grok/agy, OpenCode, a lean `--bare` Claude session).
 *
 * When `rendersInlinePrLifecycle` is set the agent drives the WHOLE lifecycle in
 * one session: commit → push → open the PR → run the inline review loop →
 * merge. That is the point of the flag — see `promptOpensOwnPr`, whose
 * `agent-inline` answer this is. Not typing a slash command never meant "can't
 * run `gh`", but this block used to conclude exactly that, so every
 * agy/grok/codex task ended in a commit and PortOS bought a second cold agent
 * (`sys-rl-*`) just to review and land the PR.
 *
 * `rendersInlinePrLifecycle: false` (lean mode) keeps the original handoff:
 * commit and stop, PortOS owns the post-exit push / PR / review / merge
 * lifecycle.
 */
function buildManualTuiCompletionSection({ willOpenPR, prCompletion = PR_COMPLETIONS.REVIEW_THEN_MERGE, simplifyEnabled, sentinelPath, branchName = null, baseBranch = null, humanLandsPr = false, rendersInlinePrLifecycle = false, forgeCli = 'gh', noChangeSuccess = false, localReviewSection = '', localReviewRequired = true, postPrReview = null }) {
  const policyLeavesOpen = prCompletion === PR_COMPLETIONS.LEAVE_OPEN;
  const runsReviewLoop = postPrReview ?? (prCompletion === PR_COMPLETIONS.REVIEW_THEN_MERGE);
  // `rendersInlinePrLifecycle` already folds in `willOpenPR`, the worktree, and
  // the leave-open exclusions — it is `inlinePrLifecycleSection() !== null` (see
  // the caller). Re-testing any of them here is how the two drifted apart before.
  const simplifyStep = simplifyEnabled
    ? `1. Before committing, ${SIMPLIFY_INLINE_REVIEW} and fix any findings.`
    : '1. (simplify disabled — skip)';
  const sentinelTail = rendersInlinePrLifecycle
    ? (noChangeSuccess
        ? '   ## PR\n   <PR URL, or "No change needed; no PR opened." if the audit made no change>'
        : '   ## PR\n   <PR URL>')
    : '   ## Branch\n   <branch name>';

  const lines = [
    '## Completion Workflow',
    ...(noChangeSuccess ? ['', NO_CHANGE_AUDIT_GUIDANCE, ''] : []),
    rendersInlinePrLifecycle
      ? `This provider does NOT have slashdo (\`/do:*\`) commands, so drive the handoff with plain \`git\` and \`${forgeCli}\`. **You own this ${forgeCli === 'glab' ? 'MR' : 'PR'} end to end — nothing else will open, review, or merge it.** Run these in order:`
      : 'This provider does NOT have slashdo (`/do:*`) commands, so finish the handoff with plain `git`. Run these in order:',
    '',
    simplifyStep,
    `2. ${COMMIT_HYGIENE_SENTENCE}:`,
    '',
    '   ```bash',
    '   git add <file> [<file> ...]',
    '   git commit -m "feat: <description>"',
    '   ```',
  ];

  let step = 3;
  if (rendersInlinePrLifecycle) {
    if (localReviewSection) {
      lines.push(`${step++}. ${localReviewCompletionInstruction(localReviewRequired)}`);
      lines.push('', localReviewSection, '');
    }
    lines.push(...buildManualPrCreateStep(step++, { branchName, baseBranch, forgeCli, localReviewStateRequired: Boolean(localReviewSection), localReviewRequired }));
    lines.push(`${step++}. Work through the **${runsReviewLoop ? 'Review Loop' : 'Merge Gate'}** section below in full — it merges the PR when eligible, but a review-blocked required review leaves it open. Come back here when it is done.`);
  } else if (willOpenPR) {
    const handoff = policyLeavesOpen
      ? 'PortOS will push the branch, create a pull request with your completion summary as its description, and leave it open for inspection.'
      : humanLandsPr
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
