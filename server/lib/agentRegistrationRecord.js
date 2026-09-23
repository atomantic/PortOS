import { processAuditRecoveryOriginSchema } from './persistentMindProcessAudit.js';
/**
 * The agent record a spawn registers, projected from the task it is running.
 *
 * `agent.metadata` is a HAND-PICKED projection of `task.metadata`, never a
 * spread — every consumer downstream (the run cards, `perpetualRefillPlan`,
 * `declaresNoCommitCriterion`, the quota-burn continuation, `featureAgents`)
 * reads the agent record alone, so a field that is not listed here simply does
 * not survive the spawn. That is the whole reason this is one explicit literal
 * and not a merge: adding a task field is supposed to be a deliberate decision
 * about whether the agent needs it, and `quotaBurnStepId` shipped persisted but
 * unprojected (#6406) precisely because the list was being maintained inline in
 * the middle of a 900-line orchestrator.
 *
 * Pure and synchronous: everything it needs is already resolved by the caller.
 * `primaryCheckoutBaseline` and `providerEndpoint` arrive as VALUES rather than
 * being read here (both were `await`/service calls inline), and `isTruthyMetaFn`
 * is injected the same way `inlinePrLifecycleSection` takes it — which keeps
 * this leaf out of the agent-state and local-endpoint graphs.
 */

// From the module that DECLARES it, not the `validation.js` catch-all barrel:
// that barrel drags 123 modules into every suite this leaf reaches, for one
// pure helper (server/AGENTS.md, "Import scoping").
import { normalizeReviewers } from './reviewerConfig.js';
import { quotaBurnAgentMetadata } from './quotaBurnOrigin.js';

/**
 * How this run is dispatched, as one closed vocabulary rather than the nested
 * ternary chain it replaced: a headless run is `direct` or `runner`, and an
 * interactive PTY session is `tui` or `runner-tui`, with the `runner-` prefix
 * meaning the durable CoS runner owns the child instead of this process.
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
  worktreeInfo,
  explicitWorktree,
  jiraBranchName,
  providerEndpoint,
  localPromptBudget,
  leanMode,
  prOpenedBy,
  claimFlowTask,
  selectedModel,
  effort = null,
  modelSelection,
  runId,
  dispatchUseRunner,
  executionMode,
  publicReviewPosture,
  resolvedAppName,
  isTruthyMetaFn,
}) {
  return {
    instanceId,
    workspacePath,
    sourceWorkspace,
    // Branch-jack baseline (#3680): the primary checkout's branch + HEAD at the
    // instant this worktree agent started. finalizeAgent re-reads it at the end
    // of the run — every spawn mode funnels through that one chokepoint — and
    // fails the run when the primary moved, instead of recording a silent
    // "completed" for an agent that wrote unreviewed commits outside its
    // worktree. Non-throwing: an unreadable checkout yields null, which the
    // detector reads as "nothing to check".
    primaryCheckoutBaseline,
    // The issue-tracker base URL of the repository this run worked in, already
    // shaped for its forge (`repoIssueUrlBase`) so the browser appends a number
    // and knows nothing about forges. It is what a bare `#7640` in the agent's
    // own completion summary refers to, so the run card renders that reference
    // as a link without the agent having to build a URL it has no reliable way
    // to know.
    //
    // Stamped rather than resolved at render time for the two reasons the
    // baseline above is: it is immutable run provenance (re-pointing an app at
    // a different origin later must not silently relabel finished runs), and
    // the alternative is a `git` shell-out per card render. A record written
    // before this shipped carries null, which the card reads as plain text.
    repoIssueUrl,
    worktreeBranch: worktreeInfo?.branchName || null,
    isWorktree: !!worktreeInfo,
    isPersistentWorktree: !!worktreeInfo?.isPersistentWorktree,
    isRecovery: isTruthyMetaFn(task.metadata?.isRecovery),
    recoveryOrigin: processAuditRecoveryOriginSchema.safeParse(task.metadata?.recoveryOrigin).data || null,
    taskDescription: task.description,
    taskType: task.taskType,
    priority: task.priority,
    providerId: provider.id,
    // Immutable, non-secret route provenance for the active/completed cards.
    // Keep this as individual fields rather than copying the provider record:
    // envVars, endpoints, args and credentials are execution details, not run
    // metadata that should be persisted or rendered in the card.
    providerName: provider.name || null,
    providerType: provider.type || null,
    providerMethod: provider.method || provider.type || null,
    harnessId: provider.harnessId || null,
    serviceId: provider.serviceId || null,
    servicePlan: provider.servicePlan || null,
    providerCredentialBootstrapId: provider.credentialBootstrapId || null,
    providerHasCredentialBootstrap: Boolean(provider.credentialBootstrap),
    // Persisted alongside the id because the cleanup path's `agentOpensOwnPr`
    // gate must derive from the SAME `canTypeSlashCommands` predicate the prompt
    // used to decide whether the agent opens its own PR (#3114). An id alone
    // can't answer that — a path-configured `claude` under a custom id is
    // slashdo-capable, and a lean `--bare` session is not.
    providerCommand: provider.command || null,
    // The endpoint this agent's inference actually lands on, stamped for the
    // same reason as the command above: the per-local-endpoint spawn cap
    // (#4834) must know which GPU a RUNNING agent is occupying, and an id
    // alone can't answer that once the provider record is edited or deleted
    // mid-run. Pre-#4834 agent records have no value here, so the counter
    // falls back to resolving the id against the live provider list.
    //
    // Resolved through the SAME helper the counter reads with, so writer and
    // reader can't drift — a CLI provider records its daemon in envVars or an
    // OpenCode config, not in `endpoint`. Stamped as the RAW url, never the
    // slot key: a slot key is null for a cloud provider, and stamping null
    // would re-open the mid-run-edit hole this exists to close.
    providerEndpoint,
    // What this run's prompt costs to prefill on a LOCAL endpoint, and the
    // duration estimate raised by it (#6117). `null` for a cloud provider and
    // for a run with nothing assembled to measure — the card must read that as
    // "no estimate", never as a small one, so it stays absent rather than 0.
    localPromptBudget,
    leanMode,
    // WHO opens this run's PR (`agent-slashdo` / `agent-inline` / `portos`),
    // per the prompt this run was actually given. Persisted rather than
    // re-derived at cleanup time: the two must agree exactly or PortOS
    // double-fires `gh pr create`. A pre-upgrade record has no value here, so
    // `resolvePrOpenedBy` maps whatever it does carry.
    //
    // Stamped from `promptOpensOwnPr`, the SAME predicate that decided what the
    // completion section above says — NOT from `provider.type` alone. It
    // depends on the task shape (read-only, no-code-output, discard-worktree,
    // JIRA/leave-open and no-worktree runs are all told PortOS owns the PR),
    // and a provider-only stamp claimed ownership for every one of them —
    // routing a Creative Director reasoning run into the did-you-open-it net,
    // which then opened a PR for it and filed a HIGH notification blaming the
    // agent for skipping a step it was never given.
    //
    // It ALSO depends on whether the host can type a slash command, and that is
    // the half the predecessor got backwards (#6869). The stamp used to be
    // `inlinePrLifecycleSection(…) !== null`, which is FALSE for a slashdo-
    // capable Claude TUI/CLI — the host that most often opens its own PR, via
    // `/do:pr`. Those runs read as PortOS-owned, so cleanup pushed the branch
    // again and re-created a PR that already existed. `agent-slashdo` is that
    // case; `agent-inline` is the codex/grok/agy harness handed the plain
    // `git`/`gh` steps, and it is the only value that owes the #5876 merge-gate
    // check, because it is the only prompt carrying a Merge Gate section.
    //
    // Three values rather than the boolean because that is what separates them:
    // the retired `false` conflated "a `/do:pr` run" with "a run PortOS owns",
    // which is why `resolvePrOpenedBy` can only pass a legacy record's boolean
    // straight through instead of correcting it.
    prOpenedBy,
    model: selectedModel,
    // The resolved run effort, including an inherited provider default and any
    // capability suppression. Resume and the run card must describe the same
    // setting handed to the launch builders.
    effort,
    modelTier: modelSelection.tier,
    modelReason: modelSelection.reason,
    // Set only when the learning system substituted a weaker model than the
    // provider's configured default for a task that never pinned one — the
    // run card needs to distinguish "ran on the configured default" from a
    // silent downgrade (#8148).
    ...(modelSelection.downgradedFromDefault && {
      modelDowngradedFromDefault: true,
      modelConfiguredDefault: modelSelection.configuredDefault
    }),
    runId,
    phase: 'initializing',
    useRunner: dispatchUseRunner,
    executionMode,
    // The public-review posture this run executes under (null for an ordinary
    // task). Projected beside `executionMode` because the UI cannot otherwise
    // explain why the card has no "Open Shell" link: a public-review stage is
    // forced headless (`spawnHeadless` above) unless it is the sandboxed-
    // actions stage on a TUI provider whose vendor declares an attachable
    // recipe, so without this the card is indistinguishable from an agent
    // whose PTY failed to attach.
    publicReviewPosture,
    // The run this one TOOK OVER, stamped on the task by `resolveTaskResumePatch`
    // when a Resume or a provider Relaunch requeues a paused task in place. Same
    // hand-picked-projection reason as the keys around it: the predecessor is
    // retired as a HANDOFF rather than a failure (`lib/agentOutcome.js`), and
    // without this the card that took over its worktree has no way to say what it
    // is continuing — leaving the pair looking like two unrelated runs, one of
    // which mysteriously stopped.
    resumedFromAgentId: task.metadata?.resumedFromAgentId || null,
    // Preserve privacy after the task becomes an archived agent.
    machineLocal: isTruthyMetaFn(task.metadata?.machineLocal),
    taskAnalysisType: task.metadata?.analysisType || null,
    taskReviewType: task.metadata?.reviewType || null,
    taskApp: task.metadata?.app || null,
    // Marks a run dispatched by an explicit "Run Now" (on-demand) trigger, so
    // the perpetual drain-on-completion refill (perpetualRefillPlan in cos.js)
    // continues a MANUAL drain in the user-initiated on-demand lane rather than
    // the auto-run-gated queue lane. `isTruthyMeta` accepts the boolean set at
    // spawn AND the string `"true"` a COS-TASKS.md round-trip yields.
    taskOnDemand: isTruthyMetaFn(task.metadata?.onDemand),
    // WHO asked for that on-demand run. `perpetualRefillPlan` needs it to tell
    // a human Run (which keeps draining) from an automated origin such as a
    // quota burn (which is one unit and stops).
    taskOnDemandOrigin: task.metadata?.onDemandOrigin || null,
    // The single PR a pr-reviewer run was narrowed to. Same hand-picked-projection
    // reason as the keys around it: perpetualRefillPlan must see from the AGENT
    // record that this run was scoped, or its untargeted re-issue silently widens
    // a per-row click back into a sweep of every open PR.
    taskTargetPullRequest: task.metadata?.targetPullRequest || null,
    // LI hand-off provenance (#2765): projected onto the agent so the completion
    // hook (recordTaskCompletion) can attribute the run's success/failure back to
    // the proposal's domain. agent.metadata is a hand-picked projection of
    // task.metadata (not a full spread), so this must be listed explicitly.
    taskLiProposal: task.metadata?.liProposal || null,
    // Quota-burn provenance. Same hand-picked-projection reason as
    // `taskLiProposal`: the runner listens for `agent:completed` and dispatches
    // the NEXT job in this family's burn plan when the previous one finishes,
    // so it must be able to tell a burn run from any other agent from the
    // agent record alone. Spread from the ONE block definition
    // (`lib/quotaBurnOrigin.js`) so every field that reaches disk reaches the
    // runner's continuation and the denial ledger — naming them here one at a
    // time is how `quotaBurnStepId` ended up persisted but unprojected (#6406).
    // Values are coerced on the way through: a COS-TASKS.md round-trip hands
    // every scalar back as a string.
    ...quotaBurnAgentMetadata(task.metadata),
    // Same reason as taskLiProposal — a hand-picked projection, so this must be
    // listed explicitly. `declaresNoCommitCriterion` (taskTypeHooks.js) reads it
    // to decide whether a run declared a commit criterion at all,
    // and taskLearning's history backfill re-processes the ARCHIVED agent shape
    // through that same predicate. Without the projection an archived
    // tracker-filing run (reference-watch/ux on a github/gitlab/jira app) looks
    // like a committing task during backfill, so its stale `validationPassed:
    // false` fossil survives the sanitizer (#3273). `?? null` — not `|| null` —
    // because `false` is the load-bearing value here.
    worktreeChangesExpected: task.metadata?.worktreeChangesExpected ?? null,
    taskAppName: resolvedAppName,
    selfImprovementType: task.metadata?.selfImprovementType || null,
    jobId: task.metadata?.jobId || null,
    jiraTicketId: task.metadata?.jiraTicketId || null,
    jiraTicketUrl: task.metadata?.jiraTicketUrl || null,
    jiraBranch: task.metadata?.jiraBranch || null,
    jiraInstanceId: task.metadata?.jiraInstanceId || null,
    jiraCreatePR: task.metadata?.jiraCreatePR ?? null,
    configOpenPR: isTruthyMetaFn(task.metadata?.openPR),
    // Claim prompts own their external claim/<item> worktree and forge
    // lifecycle even though CoS must keep configOpenPR/configUseWorktree off
    // to avoid provisioning a nested worktree. Preserve that distinction in
    // the run record so completion diagnostics cannot mistake the claim path
    // for the generic commit-only handoff.
    configClaimFlow: claimFlowTask,
    configSimplify: isTruthyMetaFn(task.metadata?.simplify),
    configReviewLoop: isTruthyMetaFn(task.metadata?.reviewLoop),
    configReviewers: normalizeReviewers(task.metadata),
    configUseWorktree: !!worktreeInfo,
    configWorktreeAutoDetected: !!worktreeInfo && !explicitWorktree,
    // A read-only run is given no worktree on purpose (agentWorkspacePrep) and
    // commits nothing, so it is not "coding on main" either. Projected as its own
    // key because the card has no other way to tell it from a commit-only handoff.
    configReadOnly: isTruthyMetaFn(task.metadata?.readOnly),
    // Coding on the default branch is the LEFTOVER posture: no CoS worktree, no
    // JIRA feature branch, no claim worktree of its own, and not read-only. Each
    // new branch-owning or non-committing flow has to be excluded here, or its
    // card wears a warning badge that is simply false — which is how every issue
    // claimed from the Issues page came to be badged "main" while the claim
    // command was working in its own `claim/<item>` worktree.
    configCodingOnMain: !worktreeInfo && !jiraBranchName && !claimFlowTask
      && !isTruthyMetaFn(task.metadata?.readOnly),
    // Feature-agent provenance must survive the in-memory runner handoff and
    // server restarts so featureAgents can clear currentAgentId and record the
    // run when the shared CoS lifecycle emits agent:completed.
    featureAgentId: task.metadata?.featureAgentId || null,
    featureAgentRun: isTruthyMetaFn(task.metadata?.featureAgentRun)
  };
}
