import { join } from 'path';
import { existsSync } from 'fs';
import { getConfig, updateTask } from './cos.js';
import { isPrivateSecurityTask } from '../lib/privateSecurityPolicy.js';
import { PROVIDER_CONFIG_BLOCKED_CATEGORY } from '../lib/taskBlockCategories.js';
import { ensureDir, PATHS, writeFileGuarded } from '../lib/fileUtils.js';
import { repoIssueUrlBase, resolveAppForgeTarget, resolveRepoForgeTarget } from '../lib/workTracker.js';
import { capturePrimaryCheckoutState } from '../lib/primaryCheckoutGuard.js';
import { buildAgentPrompt, getAppWorkspace, isClaimFlowTask, promptOpensOwnPr } from './agentPromptBuilder.js';
import { isOllamaClaudeProvider, isClaudeCommand } from '../lib/providerModels.js';
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
import { registerAgent } from './cosAgentLifecycle.js';
import { createAgentRun } from './agentRunTracking.js';
import { isTruthyMeta, useRunner } from './agentState.js';
import { cloudSwarmThreadCapacity, localEndpointOfProvider, providerBaseUrl } from './cosLocalEndpointSlots.js';
import { describeLocalPromptBudget, planLocalPromptBudget } from '../lib/localPromptBudget.js';
import { resolveAgentProviderAndModel } from './agentProviderResolution.js';
import { prepareAgentWorkspace } from './agentWorkspacePrep.js';
import { buildClaim } from './cosTaskClaim.js';
import { cosEvents, emitLog } from './cosEvents.js';

const ROOT_DIR = PATHS.root;
const AGENTS_DIR = PATHS.cosAgents;

export async function dispatchAgentRun(context, { spawnViaRunner } = {}) {
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
  const { provider, selectedModel, modelSelection } = resolution;
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
  const dispatchUseRunner = (publicReview || hasCredentialBootstrap(provider)) ? false : useRunner;
  let publicReviewPromptData = null;

  const prep = await prepareAgentWorkspace({ agentId, task });
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
  const promptResult = privateSecurity ? privatePrompt : await buildAgentPrompt(task, config, workspacePath, worktreeInfo, isTruthyMeta, {
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
  const requestedProvider = applyTaskGenerationOverrides(provider, task.metadata);
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

  const agentDir = join(AGENTS_DIR, agentId);
  if (!existsSync(agentDir)) {
    await ensureDir(agentDir);
  }
  await writeFileGuarded(join(agentDir, 'prompt.txt'), prompt);
  let systemPromptFile = null;
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
  });
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
    isTruthyMetaFn: isTruthyMeta,
  });
  const claimFlowTask = isClaimFlowTask(task, isTruthyMeta);
  const [forgeTarget, primaryCheckoutBaseline] = await Promise.all([
    resolvedApp
      ? resolveAppForgeTarget(resolvedApp, { repoPath: workspacePath }).then(r => r.target)
      : resolveRepoForgeTarget(workspacePath),
    sourceWorkspace ? capturePrimaryCheckoutState(sourceWorkspace) : null,
  ]);
  await registerAgent(agentId, task.id, buildAgentRegistration({
    task,
    provider,
    instanceId,
    workspacePath,
    sourceWorkspace,
    repoIssueUrl: repoIssueUrlBase(forgeTarget),
    primaryCheckoutBaseline,
    worktreeInfo,
    explicitWorktree,
    jiraBranchName,
    providerEndpoint: providerBaseUrl(provider),
    localPromptBudget,
    leanMode,
    prOpenedBy,
    claimFlowTask,
    selectedModel,
    effort: taskEffort,
    modelSelection,
    runId,
    dispatchUseRunner,
    executionMode,
    publicReviewPosture,
    resolvedAppName,
    isTruthyMetaFn: isTruthyMeta,
  }));

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
  }, task.taskType || 'user')
    .catch(err => {
      console.error(`❌ Failed to mark task ${task.id} as in_progress: ${err.message}`);
      return null;
    });
  if (updateResult?.error) {
    emitLog('warn', `⚠️ in_progress claim for task ${task.id} returned an error (taskType=${task.taskType}): ${updateResult.error}`, { taskId: task.id, error: updateResult.error });
  }
  if (!updateResult) {
    await context.cleanupOnError('Failed to update task status');
    return null;
  }

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
      task,
      prompt,
      workspacePath,
      model: selectedModel,
      provider: runProvider,
      runId,
      tuiConfig: cliConfig,
      agentDir,
      executionId: toolExecution.id,
      laneName,
      isTruthyMetaFn: isTruthyMeta,
      leanMode,
      prOpenedBy,
      useDurableRunner: dispatchUseRunner,
      safetyProfile,
    });
  }
  if (dispatchUseRunner) {
    return await spawnViaRunner(agentId, task, { prompt, workspacePath, model: selectedModel, provider: runProvider, runId, cliConfig, executionId: toolExecution.id, laneName });
  }
  return await spawnDirectly({
    agentId,
    task,
    prompt,
    workspacePath,
    model: selectedModel,
    provider: runProvider,
    runId,
    cliConfig,
    agentDir,
    executionId: toolExecution.id,
    laneName,
    isTruthyMetaFn: isTruthyMeta,
    prOpenedBy,
    safetyProfile,
  });
}
