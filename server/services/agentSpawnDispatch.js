import { bindCompletionTaskDispatch } from './agentCompletionTaskHandoff.js';
import { withBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { join } from 'path';
import { existsSync } from 'fs';
import { getConfig } from './cosState.js';
import { updateTask } from './cosTaskStore.js';
import { isExpectedUnpersistedMiss } from '../lib/autonomousJobTask.js';
import { isPrivateSecurityTask } from '../lib/privateSecurityPolicy.js';
import { PROVIDER_CONFIG_BLOCKED_CATEGORY } from '../lib/taskBlockCategories.js';
import { ensureDir, PATHS, writeFileGuarded } from '../lib/fileUtils.js';
import { repoIssueUrlBase, resolveAppForgeTarget, resolveRepoForgeTarget } from '../lib/workTracker.js';
import { captureAuditSourceEvidence } from '../lib/auditSourceEvidence.js';
import { isAuditTaskType } from '../lib/auditCatalog.js';
import { resolveTaskHookType } from './taskTypeHooks.js';
import { capturePrimaryCheckoutState } from '../lib/primaryCheckoutGuard.js';
import { buildAgentPrompt, getAppWorkspace, isClaimFlowTask, promptOpensOwnPr } from './agentPromptBuilder.js';
import { isOllamaClaudeProvider, isClaudeCommand, isCodexProvider } from '../lib/providerModels.js';
import { PROVIDER_TYPES } from '../lib/aiToolkit/constants.js';
import { buildCliSpawnConfig, isClaudeCliProvider, isTuiProvider, getClaudeSettingsEnv, spawnDirectly } from './agentCliSpawning.js';
import { dropUnsupportedOllamaThinking } from './ollamaAgentContext.js';
import { buildTuiSpawnConfig, spawnTuiAgent } from './agentTuiSpawning.js';
import { publicReviewPostureForProfile, supportsTuiPublicReviewActionsProvider, PUBLIC_REVIEW_NO_TOOL_POSTURE } from '../lib/providerVendors.js';
import { checkPublicReviewSpawnPreconditions } from '../lib/publicReviewSpawnGate.js';
import { buildAgentRegistration, resolveExecutionMode } from '../lib/agentRegistrationRecord.js';
import { hasCredentialBootstrap } from '../lib/credentialBootstrap.js';
import { applyTaskGenerationOverrides } from '../lib/taskGenerationOverrides.js';
import { PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE } from '../lib/agentExecutionProfiles.js';
import { formatPublicReviewInputPrompt } from '../lib/modelAbuseGuard.js';
import { validatePublicReviewModel } from './modelAbuseGuard.js';
import { loadPublicReviewSpawnInput } from './publicReviewSpawnInput.js';
import { securityScanGrantFromArgs } from '../lib/securityScanEvidence.js';
import { registerAgent, updateAgent } from './cosAgentLifecycle.js';
import { createAgentRun } from './agentRunTracking.js';
import { clearAgentDispatching, markAgentDispatching, useRunner } from './agentState.js';
import { cloudSwarmThreadCapacity, localEndpointOfProvider, providerBaseUrl } from './cosLocalEndpointSlots.js';
import { describeLocalPromptBudget, planLocalPromptBudget } from '../lib/localPromptBudget.js';
import { resolveAgentProviderAndModel } from './agentProviderResolution.js';
import { prepareAgentWorkspace } from './agentWorkspacePrep.js';
import { buildClaim } from './cosTaskClaim.js';
import { cosEvents, emitLog } from './cosEvents.js';
import { currentTaskTypeName } from '../lib/taskTypeRenames.js';
import { isHostShuttingDown } from '../lib/hostShutdown.js';

const ROOT_DIR = PATHS.root;
const AGENTS_DIR = PATHS.cosAgents;

// The agent's worktree is created inside this call but nothing records its owner
// until `registerAgent`, and the spawn helpers add it to the process maps later
// still. Holding the id as "dispatching" for the whole call (released on every
// return and throw, including blockAndBail) keeps reapers off a tree that is
// clean and at the default branch's HEAD — i.e. indistinguishable from merged.
export async function dispatchAgentRun(context, opts) {
  markAgentDispatching(context.agentId);
  try {
    const type = currentTaskTypeName(context.task.metadata?.analysisType || context.task.metadata?.selfImprovementType);
    if (type === 'do-release' || type === 'release-sync') {
      const [{ withClaimOwnershipLock }, { releaseTaskDispatchDisposition }] = await Promise.all([
        import('./cosClaimOwnershipState.js'), import('./releaseSynchronization.js'),
      ]);
      const disposition = await withClaimOwnershipLock(() => releaseTaskDispatchDisposition(context.task));
      if (disposition === 'retired-continuation' || disposition === 'wait-for-synchronization') {
        return context.blockAndBail({ reason: disposition === 'retired-continuation'
          ? 'This release synchronization was retired by an operator.'
          : 'The previous release synchronization is unfinished.', persist: false });
      }
    }
    return await runAgentDispatch(context, opts);
  } finally {
    clearAgentDispatching(context.agentId);
  }
}

async function runAgentDispatch(context, { spawnViaRunner } = {}) {
  const { task, agentId, laneName, toolExecution, instanceId } = context;
  const config = await getConfig();
  const resolution = await resolveAgentProviderAndModel(task);
  if (!resolution.ok) {
    return context.blockAndBail({
      reason: resolution.error,
      infrastructureCode: resolution.infrastructureCode,
      category: PROVIDER_CONFIG_BLOCKED_CATEGORY,
      persist: resolution.permanent,
      emitPayload: {
        ...(resolution.providerId && { providerId: resolution.providerId }),
        ...(resolution.providerStatus && { providerStatus: resolution.providerStatus }),
      },
    });
  }
  const { provider, modelSelection } = resolution;
  let { selectedModel } = resolution;
  const privateSecurity = isPrivateSecurityTask(task);
  const executionProfile = task.metadata?.executionProfile;
  const publicReviewPosture = publicReviewPostureForProfile(executionProfile);
  const publicReviewNoTools = publicReviewPosture === PUBLIC_REVIEW_NO_TOOL_POSTURE;
  const publicReviewActions = executionProfile === PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE;
  const publicReview = Boolean(publicReviewPosture);
  const isTui = isTuiProvider(provider);
  const publicReviewTui = publicReviewActions && isTui
    && supportsTuiPublicReviewActionsProvider(provider);
  const spawnHeadless = !isTui || (publicReview && !publicReviewTui);
  const publicReviewBlock = await checkPublicReviewSpawnPreconditions({
    task,
    provider,
    selectedModel,
    publicReviewPosture,
    publicReview,
    publicReviewActions,
    publicReviewNoTools,
    privateSecurity,
    validateModel: validatePublicReviewModel,
  });
  if (publicReviewBlock) return context.blockAndBail(publicReviewBlock);
  // Inbox actions can target a different account and repository from this
  // checkout. Bind their credential before any workspace work or registration.
  const inboxAccountTask = task.metadata?.githubNotificationAccount || task.metadata?.githubNotificationResolve || task.metadata?.githubSecurityFix || task.metadata?.githubAccount;
  if (publicReview && inboxAccountTask) return context.blockAndBail({
    reason: 'An inbox account credential cannot be given to a public-content review stage.',
    category: 'github-inbox-account-unavailable',
  });
  const notificationAuth = inboxAccountTask
    ? await import('./githubNotificationAgentAuth.js')
      .then(({ resolveNotificationAgentEnv }) => resolveNotificationAgentEnv(task))
      .then(env => ({ env }), error => ({ error }))
    : { env: null };
  if (notificationAuth.error) return context.blockAndBail({
    reason: notificationAuth.error.message,
    category: 'github-inbox-account-unavailable',
  });
  const dispatchUseRunner = (publicReview || hasCredentialBootstrap(provider)) ? false : useRunner;
  let publicReviewPromptData = null;
  // Workspace preparation may consume a reviewed-head pin in memory. The CAS
  // must compare the original persisted snapshot, not that intended patch.
  const expectedDispatchMetadata = structuredClone(task.metadata || {});
  const expectedDispatchStatus = task.status || null;

  return prepareAgentWorkspace({ agentId, task, onPrepared: async prep => {
    if (prep.outcome === 'deferred') {
      await context.cleanupOnError(prep.reason);
      cosEvents.emit('agent:deferred', { taskId: task.id, reason: prep.deferReason, branch: prep.branch });
      return null;
    }
    if (prep.outcome === 'blocked') {
      await context.cleanupOnError(prep.reason);
      cosEvents.emit('agent:error', { taskId: task.id, error: prep.reason });
      return null;
    }
    const { workspacePath, resolvedApp, resolvedAppName, worktreeInfo, jiraTicket, jiraBranchName, explicitWorktree } = prep;
    if (worktreeInfo?.branchName && !worktreeInfo.existingBranch && !worktreeInfo.isPersistentWorktree) {
      context.spawnWorktree = { branchName: worktreeInfo.branchName };
    }

    if (publicReview && !privateSecurity) {
      const reviewInput = await loadPublicReviewSpawnInput({
        scanKey: task.metadata?.pipeline?.reviewInputKey,
        workspacePath,
        actionsStage: publicReviewActions,
        eligibleNumbers: task.metadata?.pipeline?.eligibility?.eligibleNumbers,
        noToolReviewer: publicReviewNoTools,
      });
      if (reviewInput.block) return context.blockAndBail(reviewInput.block);
      publicReviewPromptData = reviewInput.promptData;
    }

    await import('./workspaceContext.js')
      .then((ws) => ws.snapshotOnRepoSwitch(task.metadata?.app || null))
      .catch((err) => {
        emitLog('warn', `Workspace auto-snapshot skipped for task ${task.id}: ${err?.message || err}`, { taskId: task.id });
      });

    const leanMode = isOllamaClaudeProvider(provider);
    const isLightContext = isTui || provider.type === PROVIDER_TYPES.CLI;
    const splitSystemPrompt = isLightContext && isClaudeCommand(provider.command);
    const privatePrompt = privateSecurity
      ? await import('./privateSecurityAssessment.js').then(({ preparePrivateSecurityAssessment }) => preparePrivateSecurityAssessment(task, provider, selectedModel))
      : null;
    const promptTrace = {};
    const promptResult = privateSecurity ? privatePrompt : await buildAgentPrompt(task, config, workspacePath, worktreeInfo, {
      promptTrace,
      providerType: provider.type,
      providerId: provider.id,
      providerCommand: provider.command,
      providerModel: selectedModel,
      agentId,
      leanMode,
      split: splitSystemPrompt,
    });
    const basePrompt = typeof promptResult === 'string' ? promptResult : promptResult.userPrompt;
    const prompt = publicReview && !privateSecurity
      ? `${basePrompt}\n\n${formatPublicReviewInputPrompt(publicReviewPromptData)}`
      : basePrompt;
    const systemPrompt = typeof promptResult === 'string' ? null : promptResult.systemPrompt;
    const executionOptions = modelSelection.orchestrationExecutionOptions ?? task.metadata?.executionOptions;
    let requestedProvider = applyTaskGenerationOverrides(provider, { ...task.metadata, executionOptions });
    let executionAttribution;
    if (requestedProvider.executionOptions && Object.keys(requestedProvider.executionOptions).length) {
      const { prepareExecutionOptions } = await import('../lib/providerExecutionOptions.js');
      const prepared = await prepareExecutionOptions(provider, selectedModel, executionOptions, 'task', { cwd: workspacePath });
      requestedProvider.executionOptions = prepared.provider.executionOptions;
      requestedProvider.executionOptionSupport = prepared.provider.executionOptionSupport;
      requestedProvider.executionOptionAttribution = prepared.attribution;
      executionAttribution = prepared.attribution;
      selectedModel = prepared.provider.defaultModel || selectedModel;
    }
    if (notificationAuth.env) {
      // This copy exists only for this launch. The stored provider and agent/run
      // registration retain the original provider, with no inbox token added.
      // Every CLI/TUI/runner composer already carries provider.envVars and skips
      // its checkout credential lookup when this explicit token is present.
      requestedProvider.envVars = { ...requestedProvider.envVars, ...notificationAuth.env };
    }
    const { provider: runProvider, effort: taskEffort } = await dropUnsupportedOllamaThinking(
      requestedProvider,
      selectedModel,
      requestedProvider.effort || null,
    );
    const localEndpoint = localEndpointOfProvider(provider);
    const localPromptBudget = localEndpoint
      ? planLocalPromptBudget({
        prompt,
        endpoint: localEndpoint,
        baseDurationMs: await import('./taskLearning.js')
          .then((tl) => tl.getTaskDurationEstimate(task.description, {
            providerId: provider.id,
            model: selectedModel,
            effort: taskEffort,
          }))
          .then((estimate) => estimate?.estimatedDurationMs ?? null)
          .catch(() => null),
      })
      : null;
    if (localPromptBudget?.longPrefill) {
      emitLog('info', `🐢 Agent ${agentId} ${describeLocalPromptBudget(localPromptBudget)}`, {
        agentId,
        taskId: task.id,
        promptTokens: localPromptBudget.promptTokens,
      });
    }

    const executionMode = resolveExecutionMode({ spawnHeadless, useRunner: dispatchUseRunner });
    const sourceWorkspace = worktreeInfo
      ? (task.metadata?.app ? await getAppWorkspace(task.metadata.app) : ROOT_DIR)
      : null;
    const prOpenedBy = promptOpensOwnPr(task, {
      providerType: provider.type,
      providerId: provider.id,
      providerCommand: provider.command,
      leanMode,
      worktreeInfo,
    });
    const claimFlowTask = isClaimFlowTask(task);
    const [forgeTarget, primaryCheckoutBaseline, auditSourceEvidence] = await Promise.all([
      resolvedApp
        ? resolveAppForgeTarget(resolvedApp, { repoPath: workspacePath }).then(r => r.target)
        : resolveRepoForgeTarget(workspacePath),
      sourceWorkspace ? capturePrimaryCheckoutState(sourceWorkspace) : null,
      isAuditTaskType(resolveTaskHookType(task)) ? captureAuditSourceEvidence(workspacePath) : null,
    ]);
    const injectedMemories = promptTrace.injectedMemories || [];
    let systemPromptFile = null;
    const agentDir = join(AGENTS_DIR, agentId);
    // A preparation that straddled SIGTERM must not write a durable owner the
    // shutdown marker never saw: the next boot would charge it as a genuine
    // orphan (#14170). The task stays pending; cleanup releases claim and tree.
    if (isHostShuttingDown()) {
      await context.cleanupOnError('PortOS is shutting down');
      return null;
    }
    const { runId, registeredAgent } = await withBackupAssetPublication(async () => {
      if (!existsSync(agentDir)) {
        await ensureDir(agentDir);
      }
      await writeFileGuarded(join(agentDir, 'prompt.txt'), prompt);
      if (systemPrompt) {
        systemPromptFile = join(agentDir, 'system-prompt.md');
        await writeFileGuarded(systemPromptFile, systemPrompt);
      }
      const { runId } = await createAgentRun({
        agentId,
        task,
        model: selectedModel,
        provider,
        workspacePath,
        appName: resolvedAppName,
        injectedMemories,
        executionOptions: executionAttribution,
      });
      const registeredAgent = await registerAgent(agentId, task.id, buildAgentRegistration({
        task,
        provider,
        instanceId,
        workspacePath,
        sourceWorkspace,
        repoIssueUrl: repoIssueUrlBase(forgeTarget),
        primaryCheckoutBaseline,
        auditSourceEvidence,
        worktreeInfo,
        explicitWorktree,
        jiraBranchName,
        providerEndpoint: providerBaseUrl(provider),
        localPromptBudget,
        leanMode,
        prOpenedBy,
        // Same decision that put merge admission in the prompt (#11435).
        mergesOwnPr: promptTrace.mergesOwnPr === true,
        claimFlowTask,
        selectedModel,
        effort: taskEffort,
        modelSelection,
        runId,
        dispatchUseRunner,
        executionMode,
        publicReviewPosture,
        resolvedAppName,
        injectedMemories,
      }));
      return { runId, registeredAgent };
    });

    emitLog('info', `Agent ${agentId} initializing...${worktreeInfo ? ' (worktree)' : ''}${jiraBranchName ? ` (JIRA: ${jiraTicket?.ticketId})` : ''}`, { agentId, taskId: task.id });
    const newSpawnCount = (Number(task.metadata?.totalSpawnCount) || 0) + 1;
    const updateResult = await updateTask(task.id, {
      status: 'in_progress',
      metadata: {
        ...task.metadata,
        totalSpawnCount: newSpawnCount,
        lastSpawnedAt: new Date().toISOString(),
        ...buildClaim(instanceId),
      },
    }, task.taskType || 'user', { expectedStatus: expectedDispatchStatus,
      expectedTask: { metadata: expectedDispatchMetadata }, spawnBudgetOperation: { kind: 'dispatch', agentId, startedAt: registeredAgent?.startedAt } })
      .catch(err => {
        console.error(`❌ Failed to mark task ${task.id} as in_progress: ${err.message}`);
        return null;
      });
    if (updateResult?.error) {
      if (!isExpectedUnpersistedMiss(task, updateResult.error)) emitLog('warn', `⚠️ in_progress claim for task ${task.id} returned an error (taskType=${task.taskType}): ${updateResult.error}`, { taskId: task.id, error: updateResult.error });
    }
    const holdUnpersistedDispatch = async reason => {
      // A registered owner and prepared checkout now exist. A failed CAS is
      // not authority to release a possibly changed claim or discard work.
      context.claimAcquired = false;
      context.spawnWorktree = null;
      await context.cleanupOnError(reason);
    };
    if (updateResult?.statusChanged || (updateResult?.error
      && (prep.cleanupReviewPinConsumed || !isExpectedUnpersistedMiss(task, updateResult.error)))) {
      await holdUnpersistedDispatch(prep.cleanupReviewPinConsumed
        ? 'Failed to persist reviewed-head launch admission; retained checkout requires revalidation'
        : 'Failed to persist task dispatch; task or ownership changed');
      return null;
    }
    if (!updateResult) {
      await holdUnpersistedDispatch('Failed to update task status');
      return null;
    }

    // Completion and its retry decision must see the dispatch that was actually
    // persisted, including the incremented spawn count. Passing the pre-claim
    // task lets finalization write the previous count back and refund a spawn.
    // Unpersisted scheduled jobs retain their original task on the expected miss.
    const dispatchedTask = !updateResult.error && !updateResult.statusChanged && updateResult.id === task.id && updateResult.metadata
      ? { ...task, ...updateResult, taskType: task.taskType || 'user' } : task;
    if (!updateResult.error && !updateResult.statusChanged) await bindCompletionTaskDispatch(agentId, dispatchedTask);

    if (task.metadata?.autonomousJob && task.metadata?.jobId) {
      cosEvents.emit('job:spawned', { jobId: task.metadata.jobId });
    }
    const cliSettingsEnv = !publicReview && isClaudeCliProvider(provider)
      ? await getClaudeSettingsEnv()
      : {};
    const maxConcurrentThreads = cloudSwarmThreadCapacity(runProvider, task.metadata?.swarmCount);
    const safetyProfile = publicReview ? executionProfile : null;
    const cliConfig = !spawnHeadless
      ? buildTuiSpawnConfig(runProvider, selectedModel, { systemPromptFile, effort: taskEffort, maxConcurrentThreads, safetyProfile })
      : buildCliSpawnConfig(runProvider, selectedModel, cliSettingsEnv, { systemPromptFile, effort: taskEffort, maxConcurrentThreads, safetyProfile });
    const securityScanGrant = dispatchUseRunner && resolveTaskHookType(task) === 'security' && isCodexProvider(runProvider)
      ? securityScanGrantFromArgs(cliConfig.args)
      : null;
    if (executionAttribution) await updateAgent(agentId, { metadata: { executionOptions: executionAttribution } });
    if (securityScanGrant) await updateAgent(agentId, { metadata: { securityScanGrant, taskAnalysisType: 'security' } });

    emitLog('success', `Spawning agent for task ${task.id}`, {
      agentId,
      model: selectedModel,
      mode: executionMode,
      cli: cliConfig.command,
      lane: laneName,
      worktree: !!worktreeInfo,
    });

    context.handedOff = true;
    if (!spawnHeadless) {
      return await spawnTuiAgent({
        agentId,
        task: dispatchedTask,
        prompt,
        workspacePath,
        model: selectedModel,
        provider: runProvider,
        runId,
        tuiConfig: cliConfig,
        agentDir,
        executionId: toolExecution.id,
        laneName,
        leanMode,
        prOpenedBy,
        useDurableRunner: dispatchUseRunner,
        safetyProfile,
        securityScanGrant,
      });
    }
    if (dispatchUseRunner) {
      return await spawnViaRunner(agentId, dispatchedTask, { prompt, workspacePath, model: selectedModel, provider: runProvider, runId, cliConfig, executionId: toolExecution.id, laneName, securityScanGrant });
    }
    return await spawnDirectly({
      agentId,
      task: dispatchedTask,
      prompt,
      workspacePath,
      model: selectedModel,
      provider: runProvider,
      runId,
      cliConfig,
      agentDir,
      executionId: toolExecution.id,
      laneName,
      prOpenedBy,
      safetyProfile,
    });
  } });
}
