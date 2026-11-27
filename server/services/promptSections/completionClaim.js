/** Builds issue claim, ownership, and merge handoff instructions. */

import { GITHUB_WORKFLOW_SCOPE } from '../../lib/agent/agentOutcome.js';
import { buildAutoMergeHandoffInstructions } from '../../lib/mergeGateContract.js';
import { resolveClaimReviewerConfig, buildReviewerPinNote } from '../../lib/reviewerConfig.js';
import { shellQuote } from '../../lib/shellQuote.js';
import { LOCAL_REVIEW_LIFECYCLE_SCRIPT, LOCAL_REVIEW_LIFECYCLE_GUIDE } from '../../lib/localReviewBridge.js';
import { PR_COMPLETIONS } from '../../lib/prDisposition.js';
import { localApiBaseUrl } from '../../lib/networkExposure.js';
import { agentApiCurl } from '../../lib/agent/agentApiToken.js';
import { isTruthyMeta } from '../../lib/metadataFlags.js';
import { buildSentinelWriteSteps } from './completionFlows.js';

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
  * @param {boolean} [prStaysOpen] - keep reviews and CI, but hand off before merge (a human lands it, or the policy leaves it open).
  * @param {string|null} [prCompletion] - the claim's PR completion policy
  *   (`PR_COMPLETIONS`): `MERGE_ON_GREEN` suppresses the reviewer pin and emits
  *   the merge-on-green handoff instead; any other value keeps the pin.
  */
/**
 * Relaunch of a claim whose previous run already cut the worktree. Null unless
 * the resume pointer says to stay in that directory.
 */
export function claimResumeContext(task, worktreeInfo = null) {
  const meta = task?.metadata;
  if (!isTruthyMeta(meta?.claimResumeInPlace)) return null;
  const worktreePath = worktreeInfo?.worktreePath || meta.resumeWorktreePath;
  const branchName = worktreeInfo?.branchName || meta.existingBranch;
  const priorAgentId = meta.resumedFromAgentId;
  if (!worktreePath || !branchName || !priorAgentId) return null;
  return { priorAgentId, branchName, worktreePath };
}

/**
 * Overrides the claim prompt's "already in progress / already on this branch →
 * exit" rule for the markers THIS task's previous run left behind.
 */
export function buildClaimResumeOverride({ priorAgentId, branchName, worktreePath } = {}) {
  if (!priorAgentId || !branchName || !worktreePath) return '';
  return [
    '## Relaunch — finish the claim already started',
    `This run continues \`${priorAgentId}\` on the same task. That run already claimed this work and left it in \`${worktreePath}\` on branch \`${branchName}\`.`,
    '',
    'Those markers belong to this task. The `in-progress` label, an assignee that is this account, and the existing branch and worktree are the claim you are finishing. The Target Issue Constraint and Phase 1 rule that say to exit when the issue is already in progress or already checked out on that branch do not apply to them. Finish the work in this worktree.',
    '',
    `Stay in \`${worktreePath}\` on \`${branchName}\`. Skip creating another worktree. Find this claim’s existing PR/MR and continue at the first unfinished phase; do not create a second PR/MR. Inspect failed required-check logs and make a feasible bounded diagnostic or recovery attempt before a hold. Preserve genuine unavailable prerequisites and exhausted budgets as incomplete or blocked. Once current-head required checks and reviews pass, follow the configured merge or human-handoff policy.`,
    '',
    'Stop without taking the work when a different human left a clear active claim comment, or the issue is closed or parked for a human (`needs-input`, `blocked`). A contributor\'s claim is not this relaunch.',
  ].join('\n');
}

/**
 * The run's registered claim branch is only the pinned target (or nothing, for
 * a picker); the branch it actually checks out — an epic's child, a split
 * slice, a picked issue — is bound here before the checkout exists, so
 * branch-reconcile and continuations see a live owner for it (#10089).
 */
function buildClaimOwnershipSection(agentId) {
  if (!agentId) return 'Claim ownership binding requires a registered agent ID. None was supplied, so PortOS treats every claim checkout in this repository as possibly yours until this run ends; do not hand a claim branch to another run while you are live.';
  const command = (action) => agentApiCurl({ apiBase: localApiBaseUrl(), path: '/api/cos/claim-ownership',
    payload: JSON.stringify({ agentId, action, branch: 'BRANCH' }) });
  return [
    '## Claim ownership binding',
    'When an unpinned issue picker stands down on a specific checked issue because it is operator-parked or resolved, record that issue BEFORE reporting no-action-needed, without creating a branch, worktree, assignment or claim markers. That includes an issue this run parked itself with `blocked` or `needs-input`. When every remaining candidate is skipped only because it depends on unshipped work, an unmarked skip never converges, so park each one: add a `Blocked by #N` line naming every open blocker issue (or GitHub PR; GitLab resolves `#N` only as an issue) to its body, apply `blocked` (the blocked-issue reconciler removes it once they all close), then record it. Do not record in-flight or otherwise skipped candidates. Replace 123 with the checked issue number and require parsed JSON with recorded:true:',
    '```bash', agentApiCurl({ apiBase: localApiBaseUrl(), path: '/api/cos/claim-selection',
      payload: JSON.stringify({ agentId, issueNumber: 123 }) }), '```',
    'This records selection only and grants no checkout, merge or cleanup authority. Bound child claims always take precedence over it. A refusal or unreadable response is an unmet completion prerequisite, not permission to fabricate a claim. Pinned issues and runs that already bound a claim keep their existing binding workflow.',
    'Before this run (the parent, never a fan-out child) creates, adopts or checks out ANY claim worktree, bind that exact branch to this run — the pinned issue’s own `claim/…` branch, a tracking epic’s child, a slice split from an oversized issue, each issue a picker or swarm selects, or a claim worktree you are resuming. Replace BRANCH with the branch name and require a parsed JSON response with bound:true:',
    '```bash', command('bind'), '```',
    'Immediately after creating that worktree, repeat the same bind command and require bound:true BEFORE editing or running work there; a refusal means preserve it and report the blocker.',
    'If bind fails or is unreadable, do not create or enter that worktree. Report it. Release a branch the moment its own PR/MR is confirmed MERGED and its checkout and local branch are removed, freeing the name for a later slice:',
    '```bash', command('release'), '```',
    'Keep a merged branch bound if you are leaving its checkout for PortOS to clean up at completion. `checkout-present` is expected and needs no retry. Keep open or unmerged branches bound. Add `"handoff":true` to the release JSON only when another owner is taking over mid-run.',
  ].join('\n');
}

const reviewLifecycleCommand = `node ${shellQuote(LOCAL_REVIEW_LIFECYCLE_SCRIPT)}`;

const reviewTarget = '"$REVIEW_WORKTREE" "$REVIEW_BRANCH"';

const RECORD_OPTIONAL_INCONCLUSIVE = `${reviewLifecycleCommand} write-status ${reviewTarget} optional-inconclusive "$REVIEW_ATTEMPTED_HEAD"`;

const RECORD_REVIEW_HEAD = `${reviewLifecycleCommand} record-head ${reviewTarget} "$REVIEW_ATTEMPTED_HEAD"`;

/**
 * A GitHub participant may hand its pending CI to the server coordinator, which
 * merges only the recorded head through the forge (cosMergeHandoff.js).
 */
function buildPendingMergeHandoffLines(agentId, { review = true } = {}) {
  const command = agentApiCurl({ apiBase: localApiBaseUrl(), path: '/api/cos/merge-handoff',
    payload: JSON.stringify({ agentId, prUrl: 'PR_URL', headSha: 'HEAD_SHA', worktreePath: 'WORKTREE_PATH' }) });
  return [
    '**PortOS pending-merge handoff (GitHub, same-repository PR, only for measured CI backlog):** By default this run owns CI, confirmed merge and safe cleanup. Early finish requires the app setting `mergeHandoffMinQueuedRuns` and a fresh server-observed queued workflow count meeting that threshold; absent settings or unknown backlog keep ownership here. The server coordinator then owns the exact published head, failure recovery, merge confirmation and cleanup across restarts.',
    ...(review ? [
      'Capture REVIEW_ATTEMPTED_HEAD before each review call. When the round returns clean, record that captured head beside REVIEW_STATUS (retain that historical reviewed head after later commits; completed pre-PR local review is scoped to this PR delivery, so feedback/CI pushes do not automatically respawn it):',
      '```bash', RECORD_REVIEW_HEAD, '```',
      'For handoff evidence, before each local review attempt capture `REVIEW_ATTEMPTED_HEAD=$(git rev-parse HEAD)` and retain that exact value across shell calls. When the completed loop has a nonempty all-optional roster and its only non-clean outcomes are availability, quota/provider, timeout, transport, malformed/empty, or no-verdict failures, record the aggregate status below. This handoff-specific record overrides instructions to leave REVIEW_STATUS=clean for optional unavailability; it does not label any reviewer verdict clean. Never use it for pending review, a required reviewer, accepted unresolved findings or rejection, failed validation, or unpushed fixes. Do not overwrite review-blocked. Later PR commits do not require new local review attempts; never replace the attempted head with the later head. Preserve the PR-bound completed lifecycle receipt across restarts. If writing fails, do not hand off:',
      '```bash', RECORD_OPTIONAL_INCONCLUSIVE, '```',
    ] : []),
    `Once the published head (\`git rev-parse HEAD\` equals the PR head) has passed local validation${review ? ' and every configured review is satisfied or explicitly optional-inconclusive' : ''}, and the PR is ready (not draft), request a handoff only if backlog policy is configured${review ? ' — unless review is `review-blocked`, whose stop rule still applies' : ''}. Replace PR_URL, HEAD_SHA (the full 40-character head) and WORKTREE_PATH (this checkout):`,
    '```bash', command, '```',
    'Require a parsed JSON response with queued:true and a receipt whose headSha equals HEAD_SHA. Then the receipt is your merge outcome: do not wait for CI, merge, enable auto-merge, close the issue, release a claim, or remove the branch or worktree; the coordinator merges or dispatches recovery (a moved head, failed check or conflict). Report the PR URL, head and receipt id, say the PR is handed to the PortOS pending-merge coordinator with CI pending and is NOT yet merged, write the completion sentinel if this run uses one, and stop. This overrides later CI waits, MERGED-only completion and cleanup instructions, including delegated slashdo workflows. On queued:false with retryable:true, retry up to 3 times 5 seconds apart. Any other refusal, an HTTP/auth/transport error or unreadable JSON means no handoff: continue owning delivery through the hosting provider under the repository rules below. A refused optional handoff does not create an additional merge requirement and never expands caller or target authorization.',
  ];
}

/** Hosting providers own merge eligibility; local scope and cleanup remain bound. */
/**
 * The app's "Use auto-merge" workflow setting: enable GitHub native auto-merge as
 * soon as review requirements pass, so GitHub lands the PR when CI finishes
 * instead of the agent merging by hand afterwards. The agent still owns CI.
 */
export const AUTO_MERGE_SECTION = [
  '## Use auto-merge',
  'This task uses GitHub native auto-merge to skip the manual merge step after CI. As soon as every configured review requirement has passed for the current PR head (requested reviews done, accepted findings fixed and pushed, PR not a draft; with no review configured, right after the PR is opened), enable auto-merge without waiting for CI: `gh pr merge <PR_URL> --auto --merge --match-head-commit <reviewed-head>` (use `--squash` or `--rebase` when the repository disallows merge commits). GitHub then merges once required checks pass.',
  'Auto-merge enabled is pending, not delivered. Keep watching CI on that head until the PR reports MERGED, then finish cleanup and completion as usual. If a check fails, run `gh pr merge <PR_URL> --disable-auto` before pushing a fix so an unreviewed head cannot merge, fix and push as the CI steps describe, repeat any review the new head requires, then enable auto-merge again for the new head. If GitHub refuses auto-merge (disabled for the repository, or no protected checks), merge normally after CI passes. GitLab, leave-open and draft policies ignore this section.',
].join('\n');

/**
 * Opt-in escalation for a PR blocked only by a required code-owner review. It explicitly supersedes the admission body's
 * "no admin/bypass flags" line, so it is emitted only when the task or app chose it, and each step is gated on green CI
 * for the pinned head so a review requirement is the sole thing it can override.
 */
export function buildCodeOwnerBlockSection({ autoApprove = false, adminMerge = false } = {}) {
  if (!autoApprove && !adminMerge) return '';
  const steps = [];
  const lines = ['## Code-owner review blocking the merge', 'This task opted in to the steps below. They apply only when `gh pr view "<PR_URL>" --json reviewDecision,mergeStateStatus` shows the merge is blocked by a required review (`REVIEW_REQUIRED`), required CI is green on the exact pinned head, the PR is not a draft and there is no conflict. Any other blocker (red or pending check, conflict, missing authorization) is not covered: stop and report it.'];
  if (autoApprove) steps.push('**Auto-approve:** run `gh pr review "<PR_URL>" --approve` with your authenticated account, then re-read `reviewDecision`. GitHub refuses an approval from the PR author and from an account that is not a code owner; if it is refused, do not retry with another identity or credential, and continue to the next step only if it is enabled.');
  if (adminMerge) steps.push(`**Admin merge:** when the review requirement is still the only blocker, merge with \`gh pr merge "<PR_URL>" --admin --merge --match-head-commit <verified-head>\` (same method fallbacks as a normal merge). This overrides the earlier instruction not to use admin/bypass flags for this one case only. Never use it while any required check is failing or pending, never change repository protection settings, and confirm \`MERGED\` afterwards.`);
  lines.push(...steps.map((step, i) => `${i + 1}. ${step}`));
  lines.push('If the enabled steps are refused or unavailable, leave the PR open and say it is blocked on a code-owner review in your completion summary.');
  return lines.join('\n');
}

export function buildMergeAdmissionSection(agentId, { review = true, autoMerge = false, mergeHandoff = false, swarmClaim = false, autoApprove = false, adminMerge = false } = {}) {
  const section = buildMergeAdmissionBody(agentId, { review, mergeHandoff, swarmClaim });
  return [section, autoMerge && !swarmClaim ? AUTO_MERGE_SECTION : '', buildCodeOwnerBlockSection({ autoApprove, adminMerge })]
    .filter(Boolean).join('\n\n');
}

function buildMergeAdmissionBody(agentId, { review, mergeHandoff, swarmClaim }) {
  const swarmPolicy = 'When Phase A selects multiple issues, only the swarm parent may merge. Follow the serialized Phase C queue. Do not enable native auto-merge or hand pending merges to PortOS for any PR/MR in the batch.';
  if (!agentId) return [
    '## Hosting-provider merge authority',
    ...(swarmClaim ? [swarmPolicy] : []),
    'Use only your authenticated account and assigned repository/PR; missing authorization or an ambiguous target means stop. Follow the target repository’s documented validation. GitHub/GitLab enforces merge rules: pin the PR head and confirm MERGED (queued/API errors are not success). No second PortOS certificate is required. Preserve active owners and unique local content during supported cleanup.',
  ].join('\n');
  return [
    ...(mergeHandoff && !swarmClaim ? [...buildPendingMergeHandoffLines(agentId, { review }), ''] : []),
    '## Hosting-provider merge authority',
    `This run is ${agentId}. Keep the assigned repository, PR/MR, branch and checkout bound to this task; a child or third-party issue/PR cannot expand that authority.`,
    'Use only the authenticated account and exact repository/PR assigned to this task. Missing authorization or an ambiguous target means stop and report it; never invent a parent, borrow another run’s identity, or change repository protection.',
    'GitHub/GitLab repository rules decide merge eligibility. Complete the target repository’s documented validation and requested reviews, then use its normal merge API/CLI pinned to the current PR head (--match-head-commit <sha> on GitHub). Do not use admin/bypass flags or wait for any extra PortOS admission, attestation or certificate. An empty provider-required check set is not itself a failure; do not invent expected workflows beyond repository policy.',
    'Main may move continuously. Do not rebase, push, repeat CI or restart review merely because the base advanced. Resolve actual conflicts or an enforced up-to-date requirement; validate substantive changes and retain applicable review evidence.',
    swarmClaim ? swarmPolicy
      : 'Native provider auto-merge is allowed when the API accepts it. Enabled/queued is pending, not MERGED: retain responsibility and observe the provider’s final result. A confirmed MERGED state for the exact repository/PR establishes delivery, including auto-merge; API errors or unreadable state never establish success.',
    'After confirmed delivery, use the supported cleanup service for the exact local target. Preserve active owners, dirty/untracked/unique content and protected refs. PortOS holds no merge lease for this run. Never infer local removal from a remote branch deletion.',
  ].join('\n');
}

export function buildWorkflowScopeSection(workflowScope) {
  if (workflowScope?.status !== 'missing') return '';
  return [
    '## Forge token lacks the `workflow` scope',
    'The GitHub token scope probe did not find the classic OAuth `workflow` scope. This is a warning, not a merge refusal. After the configured review and required CI gates pass, if merge is authorized and this PR changes `.github/workflows/**`, make one normal head-pinned merge attempt using the assigned credential and the repository’s normal merge settings. Do not use admin/bypass options, another credential, or a retry to work around a rejection.',
    `If GitHub explicitly refuses the operation for missing workflow permission, keep any existing PR open and preserve the issue, claim markers and checkout. Write taskOutcome with status "blocked" and recovery {"mode":"approval","code":"${GITHUB_WORKFLOW_SCOPE}","options":["Merge the existing verified PR using already authorized workflow authority","Authorize the assigned GitHub credential for workflow changes before delivery resumes"]}. Name the PR or the held branch if publication was refused, and quote the actual permission error. For a supported CLI OAuth login, the owner can authorize it through GitHub (\`${workflowScope.remedy}\`). Never refresh credentials or retry a denied merge yourself.`,
    'A generic branch-policy or merge conflict error is not proof of missing workflow permission. Report the actual result and follow the existing repository policy. Only a confirmed merge for this exact PR and head allows normal merged-claim cleanup. PRs without workflow changes follow the ordinary delivery path.',
  ].join('\n');
}

export function buildClaimFlowCompletionSection({ isTui = false, sentinelPath = null, reviewersCsv = '', prStaysOpen = false, rawPrCompletion = null, claimResume = null, swarmClaim = false, agentId = null, autoMerge = false, autoApprove = false, adminMerge = false, workflowScope = null, workflowScopeStagedPath = null, mergeHandoff = false, serverCheckout = false } = {}) {
  const isMergeOnGreen = rawPrCompletion === PR_COMPLETIONS.MERGE_ON_GREEN;
  const pin = isMergeOnGreen ? '' : buildReviewerPinNote(reviewersCsv);
  const resumeOverride = buildClaimResumeOverride(claimResume || {});
  const ownershipSection = serverCheckout
    ? '## Claim ownership\nPortOS already bound this run\'s claim branch and retires the checkout after exit; do not call `/api/cos/claim-ownership` or `/api/cos/claim-selection`.'
    : buildClaimOwnershipSection(agentId);
  const workflowScopeSection = !prStaysOpen && workflowScope?.status === 'missing'
    ? (workflowScopeStagedPath
      ? `## Forge token lacks the \`workflow\` scope\nIf your PR touches \`.github/workflows/**\`, READ \`${workflowScopeStagedPath}\` before completing the normal head-pinned merge or a confirmed permission-denial handoff.`
      : buildWorkflowScopeSection(workflowScope))
    : '';
  const lines = [
    ...(resumeOverride ? [resumeOverride, ''] : []),
    ...(pin ? [pin, ''] : []),
    ...(!isMergeOnGreen ? [`**One-time local review lifecycle:** Before Phase 5, follow \`${LOCAL_REVIEW_LIFECYCLE_GUIDE}\`. Use \`${LOCAL_REVIEW_LIFECYCLE_SCRIPT}\` to check/complete/publish the exact PR/MR receipt and write all phase/status state, including review-blocked. Use the bound claim path/branch. This overrides inline writes and resets. Keep each successful reviewer’s outcome and inspection/model evidence on resume. Feedback/CI pushes do not restart review. Required hosted approvals/CI still apply.`, ''] : []),
    ownershipSection, '',
    ...(workflowScopeSection ? [workflowScopeSection, ''] : []),
    ...(!prStaysOpen ? [
      ...(!swarmClaim ? [buildAutoMergeHandoffInstructions('"<PR_URL>"', { review: !isMergeOnGreen, mergeHandoff }), ''] : []),
      buildMergeAdmissionSection(agentId, { review: !isMergeOnGreen, autoMerge, autoApprove, adminMerge, mergeHandoff, swarmClaim }), '',
    ] : []),
    '## Claim Workflow Handoff',
    ...(prStaysOpen ? [
      'PR completion policy: LEAVE OPEN for further human review. This overrides any merge, auto-merge, issue-close, or merged-branch cleanup instruction in the claim prompt and delegated slashdo commands. Do not pass --merge, enable auto-merge, merge the PR/MR, or close the issue/ticket.',
      'Complete implementation, configured reviews, publication, and CI checks as usual. Once those gates pass, leave the PR/MR open, report its URL and review/CI results, and preserve the claim markers, issue state, branch, and worktree for the human handoff. This is a successful completion; do not wait for a human or require MERGED status. Apply this policy to every child claim in a swarm.',
      '',
    ] : isMergeOnGreen ? [
      `PR completion policy: MERGE ON GREEN (no code review). This overrides any code review or reviewer requirement in the claim prompt and delegated slashdo commands. Do not invoke external or local code reviewers. Complete implementation, publication, and CI checks as usual. ${swarmClaim ? 'In a multi-issue swarm, children stop after publication and the parent owns merge, issue closure, and cleanup through Phase C. If Phase A selects one issue, follow the normal single-issue merge flow.' : 'Once CI checks pass, merge the PR/MR, close the issue/ticket, and clean up.'}`,
      '',
    ] : []),
    'This is a self-managed claim flow: the claim prompt above owns its worktree, branch, PR/MR, review, merge or human-handoff, and cleanup. Follow its phase-specific exit conditions; do NOT stop after a code commit or hand the lifecycle back to PortOS.',
    ...(!prStaysOpen ? ['**A merged slice is not the end of the claim.** While the claimed issue still has scope left, start its next slice in this same run and keep going until the issue closes. Report `incomplete` only when something actually stops you (a failure, a limit, an unmet prerequisite), never to leave remaining scope for a later run.'] : []),
    ...(resumeOverride ? ['When the relaunch section above applies, finish this task\'s existing claim in the worktree named there.'] : []),
    '',
    ...(!isMergeOnGreen ? [
      'Required-review publication rule: follow the Phase 5 rule when any required local reviewer cannot return a verdict.',
      '',
    ] : []),
    'For a successful claim, signal completion only after the prompt\'s prescribed PR/MR and cleanup steps are complete. For a clean no-work, blocked, or review-stuck exit, follow the prompt\'s prescribed leave-open/cleanup path first.'
  ];
  if (isTui && sentinelPath) {
    lines.push('', 'When that path is complete, write the completion sentinel and stop:', '', ...buildSentinelWriteSteps(1, sentinelPath, '   ## PR/MR\n   <every PR or MR URL this run shipped, or explain the clean exit>'));
  } else {
    lines.push('', 'After the prompt\'s prescribed final step, exit so PortOS can record the completed claim.');
  }
  return lines.join('\n');
}
