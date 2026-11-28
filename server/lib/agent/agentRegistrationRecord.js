/**
 * `buildAgentRegistration` projects a spawn's task into the `registerAgent` payload, with
 * `resolveExecutionMode` choosing direct, runner, tui or runner-tui.
 */

import { isTruthyMeta } from '../metadataFlags.js';
import { processAuditRecoveryOriginSchema } from '../persistent/persistentMindProcessAudit.js';
/**
 * The agent record a spawn registers, projected from the task it is running.
 *
 * `agent.metadata` is a HAND-PICKED projection of `task.metadata`, never a spread: every downstream consumer (run cards,
 * `perpetualRefillPlan`, `declaresNoCommitCriterion`, quota-burn continuation, `featureAgents`) reads the agent record
 * alone, so adding a task field is a deliberate decision about whether the agent needs it. Pure and synchronous;
 * `primaryCheckoutBaseline` and `providerEndpoint` arrive as VALUES to keep this leaf out of the agent-state and
 * local-endpoint graphs.
 */

// Import from the declaring module, not a barrel (server/AGENTS.md, "Import scoping").
import { normalizeReviewers } from '../reviewerConfig.js';
import { quotaBurnAgentMetadata } from '../quotaBurnOrigin.js';
import { claimOwnershipBinding, reconcileAssignmentForTask } from '../claimContinuation.js';
import { explicitPrCompletion, prHeldForOperator } from '../prDisposition.js';
import { repositoryCleanupMergeTarget } from '../recoveryMergeTarget.js';

/**
 * How this run is dispatched: a headless run is `direct` or `runner`, an interactive PTY session is `tui` or
 * `runner-tui`; the `runner-` prefix means the durable CoS runner owns the child instead of this process.
 */
export function resolveExecutionMode({ spawnHeadless, useRunner }) {
  if (spawnHeadless) return useRunner ? 'runner' : 'direct';
  return useRunner ? 'runner-tui' : 'tui';
}

/** The `registerAgent` payload for one spawn. See the module note above. */
export function buildAgentRegistration({
  task,
  provider,
  instanceId,
  workspacePath,
  sourceWorkspace,
  repoIssueUrl,
  primaryCheckoutBaseline,
  auditSourceEvidence = null,
  worktreeInfo,
  explicitWorktree,
  jiraBranchName,
  providerEndpoint,
  localPromptBudget,
  leanMode,
  prOpenedBy,
  mergesOwnPr = false,
  claimFlowTask,
  privacyFactsIncluded = false,
  selectedModel,
  effort = null,
  modelSelection,
  runId,
  dispatchUseRunner,
  executionMode,
  publicReviewPosture,
  resolvedAppName,
  injectedMemories = [],
}) {
  return {
    instanceId,
    workspacePath,
    sourceWorkspace,
    // Branch-jack baseline: the primary checkout's branch + HEAD when this worktree agent started. finalizeAgent re-reads
    // it and fails the run if the primary moved. Non-throwing: an unreadable checkout yields null ("nothing to check").
    primaryCheckoutBaseline,
    // Trusted launch capture only; never project a task/model-supplied claim.
    auditSourceEvidence,
    ...(Number(task.metadata?.auditDispositionVersion) === 1 ? { auditDispositionVersion: 1 } : {}),
    // Issue-tracker base URL of the run's repository (shaped by `repoIssueUrlBase`) so the card can link a bare `#7640` in
    // the completion summary. Stamped, not resolved at render: it is immutable run provenance (re-pointing an app later
    // must not relabel finished runs). Older records carry null, rendered as plain text.
    repoIssueUrl,
    worktreeBranch: worktreeInfo?.branchName || null,
    worktreeBaseBranch: worktreeInfo?.baseBranch || null,
    // Keep explicit handoffs after task archival; omitted policy is not a grant.
    prCompletionPolicy: explicitPrCompletion(task),
    isWorktree: !!worktreeInfo,
    isPersistentWorktree: !!worktreeInfo?.isPersistentWorktree,
    isRecovery: isTruthyMeta(task.metadata?.isRecovery),
    recoveryOrigin: processAuditRecoveryOriginSchema.safeParse(task.metadata?.recoveryOrigin).data || null,
    taskDescription: task.description,
    taskType: task.taskType,
    priority: task.priority,
    providerId: provider.id,
    // Immutable, non-secret route provenance. Individual fields, never the provider record (envVars, endpoints, args and
    // credentials are execution details that must not be persisted or rendered).
    providerName: provider.name || null,
    providerType: provider.type || null,
    providerMethod: provider.method || provider.type || null,
    harnessId: provider.harnessId || null,
    serviceId: provider.serviceId || null,
    servicePlan: provider.servicePlan || null,
    providerCredentialBootstrapId: provider.credentialBootstrapId || null,
    providerHasCredentialBootstrap: Boolean(provider.credentialBootstrap),
    // Persisted with the id because the cleanup path's `agentOpensOwnPr` gate must derive from the SAME
    // `canTypeSlashCommands` predicate the prompt used; an id alone can't say (custom-id `claude` is slashdo-capable, lean `--bare` is not).
    providerCommand: provider.command || null,
    // The endpoint this agent's inference lands on, stamped so the per-local-endpoint spawn cap knows which GPU a RUNNING
    // agent occupies even if the provider record is edited or deleted mid-run (older records fall back to resolving the
    // id). Resolved through the SAME helper the counter reads with; stamped as the RAW url, never the slot key (null for a
    // cloud provider, which would re-open that hole).
    providerEndpoint,
    // Prefill cost/duration estimate for a LOCAL endpoint. Absent/null means "no estimate", never a small one.
    localPromptBudget,
    leanMode,
    // WHO opens this run's PR (`agent-slashdo` / `agent-inline` / `portos`), per the prompt this run was actually given.
    // Persisted rather than re-derived at cleanup: the two must agree or PortOS double-fires `gh pr create`. Stamped from
    // `promptOpensOwnPr`, the SAME predicate that decided the completion section, NOT from `provider.type`: it depends on
    // task shape (read-only, no-code-output, discard-worktree, JIRA/leave-open and no-worktree runs are told PortOS owns the
    // PR) and on whether the host can type a slash command (a slashdo-capable Claude TUI/CLI opens its own PR via `/do:pr`).
    // `agent-inline` (codex/grok/agy given plain `git`/`gh` steps) is the only value that owes the merge-gate check.
    // Three values rather than a boolean because a legacy `false` conflated "a `/do:pr` run" with "a run PortOS owns".
    prOpenedBy,
    model: selectedModel,
    // Resolved run effort (inherited provider default and capability suppression applied); Resume and the card must show
    // the same setting the launch builders got.
    effort,
    modelTier: modelSelection.tier,
    modelReason: modelSelection.reason,
    // Set only when the learning system substituted a weaker model than the configured default for a task that never
    // pinned one, so the card can tell that from a run on the default.
    ...(modelSelection.downgradedFromDefault && {
      modelDowngradedFromDefault: true,
      modelConfiguredDefault: modelSelection.configuredDefault
    }),
    runId,
    phase: 'initializing',
    useRunner: dispatchUseRunner,
    executionMode,
    // The public-review posture this run executes under (null for an ordinary task). Projected beside `executionMode` so
    // the card can explain why it has no "Open Shell" link (a public-review stage is forced headless unless it is the
    // sandboxed-actions stage on a TUI provider with an attachable recipe).
    publicReviewPosture,
    // The run this one TOOK OVER (stamped by `resolveTaskResumePatch` on Resume/Relaunch). The predecessor is retired as a
    // HANDOFF (`lib/agent/agentOutcome.js`); this lets the card say what it is continuing.
    resumedFromAgentId: task.metadata?.resumedFromAgentId || null,
    // Preserve privacy after the task becomes an archived agent.
    machineLocal: privacyFactsIncluded || isTruthyMeta(task.metadata?.machineLocal),
    taskAnalysisType: task.metadata?.analysisType || null,
    taskReviewType: task.metadata?.reviewType || null,
    taskApp: task.metadata?.app || null,
    // Marks an explicit "Run Now" trigger so the perpetual drain-on-completion refill (`perpetualRefillPlan`) continues a
    // MANUAL drain in the on-demand lane. `isTruthyMeta` accepts the boolean and the string `"true"` that
    // rows stored before #16407 and peers on older versions hold.
    taskOnDemand: isTruthyMeta(task.metadata?.onDemand),
    // WHO asked: a human Run keeps draining, an automated origin such as a quota burn is one unit and stops.
    taskOnDemandOrigin: task.metadata?.onDemandOrigin || null,
    // The single PR a pr-reviewer run was narrowed to; without it `perpetualRefillPlan`'s untargeted re-issue would widen a
    // per-row click into a sweep of every open PR.
    taskTargetPullRequest: task.metadata?.targetPullRequest || null,
    // LI hand-off provenance: lets `recordTaskCompletion` attribute the run's outcome back to the proposal's domain.
    taskLiProposal: task.metadata?.liProposal || null,
    // Quota-burn provenance: the runner dispatches the NEXT job in the burn plan on `agent:completed` and must tell a burn
    // run from the agent record alone. Spread from the ONE block definition (`lib/quotaBurnOrigin.js`) so no field is
    // persisted but unprojected. Values are coerced: rows stored before #16407 and peers on older versions hold every scalar as a string.
    ...quotaBurnAgentMetadata(task.metadata),
    ...(task.metadata?.auditDepth === 'deep' ? { taskAuditDepth: 'deep', ...(task.metadata.auditWorkflow ? { auditWorkflow: task.metadata.auditWorkflow } : {}) } : {}),
    // `declaresNoCommitCriterion` reads this, and taskLearning's backfill re-processes the ARCHIVED agent shape through the
    // same predicate; without it an archived tracker-filing run looks like a committing task and its stale
    // `validationPassed: false` survives the sanitizer. `?? null`, not `|| null`: `false` is the load-bearing value.
    worktreeChangesExpected: task.metadata?.worktreeChangesExpected ?? null,
    taskAppName: resolvedAppName,
    selfImprovementType: task.metadata?.selfImprovementType || null,
    jobId: task.metadata?.jobId || null,
    jiraTicketId: task.metadata?.jiraTicketId || null,
    jiraTicketUrl: task.metadata?.jiraTicketUrl || null,
    jiraBranch: task.metadata?.jiraBranch || null,
    jiraInstanceId: task.metadata?.jiraInstanceId || null,
    jiraCreatePR: task.metadata?.jiraCreatePR ?? null,
    configOpenPR: isTruthyMeta(task.metadata?.openPR),
    // Which memories steered this run's prompt ([{ id, version, relevance, preview }]); empty when none, absent on older records.
    injectedMemories,
    // Claim prompts own their external claim/<item> worktree and forge lifecycle even though CoS keeps configOpenPR/
    // configUseWorktree off (no nested worktree); kept distinct so diagnostics don't mistake it for a commit-only handoff.
    configClaimFlow: claimFlowTask,
    // The claim branch this run owns (or `claimPicksOwnBranch` for a swarm orchestrator). The agent cuts the `claim-*`
    // tree, so `workspacePath` never names it; a later relaunch reads these to see a live owner holds the checkout.
    ...claimOwnershipBinding(task),
    // Snapshot the assigned follow-up target at registration. Admission also
    // checks the persisted internal task and checkout; a prompt is never a grant.
    reviewLoopMergeTarget: task.taskType === 'internal'
      && isTruthyMeta(task.metadata?.reviewLoopFollowUp)
      && !prHeldForOperator(task)
      ? { url: task.metadata.reviewLoopPRUrl, branch: task.metadata.reviewLoopPRBranch,
        ...(worktreeInfo?.detached === true && !task.metadata.forkHead ? {
          workspacePath,
          detached: { version: 1, headSha: worktreeInfo.headSha },
        } : {}),
        ...(task.metadata.forkHead ? {
          workspacePath,
          fork: task.metadata.reviewLoopForkTarget ? structuredClone(task.metadata.reviewLoopForkTarget) : null,
        } : {}) }
      : null,
    // Generic PR delivery: the worktree PortOS provisioned and its head branch, stamped only when the prompt carries the
    // merge admission section for its own PR. Admission re-verifies the live task and checkout; neither request nor PR prose can supply it.
    prDeliveryTarget: mergesOwnPr && worktreeInfo?.branchName && workspacePath
      ? { branch: worktreeInfo.branchName, workspacePath }
      : null,
    // Repository-cleanup recovery (#12251): the parent PR this run was filed to
    // land, snapshotted so a later task edit reads as a changed target.
    recoveryMergeTarget: repositoryCleanupMergeTarget(task),
    reconcileAssignment: reconcileAssignmentForTask(task),
    configSimplify: isTruthyMeta(task.metadata?.simplify),
    configReviewLoop: isTruthyMeta(task.metadata?.reviewLoop),
    configReviewers: normalizeReviewers(task.metadata),
    configUseWorktree: !!worktreeInfo,
    configWorktreeAutoDetected: !!worktreeInfo && !explicitWorktree,
    // A read-only run gets no worktree on purpose and commits nothing; its own key because the card can't otherwise tell it
    // from a commit-only handoff.
    configReadOnly: isTruthyMeta(task.metadata?.readOnly),
    // Coding on the default branch is the LEFTOVER posture: each branch-owning or non-committing flow (CoS worktree, JIRA
    // branch, claim worktree, read-only) must be excluded here or its card wears a false "main" badge.
    configCodingOnMain: !worktreeInfo && !jiraBranchName && !claimFlowTask
      && !isTruthyMeta(task.metadata?.readOnly),
    // Feature-agent provenance survives the runner handoff and restarts so featureAgents can clear currentAgentId on completion.
    featureAgentId: task.metadata?.featureAgentId || null,
    featureAgentRun: isTruthyMeta(task.metadata?.featureAgentRun)
  };
}
