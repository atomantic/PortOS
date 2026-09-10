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
    worktreeBranch: worktreeInfo?.branchName || null,
    isWorktree: !!worktreeInfo,
    isPersistentWorktree: !!worktreeInfo?.isPersistentWorktree,
    taskDescription: task.description,
    taskType: task.taskType,
    priority: task.priority,
    providerId: provider.id,
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
    prOpenedBy,
    model: selectedModel,
    // The reasoning-effort override this run was dispatched with (null when the
    // task pinned none). Persisted next to the model because the Resume Agent
    // modal seeds its own effort select from here — without it a resume of an
    // effort-pinned run silently drops back to the provider default.
    effort: task.metadata?.effort || null,
    modelTier: modelSelection.tier,
    modelReason: modelSelection.reason,
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
