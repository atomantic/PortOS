/** Assemble the combined or split light-context prompt for CLI and TUI agents. */

import { isTruthyMeta } from '../../lib/metadataFlags.js';
import { isToolFreeReviewer, isCliReviewer, hasRequiredReviewer, resolveReviewPolicy } from '../../lib/reviewerConfig.js';
import { PROVIDER_TYPES } from '../../lib/aiToolkit/constants.js';
import { canTypeSlashCommands, PR_OPENED_BY } from '../../lib/slashdoInvocation.js';
import { leavesPrForHuman, prStaysOpen } from '../../lib/prDisposition.js';
import { repositoryCleanupMergeTarget } from '../../lib/recoveryMergeTarget.js';
import { resolveTaskHookType } from '../taskTypeHooks.js';
import { reconcileSplitContext } from '../promptSections/taskContext.js';
import { manualForgeCli } from '../promptSections/forge.js';
import { COMPLETION_MODES, resolveCompletionMode } from '../../lib/agent/agentCompletionMode.js';
import {
  buildActionOutputCompletionSection, buildExternalRepositoryCompletionSection,
  buildAuditOutputCompletionSection, buildClaimFlowCompletionSection, buildMergeAdmissionSection,
  claimResumeContext, buildReleaseFlowCompletionSection, buildReconcileFlowCompletionSection,
  buildCheckoutRecoveryCompletionSection, buildAuditFlowCompletionSection, buildCliCompletionSection,
  buildInlineReviewLoopSection, buildProgrammaticOutputCompletionSection, buildReadOnlyCompletionSection,
  buildToolFreeReasoningCompletionSection, buildResumeSection, buildSentinelWriteSteps,
  buildTuiCompletionSection, claimReviewersCsv, inlinePrLifecycleSection, promptOpensOwnPr,
  worktreeCommitGuidance,
} from '../promptSections/completion.js';
import { buildLocalReviewLoopSection, buildReviewLoopFollowUpSection } from '../promptSections/reviewLifecycle.js';
import {
  resolveSentinelPath, pipelineContextLines, mergeAdmissionOptions,
  usesSwarmClaim, mergeHandoffEnabled, resolveTaskMetadataFlags, reviewLoopPromptMetadata,
  worktreeBranchSuffix, buildLightBriefingSections,
} from './agentPromptSections.js';

// Completion modes whose generic section can hand the agent its own PR's merge.
const AGENT_PR_DELIVERY_MODES = new Set([COMPLETION_MODES.TUI, COMPLETION_MODES.TUI_SLASHDO_FREE, COMPLETION_MODES.WORKTREE_NO_PUSH]);

/**
 * Build the **light-context** prompt for agents that have native filesystem
 * tools and agent-instruction loading (Claude Code, Codex, Antigravity — `tui` or `cli`).
 *
 * Includes the task, attached context, eligible Memory and Digital Twin
 * references, and workflow details the agent cannot infer from the checkout
 * (such as the completion-sentinel protocol). Repository instructions, tools
 * summaries, planning snippets, skill templates and compaction warnings stay
 * out of this prompt.
 *
 * Falls back gracefully when worktree/jira/pipeline metadata is absent — only
 * the present sections render.
 */
export function buildLightContextPrompt(task, workspaceDir, worktreeInfo, options = {}) {
  const { taskSections, contractSections } = buildLightContextSections(task, workspaceDir, worktreeInfo, options);
  return [...taskSections, ...contractSections, BEGIN_WORKING_LINE].join('\n\n') + '\n';
}

/**
 * Split variant of `buildLightContextPrompt` for providers with a real system
 * channel (Claude Code's `--append-system-prompt-file`): the task-specific
 * content (including Memory and Digital Twin references) becomes the user
 * prompt, and the PortOS operating contract (worktree/pipeline/JIRA
 * coordinates + completion workflow) rides in the system prompt where models
 * weight it as instructions rather than conversation. Section content is
 * byte-identical to the combined prompt — only the placement differs.
 *
 * @returns {{ userPrompt: string, systemPrompt: string|null }}
 */
export function buildLightContextPromptParts(task, workspaceDir, worktreeInfo, options = {}) {
  const { taskSections, contractSections } = buildLightContextSections(task, workspaceDir, worktreeInfo, options);
  return {
    userPrompt: [...taskSections, BEGIN_WORKING_LINE].join('\n\n') + '\n',
    systemPrompt: contractSections.length ? contractSections.join('\n\n') + '\n' : null,
  };
}

const BEGIN_WORKING_LINE = 'Begin working on the task now.';

function buildLightContextSections(task, workspaceDir, worktreeInfo, {
  isTui = true, providerId = null, providerCommand = null, providerModel = null, leanMode = false, agentId = null,
  defaultReviewers, codeReviewDefaults, localAgentLoopBody = null, localAgentLoopBodyPath = null,
  forgeCli = null, promptTrace = null, workflowScopeStagedPath = null, memorySection = null, digitalTwinSection = null,
} = {}) {
  // Idempotent with the reconcile in buildAgentPrompt; also protects the
  // directly-exported buildLightContextPrompt/Parts entry points.
  task = reconcileSplitContext(task);
  const {
    willOpenPR, claimFlow, portosMergesBranch, prCompletion, simplifyEnabled, isReadOnly,
    discardWorktree, noCodeOutput, externalRepositoryOutput, toolFreeReasoning, sentinelPayloadOutput, noChangeSuccess,
    isReviewLoopFollowUp, isWorktreeOnExistingBranch,
  } = resolveTaskMetadataFlags(task, worktreeInfo);
  // Ordered reviewer list + flags for the Review Loop (task metadata wins; else
  // the install's configured Code Review Defaults threaded from buildAgentPrompt;
  // else `[]`). Flows as `/do:pr --review-with a,b,c [--review-stop-on-*]
  // [--reviewer-applies]`. All five fields fall back to the defaults with
  // task-over-default precedence (see the matching block in buildAgentPrompt and
  // resolveReviewLoopOptions) — not just the reviewer list.
  // Inline PR/MR lifecycles and review-loop follow-ups cross the public-forge
  // boundary; `reviewerApplies` survives only for non-public local review work.
  const reviewPolicy = resolveReviewPolicy(task.metadata, codeReviewDefaults, defaultReviewers, { crossesPublicForge: willOpenPR || isReviewLoopFollowUp });
  const resolvedForgeCli = manualForgeCli(forgeCli, worktreeInfo);
  // Can this session TYPE a Claude Code slash command (`/do:pr`, `/do:push`,
  // `/simplify`)? One predicate, both prompt paths (#3114): `canTypeSlashCommands`
  // derives from `resolveSlashdoStyle` with the spawners' blank-command posture,
  // replacing three inline provider-id allowlists that had already drifted apart
  // (a codex TUI used to be told to run `/do:pr`, which it cannot; a
  // path-configured `claude` binary under a custom provider id used to be denied
  // the slashdo workflow).
  const canTypeSlash = canTypeSlashCommands({ providerId, providerCommand, leanMode });
  // THE completion decision, made once. Every section below renders this key
  // (`mode`) plus the `canTypeSlash` capability flag; no section re-derives a
  // per-shape boolean of its own. See lib/agent/agentCompletionMode.js for the rule
  // order — this is the branch that matters in production, since every
  // `tui`/`cli` provider returns from the light path and never reaches the
  // full one, so a fix applied only there is no fix at all for anything a
  // subscription-quota job can run.
  const completionMode = resolveCompletionMode({
    taskHookType: resolveTaskHookType(task),
    toolFreeReasoning, sentinelPayloadOutput, noCodeOutput, externalRepositoryOutput, discardWorktree, claimFlow,
    isReadOnly, isReviewLoopFollowUp, isTui, canRunSlashCommands: canTypeSlash,
    portosMergesBranch, worktreeInfo, willOpenPR, slashdoCommand: task.metadata?.slashdoCommand,
  });
  // Does this session drive commit → push → PR → review → merge itself?
  //
  // ONE value answers both "emit the manual PR steps" and "emit the Review Loop
  // / Merge Gate section they point at", because they are the same decision:
  // the agent opens its own PR exactly when it also lands it. Splitting them let
  // a JIRA run be told to open a PR whose merge section was suppressed — and
  // PortOS opened that PR too. `inlineSection` also names WHICH section follows,
  // so the completion step's cross-reference can't name the wrong one.
  const inlineSection = claimFlow || [COMPLETION_MODES.RELEASE_FLOW, COMPLETION_MODES.AUDIT_FLOW, COMPLETION_MODES.RECONCILE_FLOW, COMPLETION_MODES.CHECKOUT_RECOVERY].includes(completionMode) ? null : inlinePrLifecycleSection(task, {
    providerType: isTui ? PROVIDER_TYPES.TUI : PROVIDER_TYPES.CLI,
    providerId, providerCommand, leanMode, worktreeInfo,
  });
  const rendersInlinePrLifecycle = inlineSection !== null;
  // A generic worktree run whose section below tells it to open AND merge its
  // own PR (`/do:pr` plus the CI merge gate, or the inline lifecycle). It
  // merges inside repository merge admission (#11435), and the spawner stamps
  // the matching ownership binding from this same decision via `promptTrace`.
  const mergesOwnPr = AGENT_PR_DELIVERY_MODES.has(completionMode) && promptOpensOwnPr(task, {
    providerType: isTui ? PROVIDER_TYPES.TUI : PROVIDER_TYPES.CLI,
    providerId, providerCommand, leanMode, worktreeInfo,
  }) !== PR_OPENED_BY.PORTOS;
  if (promptTrace) promptTrace.mergesOwnPr = mergesOwnPr;
  // Slashdo already partitions reviewers. Plain-git completion prompts need the
  // same split spelled out: local CLIs/local LLMs inspect the committed branch
  // before it is public; Copilot and @login reviewers can only run after a PR.
  const isLocalReviewer = reviewer => isCliReviewer(reviewer) || isToolFreeReviewer(reviewer);
  const localReviewers = reviewPolicy.reviewers.filter(isLocalReviewer);
  const localReviewRequired = hasRequiredReviewer(localReviewers, reviewPolicy.optionalReviewers);
  const reviewerPositions = [
    ...reviewPolicy.reviewers.map((reviewer, position) => ({ reviewer, position })),
    ...reviewPolicy.forgeReviewerUsernames.map((username, index) => ({ reviewer: `@${username}`, position: reviewPolicy.reviewers.length + index })),
  ];
  const localReviewSection = inlineSection === 'review-loop'
    ? buildLocalReviewLoopSection({
      taskId: task.id,
      branchName: worktreeInfo?.branchName || null,
      baseBranch: worktreeInfo?.baseBranch || null,
      localAgentLoopBody,
      localAgentLoopBodyPath,
      reviewPolicy,
      reviewerPositions,
    })
    : '';
  // The post-PR section renders only the reviewers that need an open PR (the
  // local ones already ran pre-PR); every other knob is the shared policy's.
  const prSideReviewers = reviewPolicy.reviewers.filter(reviewer => !isLocalReviewer(reviewer));
  const prSidePolicy = Object.freeze({ ...reviewPolicy, reviewers: prSideReviewers });
  const runsPrSideReviewLoop = inlineSection === 'review-loop'
    && (prSideReviewers.length > 0 || reviewPolicy.forgeReviewerUsernames.length > 0);
  const localPhaseCanShortCircuit = localReviewSection !== ''
    && runsPrSideReviewLoop;

  const { taskSections, contractSections } = buildLightBriefingSections({
    task, worktreeInfo, agentId, providerId, providerCommand, providerModel, resolvedForgeCli, memorySection, digitalTwinSection,
  });

  // --- Worktree / pipeline / JIRA context --------------------------------
  contractSections.push(...buildLightTaskContextSections({
    task, worktreeInfo, isWorktreeOnExistingBranch, isTui, mode: completionMode, canTypeSlashCommands: canTypeSlash, rendersInlinePrLifecycle,
    willOpenPR, discardWorktree, claimFlow, noChangeSuccess,
  }));

  // --- Completion / review-loop ------------------------------------------
  const lightSentinelPath = () => resolveSentinelPath(worktreeInfo, workspaceDir, agentId);
  // Both TUI modes render the same section — `buildTuiCompletionSection` takes
  // `mode` and adapts the workflow itself. Likewise the three commit/push
  // modes: `buildCliCompletionSection` already reads `worktreeInfo`/`willOpenPR`.
  const pushTuiCompletion = () => contractSections.push(buildTuiCompletionSection({
    willOpenPR, prCompletion, simplifyEnabled, noChangeSuccess, mode: completionMode, rendersInlinePrLifecycle, portosMergesBranch,
    sentinelPath: lightSentinelPath(),
    branchName: worktreeInfo?.branchName || null,
    baseBranch: worktreeInfo?.baseBranch || null,
    humanLandsPr: leavesPrForHuman(task),
    reviewPolicy,
    forgeCli: resolvedForgeCli, localReviewSection, localReviewRequired, postPrReview: rendersInlinePrLifecycle ? runsPrSideReviewLoop : null,
    mergeAdmission: mergesOwnPr,
    mergeHandoff: mergeHandoffEnabled(task),
  }));
  const pushCliCompletion = () => contractSections.push(buildCliCompletionSection({ worktreeInfo, willOpenPR, prCompletion, mode: completionMode, canTypeSlashCommands: canTypeSlash, rendersInlinePrLifecycle, simplifyEnabled, noChangeSuccess, humanLandsPr: leavesPrForHuman(task), reviewPolicy, forgeCli: resolvedForgeCli, localReviewSection, localReviewRequired, postPrReview: rendersInlinePrLifecycle ? runsPrSideReviewLoop : null, mergeAdmission: mergesOwnPr, mergeHandoff: mergeHandoffEnabled(task) }));
  // Ahead of the completion workflow, whose TUI form ends on the sentinel write.
  // A repository-cleanup recovery lands its parent PR under the same lease (#12251).
  if (mergesOwnPr || repositoryCleanupMergeTarget(task)) contractSections.push(buildMergeAdmissionSection(agentId, mergeAdmissionOptions(task)));

  ({
    [COMPLETION_MODES.TOOL_FREE]: () => contractSections.push(buildToolFreeReasoningCompletionSection()),
    // A sandboxed review stage sets `noCodeOutput` too, but its deliverable is
    // the sentinel payload, not an API action.
    [COMPLETION_MODES.SENTINEL_PAYLOAD]: () => contractSections.push(buildProgrammaticOutputCompletionSection(lightSentinelPath())),
    [COMPLETION_MODES.ACTION_OUTPUT]: () => contractSections.push(buildActionOutputCompletionSection({ isTui, sentinelPath: lightSentinelPath() })),
    [COMPLETION_MODES.EXTERNAL_REPOSITORY]: () => contractSections.push(buildExternalRepositoryCompletionSection({ isTui, sentinelPath: lightSentinelPath() })),
    // Reasoning-only task: the sentinel payload (shape set by the task-type
    // output hook) is the sole output; the worktree is discarded on exit.
    [COMPLETION_MODES.DISCARD_WORKTREE]: () => contractSections.push(buildProgrammaticOutputCompletionSection(lightSentinelPath())),
    [COMPLETION_MODES.CLAIM_FLOW]: () => contractSections.push(buildClaimFlowCompletionSection({
      isTui, sentinelPath: lightSentinelPath(), reviewersCsv: claimReviewersCsv(task, codeReviewDefaults, defaultReviewers),
      prStaysOpen: prStaysOpen(task),
      rawPrCompletion: task.metadata?.prCompletion || null,
      claimResume: claimResumeContext(task, worktreeInfo),
      swarmClaim: usesSwarmClaim(task),
      agentId,
      ...mergeAdmissionOptions(task),
      workflowScope: task.metadata?.forgeWorkflowScope || null,
      workflowScopeStagedPath,
      serverCheckout: isTruthyMeta(task.metadata?.claimServerCheckout),
    })),
    [COMPLETION_MODES.READ_ONLY]: () => contractSections.push(buildReadOnlyCompletionSection({ isTui, sentinelPath: lightSentinelPath() })),
    [COMPLETION_MODES.REVIEW_LOOP_FOLLOW_UP]: () => {
      contractSections.push(buildReviewLoopFollowUpSection(reviewLoopPromptMetadata(task, worktreeInfo, reviewPolicy.reviewerCatalogs), { verbose: false, localAgentLoopBody, mergeHandoff: mergeHandoffEnabled(task), forgeCli: resolvedForgeCli }));
      if (!isTruthyMeta(task.metadata?.reviewLoopLeaveOpen)) contractSections.push(buildMergeAdmissionSection(agentId, mergeAdmissionOptions(task)));
      if (!isTui) return;
      const branchName = worktreeInfo?.branchName || task.metadata?.reviewLoopPRBranch || null;
      const sentinelTail = branchName ? `   ## Branch\n   ${branchName}` : '   ## Branch\n   <branch name>';
      contractSections.push([
        '## Completion Handoff',
        'When finished with the follow-up steps above, write the completion sentinel to signal PortOS that you are done:',
        '',
        ...buildSentinelWriteSteps(1, lightSentinelPath(), sentinelTail)
      ].join('\n'));
    },
    [COMPLETION_MODES.AUDIT_FLOW]: () => contractSections.push(buildAuditFlowCompletionSection({ isTui, sentinelPath: lightSentinelPath() })),
    [COMPLETION_MODES.RECONCILE_FLOW]: () => contractSections.push(buildReconcileFlowCompletionSection({ sentinelPath: lightSentinelPath() })),
    [COMPLETION_MODES.CHECKOUT_RECOVERY]: () => contractSections.push(buildCheckoutRecoveryCompletionSection({ sentinelPath: lightSentinelPath(), ownership: task.metadata?.checkoutOwnership })),
    [COMPLETION_MODES.RELEASE_FLOW]: () => contractSections.push(buildReleaseFlowCompletionSection({ isTui, isCli: !isTui, sentinelPath: lightSentinelPath() })),
    [COMPLETION_MODES.TUI_SLASHDO_FREE]: pushTuiCompletion,
    [COMPLETION_MODES.TUI]: pushTuiCompletion,
  }[completionMode] || pushCliCompletion)();

  // The manual workflow's step 4 points here — it must follow the completion
  // section it is a step of. Gated on the SAME value that made that step emit,
  // so a dangling "step 4" cross-reference and an orphaned Review Loop section
  // are both unrepresentable.
  if (rendersInlinePrLifecycle) {
    contractSections.push(buildInlineReviewLoopSection({
      taskId: task.id,
      branchName: worktreeInfo?.branchName || null,
      runsReviewLoop: runsPrSideReviewLoop,
      leaveOpen: false,
      localAgentLoopBody: null,
      localAgentLoopBodyPath: null,
      // Only the TUI completion workflow ends on a sentinel write; a CLI run
      // signals completion by exiting.
      writesSentinel: isTui,
      reviewPolicy: prSidePolicy,
      // A configured roster is not evidence of a local phase: merge-only
      // delivery does not emit one, even when reviewer defaults are populated.
      localPhaseReviewers: localReviewSection ? localReviewers : [],
      localPhaseCanShortCircuit,
      localPhaseReviewRequired: localReviewSection ? localReviewRequired : false,
      reviewerPositions,
      forgeCli: resolvedForgeCli,
      workflowStep: localReviewSection ? 5 : 4,
      mergeHandoff: mergeHandoffEnabled(task),
    }));
  }

  const auditCompletion = buildAuditOutputCompletionSection(task, lightSentinelPath());
  if (auditCompletion) contractSections.push(auditCompletion);

  return { taskSections, contractSections };
}

/**
 * The light path's worktree / pipeline / JIRA context sections, in the order
 * they render. Each is present only when the task carries that context, which
 * is why they are collected here rather than tested inline in
 * `buildLightContextSections`.
 */
function buildLightTaskContextSections({
  task, worktreeInfo, isWorktreeOnExistingBranch, isTui, mode, canTypeSlashCommands, rendersInlinePrLifecycle,
  willOpenPR, discardWorktree, claimFlow, noChangeSuccess,
}) {
  const sections = [];
  // --- Worktree ----------------------------------------------------------
  if (worktreeInfo) {
    sections.push([
      '## Git Worktree',
      `- **Branch**: \`${worktreeInfo.branchName}\`${worktreeBranchSuffix(worktreeInfo, isWorktreeOnExistingBranch)}`,
      `- **Path**: \`${worktreeInfo.worktreePath}\``,
      worktreeInfo.baseBranch ? `- **Based on**: \`${worktreeInfo.baseBranch}\`` : null,
      '',
      worktreeCommitGuidance({ isTui, mode, canTypeSlashCommands, rendersInlinePrLifecycle, isWorktreeOnExistingBranch, willOpenPR, discardWorktree, claimFlow, noChangeSuccess, headIsDefaultBranch: worktreeInfo.headIsDefaultBranch === true }),
      [COMPLETION_MODES.RELEASE_FLOW, COMPLETION_MODES.AUDIT_FLOW, COMPLETION_MODES.RECONCILE_FLOW, COMPLETION_MODES.CHECKOUT_RECOVERY].includes(mode)
        ? 'Follow the bundled workflow branch instructions while preserving unrelated work.'
        : 'Do NOT manually switch branches or modify the worktree configuration.',
      // Resuming a previous failed agent's branch: establish what's already done
      // before writing code (see buildResumeSection). '' when not a resume.
      buildResumeSection(task, worktreeInfo) || null
    ].filter(Boolean).join('\n'));
  }

  // --- Pipeline ----------------------------------------------------------
  const pipelineCtx = task.metadata?.pipeline;
  const pipelineLines = pipelineContextLines(pipelineCtx);
  if (pipelineLines.length) sections.push(['## Pipeline Context', ...pipelineLines].join('\n'));

  // --- JIRA --------------------------------------------------------------
  if (task.metadata?.jiraTicketId) {
    sections.push([
      '## JIRA',
      `- **Ticket**: ${task.metadata.jiraTicketId} (${task.metadata.jiraTicketUrl})`,
      task.metadata.jiraBranch ? `- **Branch**: \`${task.metadata.jiraBranch}\` — commit here; do NOT switch branches.` : null,
      `Include the ticket ID in commit messages, e.g. \`${task.metadata.jiraTicketId}: description\`.`
    ].filter(Boolean).join('\n'));
  }
  return sections;
}
