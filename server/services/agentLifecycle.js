/**
 * Agent Lifecycle
 *
 * Handles agent spawning, runner synchronization, pipeline progression,
 * agent completion, and worktree cleanup.
 */

import { join } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { cosEvents, emitLog } from './cosEvents.js';
import { registerAgent, updateAgent, completeAgent } from './cosAgents.js';
import { getConfig, updateTask, getTaskById } from './cos.js';
import { spawnAgentViaRunner, getActiveAgentsFromRunner, getRunnerHealth } from './cosRunnerClient.js';
import { getActiveProvider } from './providers.js';
import { markProviderUsageLimit, markProviderRateLimited } from './providerStatus.js';
import { MAX_TOTAL_SPAWNS, normalizeReviewers } from '../lib/validation.js';
import { isInternalTaskId } from '../lib/taskParser.js';
import { ensureDir, PATHS, tryReadFile } from '../lib/fileUtils.js';
import { createToolExecution, startExecution, completeExecution, errorExecution } from './toolStateMachine.js';
import { determineLane, acquire, release } from './executionLanes.js';
import { analyzeAgentFailure, resolveFailedTaskUpdate } from './agentErrorAnalysis.js';
import { createAgentRun, completeAgentRun, checkForTaskCommit } from './agentRunTracking.js';
import { buildAgentPrompt, getAppWorkspace } from './agentPromptBuilder.js';
import { buildCliSpawnConfig, isClaudeCliProvider, isTuiProvider, getClaudeSettingsEnv, spawnDirectly } from './agentCliSpawning.js';
import { extractCodexAssistantTail } from '../lib/codexAssistantExtract.js';
import { buildTuiSpawnConfig, spawnTuiAgent } from './agentTuiSpawning.js';
import { processAgentCompletion } from './agentCompletion.js';
import { releaseAppReviewMarker } from './appActivity.js';
import { ensureInstanceId } from './instances.js';
import { isClaimableBy, buildClaim, buildRelease, getClaimOwner } from './cosTaskClaim.js';
import { runnerAgents, pausedAgents, spawningTasks, useRunner, isTruthyMeta } from './agentState.js';
import { v4 as uuidv4 } from '../lib/uuid.js';

// Extracted helpers — these carve the two giant orchestrators
// (spawnAgentForTask / handleAgentCompletion) into focused, testable modules.
// The worktree-cleanup cluster and handlePipelineProgression are re-exported
// below so existing consumers (subAgentSpawner, agentManagement) that import
// them from agentLifecycle.js keep working.
import { resolveAgentProviderAndModel } from './agentProviderResolution.js';
import { prepareAgentWorkspace } from './agentWorkspacePrep.js';
import { cleanupAgentWorktree } from './agentWorktreeCleanup.js';
import { runAgentCompletionCleanup } from './agentCompletionCleanup.js';

// Re-export the moved functions so existing consumers (subAgentSpawner,
// agentManagement) keep importing them from agentLifecycle.js. cleanupAgentWorktree
// is also used internally (passed as cleanupWorktreeFn to the spawn helpers), so it
// stays imported above; the rest are pure pass-throughs.
export { cleanupAgentWorktree };
export { spawnReviewLoopFollowUp, spawnMergeRecoveryTask } from './agentWorktreeCleanup.js';
export { handlePipelineProgression } from './agentCompletionCleanup.js';

const ROOT_DIR = PATHS.root;
const AGENTS_DIR = PATHS.cosAgents;


/**
 * Sync running agents from the runner (recovery after server restart).
 * This allows us to receive completion events for agents spawned before restart.
 */
export async function syncRunnerAgents() {
  const agents = await getActiveAgentsFromRunner().catch(err => {
    console.error(`❌ Failed to get active agents from runner: ${err.message}`);
    return [];
  });
  if (agents.length === 0) return 0;

  console.log(`🔄 Syncing ${agents.length} running agents from CoS Runner`);

  // Get all tasks to find task data for each agent
  const { getAllTasks } = await import('./cos.js');
  const allTasksData = await getAllTasks().catch(() => ({ user: {}, cos: {} }));

  // Build a task lookup map from all task sources, tagging each with its taskType
  const taskMap = new Map();
  const addTasks = (groupedTasks, taskType) => {
    if (!groupedTasks) return;
    for (const tasks of Object.values(groupedTasks)) {
      if (Array.isArray(tasks)) {
        for (const task of tasks) {
          taskMap.set(task.id, { ...task, taskType });
        }
      }
    }
  };

  addTasks(allTasksData.user?.grouped, 'user');
  addTasks(allTasksData.cos?.grouped, 'internal');

  let syncedCount = 0;
  for (const agent of agents) {
    // Only sync if not already tracked
    if (!runnerAgents.has(agent.id)) {
      const task = taskMap.get(agent.taskId);

      const inferredType = isInternalTaskId(agent.taskId) ? 'internal' : 'user';
      runnerAgents.set(agent.id, {
        taskId: agent.taskId,
        task: task || { id: agent.taskId, taskType: inferredType, description: 'Recovered from runner' },
        runId: null, // Run tracking may be lost on restart
        model: null,
        hasStartedWorking: true,
        startedAt: agent.startedAt
      });
      console.log(`🔄 Recovered agent ${agent.id} (task: ${agent.taskId})`);
      syncedCount++;
    }
  }

  return syncedCount;
}

/**
 * Spawn an agent for a task.
 */
export async function spawnAgentForTask(task) {
  if (spawningTasks.has(task.id)) {
    console.log(`⚠️ Task ${task.id} already being spawned, skipping duplicate`);
    return null;
  }

  // Acquire the in-process dedup guard SYNCHRONOUSLY — before any `await` below.
  // A `task:ready` re-emit for the same task id can land while this call is
  // suspended at an await (e.g. `ensureInstanceId()` / `getTaskById()`), and
  // EventEmitter does not serialize async listeners, so a guard taken after an
  // await would let a second call slip past the `has()` check above and spawn a
  // duplicate agent (codex review). Every early `return null` below releases it.
  spawningTasks.add(task.id);

  // Cross-instance claim guard (issue #1563, acceptance criterion 2). When this
  // task list is shared with a federated peer (full-sync mode, #1561), the peer
  // may already be working this task. Refuse to spawn while another instance
  // holds a live lease — otherwise both peers spawn an agent for the same task,
  // create conflicting `cos/<taskId>/<agentId>` worktrees on the same repo, and
  // race the orphan-reset. This is a cheap, no-I/O fast-reject on the dequeued
  // task; the authoritative acquire-with-fresh-reread happens below, before any
  // spawn setup. No-op for a non-federated install (no claim metadata) and for
  // re-claiming our own task on retry/resume.
  // Resolve identity defensively: this runs after `spawningTasks.add` but before
  // the main try/finally, so an uncaught rejection (e.g. cold-start identity
  // creation failing to write data/instances.json) would exit with the task id
  // stranded in `spawningTasks`, blocking every future spawn of it until restart
  // (codex review). Release the guard on failure.
  let instanceId;
  try {
    instanceId = await ensureInstanceId();
  } catch (err) {
    spawningTasks.delete(task.id);
    emitLog('error', `Failed to resolve instance identity for task ${task.id}: ${err?.message || err}`, { taskId: task.id });
    return null;
  }
  if (!isClaimableBy(task.metadata, instanceId)) {
    spawningTasks.delete(task.id);
    console.log(`🔒 Task ${task.id} is claimed by instance ${getClaimOwner(task.metadata)} (live lease) — skipping spawn on ${instanceId}`);
    return null;
  }

  // Check total spawn count across all retry types to prevent runaway respawning
  const totalSpawns = Number(task.metadata?.totalSpawnCount) || 0;
  if (totalSpawns >= MAX_TOTAL_SPAWNS) {
    spawningTasks.delete(task.id);
    console.log(`🚫 Task ${task.id} hit max total spawns (${totalSpawns}/${MAX_TOTAL_SPAWNS}), blocking`);
    await updateTask(task.id, {
      status: 'blocked',
      metadata: {
        ...task.metadata,
        blockedReason: `Max total spawns exceeded (${totalSpawns}/${MAX_TOTAL_SPAWNS})`,
        blockedCategory: 'max-spawns',
        blockedAt: new Date().toISOString()
      }
    }, task.taskType || 'user').catch(() => {});
    // Give up on this task — release the synthetic app-review marker so the app
    // doesn't read "in review" forever (issue #989). No-op without metadata.app
    // or when a real agent holds the marker.
    await releaseAppReviewMarker(task.metadata?.app).catch(() => {});
    return null;
  }

  const agentId = `agent-${uuidv4().slice(0, 8)}`;

  // Tag agent with execution lane (priority/observability only — concurrency
  // is gated upstream by maxConcurrentAgents + maxConcurrentAgentsPerProject).
  const laneName = determineLane(task);
  const laneResult = acquire(laneName, agentId, { taskId: task.id });
  if (!laneResult.success) {
    spawningTasks.delete(task.id);
    emitLog('warn', `Failed to tag lane ${laneName}: ${laneResult.error}`, { taskId: task.id });
    await releaseAppReviewMarker(task.metadata?.app).catch(() => {});
    return null;
  }

  // Create tool execution for state tracking
  const toolExecution = createToolExecution('agent-spawn', agentId, {
    taskId: task.id,
    lane: laneName,
    priority: task.priority
  });
  startExecution(toolExecution.id);

  // Set once the federation claim has been persisted (just below). cleanupOnError
  // reads it to release the claim on any failed-setup early exit.
  let claimAcquired = false;

  // Helper to cleanup on early exit. Releases the dedup guard, the execution
  // lane, and the tool-execution state — and the synthetic app-review marker
  // bound by `bindAppReviewAgent` before this spawn. Without the marker
  // release, a pre-completion `return null` (provider resolution, prep
  // deferred/blocked, in_progress updateTask failure) strands the app reading
  // "in review" until the next daemon restart (issue #989). The release is a
  // no-op when the task carries no `metadata.app` or the marker is a real
  // `agent-*` id from a different live agent.
  const cleanupOnError = async (error) => {
    spawningTasks.delete(task.id);
    release(agentId);
    errorExecution(toolExecution.id, { message: error });
    completeExecution(toolExecution.id, { success: false });
    // Release the federation claim acquired before setup (issue #1563) so a
    // failed spawn never strands the task as claimed-but-not-running, which
    // would block both this instance's retry and a peer for a full lease window.
    if (claimAcquired) {
      await updateTask(task.id, { metadata: buildRelease() }, task.taskType || 'user').catch(() => {});
    }
    await releaseAppReviewMarker(task.metadata?.app).catch(err => {
      emitLog('warn', `Failed to release app review marker for ${task.metadata?.app}: ${err.message}`, { taskId: task.id });
    });
  };

  // Acquire the federation lease BEFORE any spawn setup (issue #1563, addressing
  // the codex review: the claim must be taken up front, not at the in_progress
  // flip after worktree/agent registration). Re-read the freshest persisted task
  // so a peer's claim that synced in since this `task` was dequeued is honored,
  // then write our claim immediately. Acquiring up front — rather than after
  // setup — narrows the cross-peer window in which both instances pass the check
  // and spawn, and the fresh re-read means we never clobber a claim that landed
  // during the gap. cleanupOnError releases it on any failed-setup exit. (Full
  // cross-machine atomicity completes with the task-record sync wiring in #1650;
  // within one install the `spawningTasks` guard already prevents duplicates.)
  const freshTask = await getTaskById(task.id).catch(() => null);
  if (freshTask) {
    // The task is persisted — honor a peer's claim that synced in since dispatch,
    // then take the lease up front.
    if (!isClaimableBy(freshTask.metadata, instanceId)) {
      console.log(`🔒 Task ${task.id} was claimed by instance ${getClaimOwner(freshTask.metadata)} during dispatch — yielding on ${instanceId}`);
      await cleanupOnError('claimed by another instance');
      return null;
    }
    const claimUpdate = await updateTask(task.id, {
      metadata: buildClaim(instanceId)
    }, task.taskType || 'user').catch(() => null);
    if (claimUpdate && !claimUpdate.error) {
      claimAcquired = true;
      // Keep the in-memory task's metadata in sync with the persisted claim so
      // the downstream in_progress update merges against the freshest shape.
      task.metadata = claimUpdate.metadata;
    }
    // If the claim write failed, fall through: the in_progress update below still
    // stamps the claim, preserving the prior single-write behavior for any task
    // shape that isn't separately updatable here.
  }
  // A not-yet-persisted task (getTaskById miss) falls through unchanged — its
  // claim is stamped at the in_progress update below, exactly as before.

  // Single try wraps setup + the spawn handoff so all locals stay in
  // scope. The `handedOff` flag tells the catch arm which kind of
  // failure we're recovering from:
  //
  // - `handedOff === false` (pre-spawn): any uncaught throw from
  //   buildAgentPrompt / writeFile / createAgentRun / registerAgent /
  //   worktree + JIRA provisioning. Release the dedup guard, the
  //   execution lane, and the tool-execution state; without this, a
  //   throw mid-setup leaks `spawningTasks` and permanently blocks
  //   re-spawns of that task id until process restart. Also re-emit
  //   `job:spawn-failed` for autonomous-job tasks so cos.js can clear
  //   its job-level guard immediately instead of waiting 5 minutes.
  //
  // - `handedOff === true` (post-handoff): the rejection came from
  //   spawnTuiAgent / spawnViaRunner / spawnDirectly, which may have
  //   created a live runner agent or child process. Re-throw so the
  //   caller (subAgentSpawner's task:ready listener) handles it as
  //   pre-fix; the spawn helper owns lane/execution cleanup via its
  //   child's `on('error')` handler.
  let handedOff = false;
  try {
    // Get configuration
    const config = await getConfig();
    // Resolve provider (with availability/fallback + user override) and the
    // per-task model. A resolvable failure returns { ok: false } so we can
    // fire cleanupOnError + the matching agent:error event here, where the
    // spawn-local guard/lane/execution state lives.
    const resolution = await resolveAgentProviderAndModel(task);
    if (!resolution.ok) {
      await cleanupOnError(resolution.error);
      cosEvents.emit('agent:error', {
        taskId: task.id,
        error: resolution.error,
        ...(resolution.providerId && { providerId: resolution.providerId }),
        ...(resolution.providerStatus && { providerStatus: resolution.providerStatus }),
      });
      return null;
    }
    const { provider, selectedModel, modelSelection } = resolution;

    // Resolve the workspace and provision any worktree / JIRA branch the task
    // needs. A git conflict defers the task; an explicitly-requested worktree
    // that fails to create blocks it. Both outcomes are finished here so the
    // dedup guard / lane / execution state are released consistently.
    const prep = await prepareAgentWorkspace({ agentId, task });
    if (prep.outcome === 'deferred') {
      await cleanupOnError(prep.reason);
      cosEvents.emit('agent:deferred', { taskId: task.id, reason: prep.deferReason, branch: prep.branch });
      return null;
    }
    if (prep.outcome === 'blocked') {
      await cleanupOnError(prep.reason);
      cosEvents.emit('agent:error', { taskId: task.id, error: prep.reason });
      return null;
    }
    const { workspacePath, resolvedAppName, worktreeInfo, jiraTicket, jiraBranchName, explicitWorktree } = prep;

    const isTui = isTuiProvider(provider);

    // Build the agent prompt. `provider.type` drives the light-vs-full split
    // inside buildAgentPrompt — see its doc comment.
    const prompt = await buildAgentPrompt(task, config, workspacePath, worktreeInfo, isTruthyMeta, {
      providerType: provider.type,
      providerId: provider.id,
      providerCommand: provider.command
    });

    // Create agent directory
    const agentDir = join(AGENTS_DIR, agentId);
    if (!existsSync(agentDir)) {
      await ensureDir(agentDir);
    }

    // Save prompt to file
    await writeFile(join(agentDir, 'prompt.txt'), prompt);

    // Create run entry for usage tracking
    const { runId } = await createAgentRun(agentId, task, selectedModel, provider, workspacePath, resolvedAppName);
    const executionMode = isTui ? 'tui' : useRunner ? 'runner' : 'direct';

    // Register the agent with model info.
    //
    // `instanceId` stamps the producing machine's federation identity onto every
    // spawned agent (issue #1563, acceptance criterion 1). It flows through to
    // the completed-agent archive's `metadata.json` automatically (completeAgent
    // serializes `.metadata`), so once CoS agent history federates across peers a
    // node pair can attribute each agent + its worktree branch to the instance
    // that produced it.
    //
    // `instanceId` was resolved up front via `ensureInstanceId()` for the claim
    // guard, and is reused here so the warm-path cached read happens once.
    await registerAgent(agentId, task.id, {
      instanceId,
      workspacePath,
      sourceWorkspace: worktreeInfo ? (task.metadata?.app ? await getAppWorkspace(task.metadata.app) : ROOT_DIR) : null,
      worktreeBranch: worktreeInfo?.branchName || null,
      isWorktree: !!worktreeInfo,
      isPersistentWorktree: !!worktreeInfo?.isPersistentWorktree,
      taskDescription: task.description,
      taskType: task.taskType,
      priority: task.priority,
      providerId: provider.id,
      model: selectedModel,
      modelTier: modelSelection.tier,
      modelReason: modelSelection.reason,
      runId,
      phase: 'initializing',
      useRunner: isTui ? false : useRunner,
      executionMode,
      taskAnalysisType: task.metadata?.analysisType || null,
      taskReviewType: task.metadata?.reviewType || null,
      taskApp: task.metadata?.app || null,
      taskAppName: resolvedAppName,
      selfImprovementType: task.metadata?.selfImprovementType || null,
      jobId: task.metadata?.jobId || null,
      missionName: task.metadata?.missionName || null,
      missionId: task.metadata?.missionId || null,
      jiraTicketId: task.metadata?.jiraTicketId || null,
      jiraTicketUrl: task.metadata?.jiraTicketUrl || null,
      jiraBranch: task.metadata?.jiraBranch || null,
      jiraInstanceId: task.metadata?.jiraInstanceId || null,
      jiraCreatePR: task.metadata?.jiraCreatePR ?? null,
      configOpenPR: isTruthyMeta(task.metadata?.openPR),
      configSimplify: isTruthyMeta(task.metadata?.simplify),
      configReviewLoop: isTruthyMeta(task.metadata?.reviewLoop),
      configReviewers: normalizeReviewers(task.metadata),
      configUseWorktree: !!worktreeInfo,
      configWorktreeAutoDetected: !!worktreeInfo && !explicitWorktree,
      configCodingOnMain: !worktreeInfo && !jiraBranchName
    });

    emitLog('info', `Agent ${agentId} initializing...${worktreeInfo ? ' (worktree)' : ''}${jiraBranchName ? ` (JIRA: ${jiraTicket?.ticketId})` : ''}`, { agentId, taskId: task.id });

    // Mark the task as in_progress, increment the total spawn count, and refresh
    // the federation claim (issue #1563). The claim was already acquired up front
    // (above); re-stamping it here renews the lease at the moment the agent
    // actually spawns. A federated peer sharing this task list sees the task as
    // live-claimed and backs off (the orphan-reset honors the same lease). The
    // lease is then renewed on the health-check heartbeat while the agent runs,
    // and released when the task leaves `in_progress`.
    const newSpawnCount = (Number(task.metadata?.totalSpawnCount) || 0) + 1;
    const updateResult = await updateTask(task.id, {
      status: 'in_progress',
      metadata: {
        ...task.metadata,
        totalSpawnCount: newSpawnCount,
        lastSpawnedAt: new Date().toISOString(),
        ...buildClaim(instanceId)
      }
    }, task.taskType || 'user')
      .catch(err => {
        console.error(`❌ Failed to mark task ${task.id} as in_progress: ${err.message}`);
        return null;
      });
    if (!updateResult) {
      await cleanupOnError('Failed to update task status');
      return null;
    }

    // Record autonomous job execution now that the task is confirmed spawning
    if (task.metadata?.autonomousJob && task.metadata?.jobId) {
      cosEvents.emit('job:spawned', { jobId: task.metadata.jobId });
    }

    // Read ~/.claude/settings.json env BEFORE building the argv so the Bedrock
    // model-id mapping in buildCliSpawnConfig sees the same CLAUDE_CODE_USE_BEDROCK
    // the child is actually spawned with (the spawn helpers merge this env too).
    // Without it, a host that supplies Bedrock mode only via settings.json would
    // bake a bare, Bedrock-invalid --model into the argv. Cached (5-min TTL), so
    // the spawn helper's own getClaudeSettingsEnv() call is effectively free.
    const cliSettingsEnv = isClaudeCliProvider(provider) ? await getClaudeSettingsEnv() : {};
    const cliConfig = isTui
      ? buildTuiSpawnConfig(provider, selectedModel)
      : buildCliSpawnConfig(provider, selectedModel, cliSettingsEnv);

    emitLog('success', `Spawning agent for task ${task.id}`, {
      agentId,
      model: selectedModel,
      mode: executionMode,
      cli: cliConfig.command,
      lane: laneName,
      worktree: !!worktreeInfo
    });

    // Dedup-window fix: keep the `spawningTasks` guard active across the
    // actual spawn call, not just up to the in_progress flip. Releasing
    // between `updateTask` and `spawnViaRunner` / `spawnDirectly` opened a
    // window where a concurrent `spawnAgentForTask(task)` call (e.g. a
    // re-fired `task:ready` from a follow-up scheduler tick) saw an empty
    // set and a task whose registered agent hadn't yet been queued to the
    // runner, and proceeded to spawn a second agent for the same task id.
    // The outer finally below releases the guard whether the spawn returns
    // normally or rejects. release() must NOT run here on the success
    // path; the lane is released by the agent-completion handler when the
    // work finishes.
    handedOff = true;
    if (isTui) {
      return await spawnTuiAgent({
        agentId,
        task,
        prompt,
        workspacePath,
        model: selectedModel,
        provider,
        runId,
        tuiConfig: cliConfig,
        agentDir,
        executionId: toolExecution.id,
        laneName,
        cleanupWorktreeFn: cleanupAgentWorktree,
        isTruthyMetaFn: isTruthyMeta,
      });
    }
    if (useRunner) {
      return await spawnViaRunner(agentId, task, { prompt, workspacePath, model: selectedModel, provider, runId, cliConfig, executionId: toolExecution.id, laneName });
    }
    // Direct spawn mode (fallback)
    return await spawnDirectly({
      agentId,
      task,
      prompt,
      workspacePath,
      model: selectedModel,
      provider,
      runId,
      cliConfig,
      agentDir,
      executionId: toolExecution.id,
      laneName,
      cleanupWorktreeFn: cleanupAgentWorktree,
      isTruthyMetaFn: isTruthyMeta,
    });
  } catch (err) {
    if (handedOff) {
      // Spawn helper rejected — may have created a live runner agent or
      // child process. Re-throw so the caller (subAgentSpawner's
      // task:ready listener) handles it as pre-fix; the spawn helper
      // owns lane/execution cleanup via its child's `on('error')`
      // handler. The finally still releases the dedup guard.
      throw err;
    }
    emitLog('error', `Agent spawn setup failed: ${err.message}`, { taskId: task.id, error: err.message });
    await cleanupOnError(err.message);
    cosEvents.emit('agent:error', { taskId: task.id, error: err.message });
    // Preserve the autonomous-job retry contract. Pre-widening, an uncaught
    // throw here propagated to subAgentSpawner's `task:ready` listener,
    // which emitted `job:spawn-failed` so cos.js could clear
    // `spawningJobIds` and re-register the cron schedule.
    if (task.metadata?.jobId) {
      cosEvents.emit('job:spawn-failed', { jobId: task.metadata.jobId });
    }
    return null;
  } finally {
    spawningTasks.delete(task.id);
  }
}

/**
 * Minimum runner uptime (seconds) before spawning agents.
 * Prevents race condition during rolling restarts where server starts
 * before runner, spawns an agent, then runner restarts and orphans it.
 */
const RUNNER_MIN_UPTIME_SECONDS = 10;

/**
 * Wait for runner to be stable (sufficient uptime) before spawning.
 */
export async function waitForRunnerStability() {
  const maxWaitMs = 15000;
  const checkIntervalMs = 1000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const health = await getRunnerHealth();
    if (health.available && health.uptime >= RUNNER_MIN_UPTIME_SECONDS) {
      return true;
    }
    if (health.available && health.uptime < RUNNER_MIN_UPTIME_SECONDS) {
      const waitTime = Math.ceil(RUNNER_MIN_UPTIME_SECONDS - health.uptime);
      emitLog('info', `Waiting ${waitTime}s for runner stability (uptime: ${Math.floor(health.uptime)}s)`, { uptime: health.uptime });
    }
    await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
  }

  emitLog('warn', 'Runner stability check timed out, proceeding anyway', {});
  return false;
}

/**
 * Spawn agent via CoS Runner (isolated PM2 process).
 */
export async function spawnViaRunner(agentId, task, opts) {
  const { prompt, workspacePath, model, provider, runId, cliConfig, executionId, laneName } = opts;
  // Wait for runner to be stable to prevent orphaned agents during rolling restarts
  await waitForRunnerStability();

  const agentInfo = {
    taskId: task.id,
    task,
    runId,
    model,
    providerId: provider.id,
    hasStartedWorking: false,
    startedAt: Date.now(),
    initializationTimeout: null,
    executionId,
    laneName,
    workspacePath
  };
  runnerAgents.set(agentId, agentInfo);

  // If no output after 3 seconds, transition from initializing to working to show progress
  agentInfo.initializationTimeout = setTimeout(async () => {
    try {
      const agent = runnerAgents.get(agentId);
      if (agent && !agent.hasStartedWorking) {
        agent.hasStartedWorking = true;
        await updateAgent(agentId, { metadata: { phase: 'working' } });
        emitLog('info', `Agent ${agentId} working (after initialization delay)...`, { agentId, phase: 'working' });
      }
    } catch (err) {
      console.error(`❌ agentLifecycle init timeout failed for ${agentId}: ${err.message}`);
    }
  }, 3000);

  // For Claude CLI providers, merge ~/.claude/settings.json env vars so Bedrock config is present
  const claudeSettingsEnv = isClaudeCliProvider(provider)
    ? await getClaudeSettingsEnv()
    : {};

  const result = await spawnAgentViaRunner({
    agentId,
    taskId: task.id,
    prompt,
    workspacePath,
    model,
    envVars: { ...claudeSettingsEnv, ...provider.envVars },
    cliCommand: cliConfig.command,
    cliArgs: cliConfig.args
  });

  // Store PID in persisted state for zombie detection
  await updateAgent(agentId, { pid: result.pid });

  emitLog('info', `Agent ${agentId} spawned via runner (PID: ${result.pid})`, { agentId, pid: result.pid });
  return agentId;
}

/**
 * Extract the final summary section from agent output.
 * Walks backwards from the end to find the last block of non-tool-call content.
 */
export function extractFinalSummary(outputBuffer) {
  if (!outputBuffer) return null;

  const codexTail = extractCodexAssistantTail(outputBuffer);
  if (codexTail) return codexTail;

  const lines = outputBuffer.split('\n');
  const contentLines = [];
  let foundContent = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const isTool = line.startsWith('🔧') || line.startsWith('  →') || line.startsWith('  ↳') || line.startsWith('[stderr]');

    if (!isTool && line.trim()) {
      contentLines.unshift(line);
      foundContent = true;
    } else if (foundContent && isTool) {
      break;
    }
  }

  const summary = contentLines.join('\n').trim();
  return summary || null;
}

const RE_SIMPLIFY_MARKER = /\/simplify/;
const RE_SIMPLIFY_ACTION = /\b(run|running|launch|now)\b/i;

export function extractSimplifySummaries(outputBuffer) {
  if (!outputBuffer) return null;

  // Codex CLI cannot execute slash commands like /simplify, so any match
  // inside its output is from a diff/grep dump that quotes source code.
  // Treat the assistant tail as the task summary and skip the simplify split.
  const codexTail = extractCodexAssistantTail(outputBuffer);
  if (codexTail) return { taskSummary: codexTail, simplifySummary: null };

  const lines = outputBuffer.split('\n');
  let simplifyIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (RE_SIMPLIFY_MARKER.test(lines[i]) && RE_SIMPLIFY_ACTION.test(lines[i])) {
      simplifyIdx = i;
      break;
    }
  }
  if (simplifyIdx < 0) return null;

  const taskSummary = extractFinalSummary(lines.slice(0, simplifyIdx).join('\n'));
  const simplifySummary = extractFinalSummary(lines.slice(simplifyIdx + 1).join('\n'));
  return { taskSummary, simplifySummary };
}

/**
 * Release the execution lane and complete tool-execution tracking for a
 * finishing agent. Pulled OUT of finalizeAgent so callers can fire it
 * EARLY (before reading output.txt, running error analysis, or writing
 * state) — neither call blocks on I/O, but lanes serialize related work
 * and we don't want them held longer than necessary.
 *
 * Idempotent enough to be a no-op when laneName / executionId are absent
 * (recovered agents post-restart, error paths that already released).
 */
export function releaseAgentLane({ agentId, success, duration, exitCode, executionId, laneName, errorExecutionMessage }) {
  if (laneName) release(agentId);
  if (!executionId) return;
  if (success) {
    completeExecution(executionId, { success: true, duration });
  } else {
    errorExecution(executionId, { message: errorExecutionMessage || `Agent exited with code ${exitCode}`, code: exitCode });
    completeExecution(executionId, { success: false });
  }
}

/**
 * Shared end-of-run state writes for all three spawn paths
 * (`handleAgentCompletion` runner-mode, TUI `finish`, direct-CLI `close`).
 * Path-specific cleanup (worktree, sentinel removal, pty kill, in-memory
 * map deletes) stays at the calling site; lane release + execution
 * tracking should fire EARLIER via `releaseAgentLane()` — this helper
 * owns the centralized state writes only.
 */
export async function finalizeAgent({
  agentId,
  task,
  runId,
  providerId,
  success,
  exitCode,
  duration,
  outputBuffer,
  errorAnalysis,
  terminatedByUser = false,
  isTruthyMetaFn,
  error,
  completionReason,
}) {
  if (success && isTruthyMetaFn) {
    await persistSimplifySummaries(agentId, task, outputBuffer, isTruthyMetaFn);
  }

  const taskType = task?.taskType || 'user';
  const taskUpdate = terminatedByUser
    ? {
      status: 'blocked',
      metadata: {
        ...task.metadata,
        blockedReason: 'Terminated by user',
        blockedCategory: 'user-terminated',
        blockedAt: new Date().toISOString(),
      },
    }
    : success
      ? { status: 'completed' }
      : await resolveFailedTaskUpdate(task, errorAnalysis, agentId);

  // Sequential by design: completeAgent + updateTask share the cosState
  // mutex (`withStateLock`) so parallelism gains nothing, AND ordering
  // matters — if completeAgent throws, we must not mark the task completed.
  // completeAgentRun writes its own runs/<id>/metadata.json (separate lock),
  // so its place in the chain is purely about progress reporting on partial
  // failure.
  await completeAgent(agentId, {
    success,
    exitCode,
    duration,
    outputLength: outputBuffer?.length ?? 0,
    errorAnalysis,
    ...(error !== undefined ? { error } : {}),
    ...(completionReason !== undefined ? { completionReason } : {}),
  });

  if (runId) {
    await completeAgentRun(runId, outputBuffer, exitCode, duration, errorAnalysis);
  }

  const taskResult = await updateTask(task.id, taskUpdate, taskType);
  if (taskResult?.error) {
    const label = terminatedByUser ? 'blocked' : success ? 'completed' : 'failed';
    emitLog('warn', `⚠️ Failed to update ${label} task ${task.id}: ${taskResult.error} (taskType=${taskType})`, { taskId: task.id, agentId, error: taskResult.error });
  }

  if (!success && !terminatedByUser && errorAnalysis) {
    // Lazy provider lookup — only resolve the active provider when a marker
    // fires AND the caller didn't already know the id. This keeps the
    // successful-completion hot path free of a settings-file read.
    const markerProviderId = errorAnalysis.category === 'usage-limit' || errorAnalysis.category === 'rate-limit'
      ? providerId || (await getActiveProvider())?.id
      : null;
    if (markerProviderId && errorAnalysis.category === 'usage-limit' && errorAnalysis.requiresFallback) {
      await markProviderUsageLimit(markerProviderId, errorAnalysis).catch(err => {
        emitLog('warn', `Failed to mark provider unavailable: ${err.message}`, { providerId: markerProviderId });
      });
    }
    if (markerProviderId && errorAnalysis.category === 'rate-limit') {
      await markProviderRateLimited(markerProviderId).catch(err => {
        emitLog('warn', `Failed to mark provider rate limited: ${err.message}`, { providerId: markerProviderId });
      });
    }
  }

  await processAgentCompletion(agentId, task, success, outputBuffer);
}

/**
 * Persist task/simplify summaries for agents that ran with /simplify.
 * Shared by handleAgentCompletion (runner mode) and spawnDirectly (direct mode).
 */
export async function persistSimplifySummaries(agentId, task, outputBuffer, isTruthyMetaFn) {
  if (!isTruthyMetaFn(task.metadata?.simplify)) return;
  const summaries = extractSimplifySummaries(outputBuffer);
  if (!summaries) return;
  // Persist whenever *either* summary is present — e.g. if the /simplify
  // marker appears at the very top of the output, taskSummary will be null
  // but simplifySummary is still worth keeping.
  if (summaries.taskSummary || summaries.simplifySummary) {
    await updateAgent(agentId, { metadata: {
      taskSummary: summaries.taskSummary || null,
      simplifySummary: summaries.simplifySummary || null
    } });
  }
}

/**
 * Extract a concise output summary for pipeline stage agents.
 * For review stages: reads the generated REVIEW.md from the workspace.
 * For implement stages: extracts the final summary from the output.
 */
export async function extractPipelineOutputSummary(task, workspacePath, outputBuffer) {
  const pipeline = task.metadata?.pipeline;
  if (!pipeline?.stages) return null;

  const currentStage = pipeline.currentStage ?? 0;
  const stage = pipeline.stages[currentStage];
  if (!stage) return null;

  const promptKey = stage.promptKey || '';

  // For review stages: read REVIEW.md from workspace (the deliverable)
  if (promptKey.includes('review') && !promptKey.includes('implement') && workspacePath) {
    const reviewPath = join(workspacePath, 'REVIEW.md');
    const content = await tryReadFile(reviewPath);
    if (content?.trim()) return content.trim();
  }

  // For implement/triage stages or fallback: extract last content section from output
  return extractFinalSummary(outputBuffer);
}

/**
 * Handle agent completion (from runner events).
 */
export async function handleAgentCompletion(agentId, exitCode, success, duration) {
  // Paused agents are finalized by markAgentPaused, not here — skip so a stray
  // completion event can't clean the worktree / complete the task out from
  // under a later resume. Mirrors the CLI/TUI close-handler pause guards.
  if (pausedAgents.has(agentId)) {
    pausedAgents.delete(agentId);
    runnerAgents.delete(agentId);
    return;
  }
  const agent = runnerAgents.get(agentId);
  if (!agent) {
    // Agent not in memory map (server restarted). Check cos state for context.
    const { getAgent: getAgentState } = await import('./cos.js');
    const cosAgent = await getAgentState(agentId).catch(() => null);
    if (!cosAgent) {
      console.log(`⚠️ Received completion for unknown agent: ${agentId} (not in cos state)`);
      return;
    }
    if (cosAgent.status === 'completed') {
      console.log(`✅ Agent ${agentId} already completed (handled by orphan cleanup)`);
      return;
    }
    // Post-restart the in-memory pausedAgents map is empty, but the persisted
    // status still says paused — don't finalize a paused agent on a stray event.
    if (cosAgent.status === 'paused') {
      console.log(`⏸️ Ignoring completion for paused agent ${agentId} (awaiting resume)`);
      return;
    }
    console.log(`🔄 Completing untracked agent ${agentId} from cos state (post-restart)`);
    await completeAgent(agentId, {
      success,
      exitCode,
      duration,
      orphaned: true,
      error: success ? undefined : 'Agent completed after server restart'
    });
    if (cosAgent.taskId) {
      const task = await getTaskById(cosAgent.taskId).catch(() => null);
      if (task && task.status !== 'completed') {
        if (success) {
          await updateTask(cosAgent.taskId, { status: 'completed' }, task.taskType || 'user');
        } else {
          // Import handleOrphanedTask dynamically to avoid circular dep with agentManagement
          const { handleOrphanedTask } = await import('./agentManagement.js');
          await handleOrphanedTask(cosAgent.taskId, agentId, getTaskById);
        }
      }
    }
    return;
  }

  const { task, runId, model, executionId, laneName } = agent;

  // try/finally so a throw from any inner step still drops the runnerAgents
  // entry — otherwise a memory-extraction crash etc. would strand it forever
  // and no future spawn could reclaim the slot.
  try {
    // Normalize the agent's task shape — recovered agents (post-restart,
    // via syncRunnerAgents) may lack taskType AND metadata, both of which
    // downstream paths spread / read without a guard.
    if (task) {
      if (!task.taskType) {
        const id = task.id || '';
        task.taskType = isInternalTaskId(id) ? 'internal' : 'user';
      }
      if (!task.metadata) task.metadata = {};
    }

    // Release the execution lane immediately — `release` is a sync Map
    // mutation, so this just frees the slot for other tasks in the same
    // lane. Tool-execution tracking is deferred until effectiveSuccess is
    // known (the post-exit commit check can flip it false→true).
    if (laneName) release(agentId);

    // Read output from agent directory
    const agentDir = join(AGENTS_DIR, agentId);
    const outputFile = join(agentDir, 'output.txt');
    let outputBuffer = '';
    if (existsSync(outputFile)) {
      outputBuffer = await readFile(outputFile, 'utf-8').catch(() => '');
    }

    // Post-execution validation: check for task commit even if exit code is non-zero
    let effectiveSuccess = success;
    if (!effectiveSuccess && task?.id) {
      const workspacePath = agent.workspacePath || ROOT_DIR;
      const commitFound = await checkForTaskCommit(task.id, workspacePath);
      if (commitFound) {
        emitLog('warn', `Agent ${agentId} reported failure (exit ${exitCode}) but work completed - commit found for task ${task.id}`, { agentId, taskId: task.id, exitCode });
        effectiveSuccess = true;
      }
    }

    // Complete tool-execution tracking with effectiveSuccess so a
    // commit-found promotion records consistently with completeAgent +
    // updateTask below.
    if (executionId) {
      if (effectiveSuccess) {
        completeExecution(executionId, { success: true, duration });
      } else {
        errorExecution(executionId, { message: `Agent exited with code ${exitCode}`, code: exitCode });
        completeExecution(executionId, { success: false });
      }
    }

    // Analyze failure if applicable
    const errorAnalysis = effectiveSuccess ? null : analyzeAgentFailure(outputBuffer, task, model);

    // Extract pipeline output summary before completion writes metadata to disk
    if (task?.metadata?.pipeline && effectiveSuccess) {
      const workspacePath = agent.workspacePath || ROOT_DIR;
      const summary = await extractPipelineOutputSummary(task, workspacePath, outputBuffer).catch(err => {
        console.log(`⚠️ Failed to extract pipeline summary for ${agentId}: ${err.message}`);
        return null;
      });
      if (summary) {
        // .catch so a metadata-write failure doesn't skip finalizeAgent —
        // pipeline summary is best-effort; lane release + completeAgent +
        // updateTask + processAgentCompletion must still run.
        await updateAgent(agentId, { metadata: { outputSummary: summary } }).catch(err => {
          emitLog('warn', `Failed to save pipeline summary for ${agentId}: ${err.message}`, { agentId });
        });
      }
    }

    // Catch + log instead of letting finalizeAgent's throw skip the rest of
    // the cleanup (JIRA push, plan-question notification, pipeline
    // progression, worktree cleanup). The error is still visible via
    // emitLog + the agent's persisted state (completeAgent runs first
    // inside finalizeAgent and is the most likely throw point — the
    // partial-state cases are best-effort by design).
    let finalizeError = null;
    try {
      await finalizeAgent({
        agentId,
        task,
        runId,
        providerId: agent.providerId,
        success: effectiveSuccess,
        exitCode,
        duration,
        outputBuffer,
        errorAnalysis,
        isTruthyMetaFn: isTruthyMeta,
      });
    } catch (err) {
      finalizeError = err;
      emitLog('error', `finalizeAgent threw for ${agentId} (continuing cleanup): ${err.message}`, { agentId, error: err.message });
    }

    // Post-finalize cleanup: JIRA push/PR/comment, plan-question marker,
    // pipeline progression, the Creative Director chain hook, and worktree
    // cleanup (+ cleanup-warning notification and merge-recovery task). Runs
    // inside this try so a throw still hits the finally below.
    await runAgentCompletionCleanup({ agentId, task, agent, effectiveSuccess, outputBuffer });

    // Surface a finalizeAgent throw to the caller after best-effort
    // cleanup completed — without this the runner harness would never see
    // the failure and couldn't requeue or alert.
    if (finalizeError) throw finalizeError;
  } finally {
    runnerAgents.delete(agentId);
  }
}
