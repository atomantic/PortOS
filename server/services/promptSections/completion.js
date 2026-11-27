/** Public completion prompt builders for workflow, claim, CLI, and TUI runs. */

export {
  NO_CHANGE_AUDIT_GUIDANCE,
  SENTINEL_WRITE_PERMISSION_NOTE,
  buildCompletionGuidelineBullet,
  buildFallbackCompletionInstructions,
  DISCARD_WORKTREE_NOTE,
  isPrBranchWorktree,
  buildUnnecessaryDispatchSection,
  buildResumeSection,
  buildToolFreeReasoningCompletionSection,
  buildProgrammaticOutputCompletionSection,
  buildReadOnlyCompletionSection,
  buildActionOutputCompletionSection,
  buildExternalRepositoryCompletionSection,
  buildCheckoutRecoveryCompletionSection,
  buildReconcileFlowCompletionSection,
  buildReleaseFlowCompletionSection,
  buildAuditFlowCompletionSection,
  buildAuditOutputCompletionSection,
  worktreeCommitGuidance,
  buildSentinelWriteSteps,
} from './completionFlows.js';

export {
  claimReviewersCsv,
  claimResumeContext,
  buildClaimResumeOverride,
  AUTO_MERGE_SECTION,
  buildCodeOwnerBlockSection,
  buildMergeAdmissionSection,
  buildWorkflowScopeSection,
  buildClaimFlowCompletionSection,
} from './completionClaim.js';

export {
  buildAutoMergeCommitStep,
  promptOpensOwnPr,
  inlinePrLifecycleSection,
  buildInlineReviewLoopSection,
} from './completionPullRequest.js';

export { buildTuiCompletionSection } from './completionTui.js';

export { buildCliCompletionSection } from './completionCli.js';

export { portosMergesBranchOnExit } from '../../lib/agent/agentCompletionMode.js';
