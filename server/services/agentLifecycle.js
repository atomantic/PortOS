/**
 * Agent Lifecycle
 *
 * Handles agent spawning, runner synchronization, pipeline progression,
 * agent completion, and worktree cleanup.
 */

import { join, relative, resolve, sep } from 'path';
import { readFile, unlink, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { execGit } from '../lib/execGit.js';
import { cosEvents, emitLog } from './cosEvents.js';
import { registerAgent, updateAgent, completeAgent, appendAgentOutput } from './cosAgents.js';
import { getConfig, updateTask, addTask, getTaskById, checkStagePrecondition } from './cos.js';
import { spawnAgentViaRunner, getActiveAgentsFromRunner, getRunnerHealth } from './cosRunnerClient.js';
import { getActiveProvider, getAllProviders, getProviderById } from './providers.js';
import { isProviderAvailable, markProviderUsageLimit, markProviderRateLimited, getFallbackProvider, getProviderStatus } from './providerStatus.js';
import { PIPELINE_BEHAVIOR_FLAGS, MAX_TOTAL_SPAWNS } from '../lib/validation.js';
import { isInternalTaskId } from '../lib/taskParser.js';
import { ensureDir, PATHS, tryReadFile } from '../lib/fileUtils.js';
import { getAppById } from './apps.js';
import { createToolExecution, startExecution, completeExecution, errorExecution } from './toolStateMachine.js';
import { determineLane, acquire, release } from './executionLanes.js';
import { detectConflicts } from './taskConflict.js';
import { createWorktree, removeWorktree } from './worktreeManager.js';
import * as jiraService from './jira.js';
import * as git from './git.js';
import { RECOVERY_TASK_PREFIX } from './recoveryTasks.js';
import { analyzeAgentFailure, resolveFailedTaskUpdate } from './agentErrorAnalysis.js';
import { createAgentRun, completeAgentRun, checkForTaskCommit } from './agentRunTracking.js';
import { buildAgentPrompt, getAppWorkspace, getAppDataForTask, createJiraTicketForTask } from './agentPromptBuilder.js';
import { buildCliSpawnConfig, isClaudeCliProvider, isTuiProvider, getClaudeSettingsEnv, spawnDirectly } from './agentCliSpawning.js';
import { extractCodexAssistantTail } from '../lib/codexAssistantExtract.js';
import { buildTuiSpawnConfig, spawnTuiAgent } from './agentTuiSpawning.js';
import { selectModelForTask } from './agentModelSelection.js';
import { processAgentCompletion } from './agentCompletion.js';
import { activeAgents, runnerAgents, pausedAgents, spawningTasks, useRunner, isTruthyMeta, isFalsyMeta } from './agentState.js';
import { DEFAULT_REVIEWER, DEFAULT_REVIEWERS, DEFAULT_REVIEW_STOP_MODE, normalizeReviewers } from '../lib/validation.js';
import { resolveReviewLoopOptions } from './codeReview.js';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { writeFile } from 'fs/promises';

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

  // Check total spawn count across all retry types to prevent runaway respawning
  const totalSpawns = Number(task.metadata?.totalSpawnCount) || 0;
  if (totalSpawns >= MAX_TOTAL_SPAWNS) {
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
    return null;
  }

  spawningTasks.add(task.id);

  const agentId = `agent-${uuidv4().slice(0, 8)}`;

  // Tag agent with execution lane (priority/observability only — concurrency
  // is gated upstream by maxConcurrentAgents + maxConcurrentAgentsPerProject).
  const laneName = determineLane(task);
  const laneResult = acquire(laneName, agentId, { taskId: task.id });
  if (!laneResult.success) {
    spawningTasks.delete(task.id);
    emitLog('warn', `Failed to tag lane ${laneName}: ${laneResult.error}`, { taskId: task.id });
    return null;
  }

  // Create tool execution for state tracking
  const toolExecution = createToolExecution('agent-spawn', agentId, {
    taskId: task.id,
    lane: laneName,
    priority: task.priority
  });
  startExecution(toolExecution.id);

  // Helper to cleanup on early exit
  const cleanupOnError = (error) => {
    spawningTasks.delete(task.id);
    release(agentId);
    errorExecution(toolExecution.id, { message: error });
    completeExecution(toolExecution.id, { success: false });
  };

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
    let provider = await getActiveProvider();

    if (!provider) {
      cleanupOnError('No active AI provider configured');
      cosEvents.emit('agent:error', { taskId: task.id, error: 'No active AI provider configured' });
      return null;
    }

    // Check provider availability (usage limits, rate limits, etc.)
    const providerAvailable = isProviderAvailable(provider.id);
    if (!providerAvailable) {
      const status = getProviderStatus(provider.id);
      emitLog('warn', `Provider ${provider.id} unavailable: ${status.message}`, {
        taskId: task.id,
        providerId: provider.id,
        reason: status.reason
      });

      // Try to get a fallback provider (check task-level, then provider-level, then system default).
      // getFallbackProvider indexes its providers arg by id, so pass a map — NOT the
      // { activeProvider, providers: [...] } shape getAllProviders() returns (mirrors promptRunner.js).
      const { providers: providerList = [] } = await getAllProviders();
      const providersMap = Object.fromEntries(providerList.map((p) => [p.id, p]));
      const taskFallbackId = task.metadata?.fallbackProvider;
      const fallbackResult = await getFallbackProvider(provider.id, providersMap, taskFallbackId);

      if (fallbackResult) {
        emitLog('info', `Using fallback provider: ${fallbackResult.provider.id} (source: ${fallbackResult.source})`, {
          taskId: task.id,
          primaryProvider: provider.id,
          fallbackProvider: fallbackResult.provider.id,
          fallbackSource: fallbackResult.source
        });
        provider = fallbackResult.provider;
      } else {
        const errorMsg = `Provider ${provider.id} unavailable (${status.message}) and no fallback available`;
        cleanupOnError(errorMsg);
        cosEvents.emit('agent:error', {
          taskId: task.id,
          error: errorMsg,
          providerId: provider.id,
          providerStatus: status
        });
        return null;
      }
    }

    // Check if user specified a different provider in task metadata
    const userProviderId = task.metadata?.provider;
    if (userProviderId && userProviderId !== provider.id) {
      const userProvider = await getProviderById(userProviderId);
      if (userProvider) {
        emitLog('info', `Using user-specified provider: ${userProviderId}`, { taskId: task.id });
        provider = userProvider;
      } else {
        emitLog('warn', `User-specified provider "${userProviderId}" not found, using active provider`, { taskId: task.id });
      }
    }

    // Select optimal model for this task (async to allow learning-based suggestions)
    const modelSelection = await selectModelForTask(task, provider);
    let selectedModel = modelSelection.model;

    // Validate model is compatible with provider
    if (selectedModel && provider.models && provider.models.length > 0) {
      const modelIsValid = provider.models.includes(selectedModel);
      if (!modelIsValid) {
        emitLog('warn', `Model "${selectedModel}" not valid for provider "${provider.id}", falling back to provider default`, {
          taskId: task.id,
          requestedModel: selectedModel,
          providerId: provider.id,
          validModels: provider.models
        });
        selectedModel = modelSelection.tier === 'heavy' ? provider.heavyModel :
                        modelSelection.tier === 'light' ? provider.lightModel :
                        modelSelection.tier === 'medium' ? provider.mediumModel :
                        provider.defaultModel;
      }
    }

    const logMessage = modelSelection.learningReason
      ? `Model selection: ${selectedModel} (${modelSelection.reason} - ${modelSelection.learningReason})`
      : `Model selection: ${selectedModel} (${modelSelection.reason})`;
    emitLog('info', logMessage, {
      taskId: task.id,
      model: selectedModel,
      tier: modelSelection.tier,
      reason: modelSelection.reason,
      ...(modelSelection.learningReason && { learningReason: modelSelection.learningReason })
    });

    // Determine workspace path and resolve app name
    const isReadOnly = isTruthyMeta(task.metadata?.readOnly);
    let workspacePath = task.metadata?.app
      ? await getAppWorkspace(task.metadata.app)
      : ROOT_DIR;
    const resolvedAppName = task.metadata?.app
      ? (await getAppById(task.metadata.app).catch(() => null))?.name || null
      : null;

    let jiraTicket = null;
    let jiraBranchName = null;
    let worktreeInfo = null;
    const explicitOpenPR = isTruthyMeta(task.metadata?.openPR);
    const explicitWorktree = isTruthyMeta(task.metadata?.useWorktree) || explicitOpenPR;

    if (!isReadOnly) {
      // Pull latest from git before starting work
      const pullResult = await git.ensureLatest(workspacePath).catch(err => {
        emitLog('warn', `⚠️ Pre-task git pull failed for ${workspacePath}: ${err.message}`, { taskId: task.id, workspace: workspacePath });
        return { success: false, error: err.message };
      });

      if (pullResult.skipped) {
        emitLog('debug', `Pre-task git pull skipped: ${pullResult.skipped}`, { taskId: task.id, workspace: workspacePath });
      } else if (pullResult.conflict) {
        emitLog('warn', `🔀 Git conflict in ${workspacePath} (branch: ${pullResult.branch}): ${pullResult.error}`, {
          taskId: task.id, workspace: workspacePath, branch: pullResult.branch
        });

        const appId = task.metadata?.app || null;
        const conflictDesc = `Resolve git conflict in ${resolvedAppName || workspacePath} on branch ${pullResult.branch}. `
          + `The branch has diverged from origin and automatic rebase failed. `
          + `Error: ${pullResult.error}`;

        await addTask({
          description: conflictDesc,
          priority: 'HIGH',
          app: appId,
          context: `This conflict is blocking task ${task.id}: "${task.description}". `
            + `Resolve the conflict, commit, and push so the blocked task can proceed.`,
          position: 'top'
        }, 'internal').catch(err => {
          emitLog('warn', `Failed to create conflict resolution task: ${err.message}`, { taskId: task.id });
        });

        await updateTask(task.id, { status: 'pending' }, task.taskType || 'user').catch(() => {});
        cleanupOnError(`Git conflict blocks task — conflict resolution task created`);
        cosEvents.emit('agent:deferred', { taskId: task.id, reason: 'git-conflict', branch: pullResult.branch });
        return null;
      } else if (pullResult.success && !pullResult.upToDate && !pullResult.skipped) {
        emitLog('info', `📥 Pulled latest for ${resolvedAppName || 'workspace'} (branch: ${pullResult.branch})`, {
          taskId: task.id, workspace: workspacePath, branch: pullResult.branch
        });
      } else if (!pullResult.success) {
        emitLog('warn', `⚠️ Pre-task git pull error: ${pullResult.error}`, { taskId: task.id, workspace: workspacePath });
      }

      // JIRA integration: create ticket + feature branch if app has JIRA enabled and task opted in
      const appData = await getAppDataForTask(task);

      if (appData?.jira?.enabled && task.metadata?.createJiraTicket) {
        jiraTicket = await createJiraTicketForTask(task, appData);

        if (jiraTicket) {
          const slug = (task.description || 'task')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .substring(0, 40);
          jiraBranchName = `feature/${jiraTicket.ticketId}-${slug}`;

          if (task.metadata?.app) {
            await git.fetchOrigin(workspacePath).catch(() => {});
            const { baseBranch: defaultBranch } = await git.getRepoBranches(workspacePath).catch(() => ({ baseBranch: null }));
            if (defaultBranch) {
              await git.checkout(workspacePath, defaultBranch).catch(() => {});
              await execGit(['merge', '--ff-only', `origin/${defaultBranch}`], workspacePath).catch(err => { emitLog('warn', `Fast-forward merge of ${defaultBranch} failed: ${err.message}`, { taskId: task.id }); });
            }
          }

          await git.createBranch(workspacePath, jiraBranchName).catch(err => {
            emitLog('warn', `Failed to create JIRA branch ${jiraBranchName}: ${err.message}`, { taskId: task.id });
            jiraBranchName = null;
          });

          if (jiraBranchName) {
            emitLog('success', `Created feature branch ${jiraBranchName}`, { taskId: task.id, ticketId: jiraTicket.ticketId });
          }

          task.metadata = {
            ...task.metadata,
            jiraTicketId: jiraTicket.ticketId,
            jiraTicketUrl: jiraTicket.ticketUrl,
            jiraBranch: jiraBranchName,
            jiraInstanceId: appData.jira.instanceId,
            jiraCreatePR: appData.jira.createPR !== false
          };
        }
      }

      // Feature agent tasks: use persistent worktree instead of creating a new one
      if (task.metadata?.featureAgentRun && task.metadata?.featureAgentId) {
        const { getFeatureAgent } = await import('./featureAgents.js');
        const fa = await getFeatureAgent(task.metadata.featureAgentId).catch(() => null);
        if (fa) {
          const faWorktreePath = join(PATHS.cos, 'feature-agents', fa.id, 'worktree');
          if (existsSync(faWorktreePath)) {
            workspacePath = faWorktreePath;
            worktreeInfo = {
              worktreePath: faWorktreePath,
              branchName: fa.git.branchName,
              baseBranch: fa.git.baseBranch || 'main',
              isPersistentWorktree: true
            };
            const { mergeBaseIntoFeatureWorktree } = await import('./worktreeManager.js');
            if (fa.git.autoMergeBase) {
              await mergeBaseIntoFeatureWorktree(fa.id, fa.git.baseBranch).catch(err => {
                emitLog('warn', `🌳 Feature agent base merge failed: ${err.message}`, { featureAgentId: fa.id });
              });
            }
            emitLog('info', `🌳 Feature agent ${fa.name} using persistent worktree: ${fa.git.branchName}`, {
              featureAgentId: fa.id, worktreePath: faWorktreePath
            });
          }
        }
      }

      if (explicitWorktree && !jiraBranchName) {
        const existingBranch = task.metadata?.existingBranch || null;
        const { baseBranch: detectedBase } = await git.getRepoBranches(workspacePath).catch(() => ({ baseBranch: null }));
        if (existingBranch) {
          emitLog('info', `🌳 Worktree requested for task ${task.id} on existing branch ${existingBranch}`, {
            taskId: task.id, app: task.metadata?.app, branch: existingBranch
          });
        } else {
          emitLog('info', `🌳 Worktree requested for task ${task.id} — creating isolated worktree from ${detectedBase || 'default branch'}`, {
            taskId: task.id, app: task.metadata?.app, baseBranch: detectedBase
          });
        }

        worktreeInfo = await createWorktree(agentId, workspacePath, task.id, {
          baseBranch: detectedBase || undefined,
          existingBranch: existingBranch || undefined,
          planId: task.metadata?.planId || undefined
        }).catch(err => {
          emitLog('warn', `🌳 Worktree creation failed, using shared workspace: ${err.message}`, { taskId: task.id });
          return null;
        });

        if (worktreeInfo) {
          workspacePath = worktreeInfo.worktreePath;
          emitLog('success', `🌳 Agent ${agentId} will work in worktree: ${worktreeInfo.branchName} (base: ${worktreeInfo.baseBranch})`, {
            agentId, worktreePath: worktreeInfo.worktreePath, branchName: worktreeInfo.branchName, baseBranch: worktreeInfo.baseBranch
          });
        } else {
          // Isolation was EXPLICITLY requested (useWorktree/openPR) but the
          // worktree couldn't be created. Falling back to the shared workspace
          // would run the agent against the live checkout and — with openPR —
          // auto-commit to the current branch, exactly the isolation the
          // caller opted into. Fail closed: block the task rather than touch
          // the working tree behind the user's back. (The auto-detected
          // conflict branch below keeps its lenient shared-workspace fallback,
          // since there the worktree was only a recommendation, not a request.)
          const reason = `Worktree creation failed for task ${task.id}; refusing to run in the shared workspace because isolation was explicitly requested`;
          emitLog('warn', `🌳 ${reason}`, { taskId: task.id });
          await updateTask(task.id, {
            status: 'blocked',
            metadata: {
              ...task.metadata,
              blockedReason: 'Worktree creation failed — isolation was explicitly requested',
              blockedCategory: 'worktree-failed',
              blockedAt: new Date().toISOString(),
            },
          }, task.taskType || 'user').catch(() => {});
          cleanupOnError(reason);
          cosEvents.emit('agent:error', { taskId: task.id, error: reason });
          return null;
        }
      } else if (!jiraBranchName && !isFalsyMeta(task.metadata?.useWorktree)) {
        const { getAgents } = await import('./cos.js');
        const allAgents = await getAgents();
        const runningAgents = allAgents.filter(a => a.status === 'running');

        const conflictResult = await detectConflicts(task, workspacePath, runningAgents).catch(err => {
          emitLog('warn', `Conflict detection failed: ${err.message}`, { taskId: task.id });
          return { hasConflict: false, recommendation: 'proceed' };
        });

        if (conflictResult.recommendation === 'worktree') {
          emitLog('info', `🌳 Conflict detected for task ${task.id}: ${conflictResult.reason} — creating worktree`, {
            taskId: task.id,
            conflictingAgents: conflictResult.conflictingAgents,
            reason: conflictResult.reason
          });

          worktreeInfo = await createWorktree(agentId, workspacePath, task.id, {
            planId: task.metadata?.planId || undefined
          }).catch(err => {
            emitLog('warn', `🌳 Worktree creation failed, using shared workspace: ${err.message}`, { taskId: task.id });
            return null;
          });

          if (worktreeInfo) {
            workspacePath = worktreeInfo.worktreePath;
            emitLog('success', `🌳 Agent ${agentId} will work in worktree: ${worktreeInfo.branchName}`, {
              agentId, worktreePath: worktreeInfo.worktreePath, branchName: worktreeInfo.branchName
            });
          }
        } else if (conflictResult.recommendation === 'proceed') {
          emitLog('debug', `No conflicts for task ${task.id}, using shared workspace`, { taskId: task.id });
        }
      }
    } // end !isReadOnly

    const isTui = isTuiProvider(provider);

    // Build the agent prompt. `provider.type` drives the light-vs-full split
    // inside buildAgentPrompt — see its doc comment.
    const prompt = await buildAgentPrompt(task, config, workspacePath, worktreeInfo, isTruthyMeta, {
      providerType: provider.type,
      providerId: provider.id
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

    // Register the agent with model info
    await registerAgent(agentId, task.id, {
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

    // Mark the task as in_progress and increment total spawn count
    const newSpawnCount = (Number(task.metadata?.totalSpawnCount) || 0) + 1;
    const updateResult = await updateTask(task.id, {
      status: 'in_progress',
      metadata: {
        ...task.metadata,
        totalSpawnCount: newSpawnCount,
        lastSpawnedAt: new Date().toISOString()
      }
    }, task.taskType || 'user')
      .catch(err => {
        console.error(`❌ Failed to mark task ${task.id} as in_progress: ${err.message}`);
        return null;
      });
    if (!updateResult) {
      cleanupOnError('Failed to update task status');
      return null;
    }

    // Record autonomous job execution now that the task is confirmed spawning
    if (task.metadata?.autonomousJob && task.metadata?.jobId) {
      cosEvents.emit('job:spawned', { jobId: task.metadata.jobId });
    }

    const cliConfig = isTui
      ? buildTuiSpawnConfig(provider, selectedModel)
      : buildCliSpawnConfig(provider, selectedModel);

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
    cleanupOnError(err.message);
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
    const agent = runnerAgents.get(agentId);
    if (agent && !agent.hasStartedWorking) {
      agent.hasStartedWorking = true;
      await updateAgent(agentId, { metadata: { phase: 'working' } });
      emitLog('info', `Agent ${agentId} working (after initialization delay)...`, { agentId, phase: 'working' });
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
 * Advance a pipeline to its next stage after the current stage completes.
 * Creates a new task for the next stage or marks the pipeline as complete/failed.
 */
export async function handlePipelineProgression(task, agentId, success) {
  const pipeline = task.metadata?.pipeline;
  if (!pipeline || pipeline.status !== 'running') return;

  const { currentStage, stages } = pipeline;
  const stageResult = {
    stage: currentStage,
    name: stages[currentStage]?.name,
    agentId,
    success,
    completedAt: new Date().toISOString()
  };
  const updatedResults = [...(pipeline.stageResults || []), stageResult];

  if (!success) {
    await updateTask(task.id, {
      metadata: { ...task.metadata, pipeline: { ...pipeline, status: 'failed', stageResults: updatedResults } }
    }, task.taskType);
    emitLog('warn', `⛔ Pipeline ${pipeline.id} failed at stage ${currentStage}: ${stages[currentStage]?.name}`, { pipelineId: pipeline.id });
    return;
  }

  const nextStageIndex = currentStage + 1;
  if (nextStageIndex >= stages.length) {
    await updateTask(task.id, {
      metadata: { ...task.metadata, pipeline: { ...pipeline, status: 'completed', stageResults: updatedResults } }
    }, task.taskType);
    // Clean up pipeline artifacts (e.g., REVIEW.md left by stage 1)
    if (task.metadata.repoPath) {
      const repoRoot = resolve(task.metadata.repoPath);
      for (const stage of stages) {
        const file = stage.precondition?.fileNotExists;
        if (file) {
          const filePath = resolve(repoRoot, file);
          const rel = relative(repoRoot, filePath);
          if (!rel || rel === '..' || rel.startsWith('..' + sep) || resolve(rel) === rel) continue;
          await unlink(filePath).catch(() => {});
        }
      }
    }
    emitLog('info', `✅ Pipeline ${pipeline.id} completed all ${stages.length} stages`, { pipelineId: pipeline.id });
    return;
  }

  const nextStage = stages[nextStageIndex];

  // Check next stage's precondition before advancing
  if (nextStage.precondition && task.metadata.repoPath) {
    const check = checkStagePrecondition(nextStage, task.metadata.repoPath);
    if (!check.passed) {
      await updateTask(task.id, {
        metadata: { ...task.metadata, pipeline: { ...pipeline, status: 'failed', stageResults: updatedResults } }
      }, task.taskType);
      emitLog('warn', `⏭️ Pipeline ${pipeline.id} stage ${nextStageIndex} precondition failed: ${check.reason}`, { pipelineId: pipeline.id });
      return;
    }
  }

  const taskScheduleMod = await import('./taskSchedule.js');
  let prompt = await taskScheduleMod.getStagePrompt(task.metadata.analysisType, nextStageIndex);
  if (task.metadata.appName) prompt = prompt.replace(/\{appName\}/g, task.metadata.appName);
  if (task.metadata.repoPath) prompt = prompt.replace(/\{repoPath\}/g, task.metadata.repoPath);
  if (task.metadata.app) prompt = prompt.replace(/\{appId\}/g, task.metadata.app);

  const nextTask = {
    id: `${task.id || 'sys-pipeline'}-stage${nextStageIndex}-${Date.now().toString(36)}`,
    status: 'pending',
    description: prompt,
    priority: task.priority || 'MEDIUM',
    metadata: {
      ...task.metadata,
      readOnly: nextStage.readOnly ?? false,
      pipeline: {
        ...pipeline,
        currentStage: nextStageIndex,
        stageResults: updatedResults,
        previousStageAgentId: agentId,
        status: 'running'
      }
    },
    autoApproved: true
  };
  if (nextStage.model) nextTask.metadata.model = nextStage.model;
  if (nextStage.providerId) {
    nextTask.metadata.provider = nextStage.providerId;
    nextTask.metadata.providerId = nextStage.providerId;
  }
  // Apply per-stage overrides for agent behavior flags
  const stageReadOnly = nextStage.readOnly ?? false;
  const taskDefaults = pipeline.taskDefaults || {};
  for (const flag of PIPELINE_BEHAVIOR_FLAGS) {
    if (flag in nextStage) {
      nextTask.metadata[flag] = nextStage[flag];
    } else if (stageReadOnly) {
      nextTask.metadata[flag] = false;
    } else if (flag in taskDefaults) {
      nextTask.metadata[flag] = taskDefaults[flag];
    }
  }

  await addTask(nextTask, 'internal', { raw: true });
  emitLog('info', `🔗 Pipeline ${pipeline.id} advancing to stage ${nextStageIndex}: ${nextStage.name}`, { pipelineId: pipeline.id, agentId });
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
      const commitFound = checkForTaskCommit(task.id, workspacePath);
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

    // Fetch agent state once for JIRA and plan-question blocks
    const { getAgent: getAgentState } = await import('./cos.js');
    const agentState = await getAgentState(agentId).catch(() => null);

    // JIRA integration: push branch, create PR, comment on ticket
    const jiraTicketId = agent.task?.metadata?.jiraTicketId;
    const jiraBranch = agent.task?.metadata?.jiraBranch;
    const jiraInstanceId = agent.task?.metadata?.jiraInstanceId;
    const jiraCreatePR = agent.task?.metadata?.jiraCreatePR;

    if (jiraTicketId && jiraBranch && effectiveSuccess) {
      const workspace = agentState?.metadata?.workspacePath || ROOT_DIR;

      let jiraTicketUrl = agent.task?.metadata?.jiraTicketUrl || null;
      if (!jiraTicketUrl && jiraInstanceId) {
        const jiraConfig = await jiraService.getInstances().catch(() => null);
        const baseUrl = jiraConfig?.instances?.[jiraInstanceId]?.baseUrl;
        if (baseUrl) jiraTicketUrl = `${baseUrl}/browse/${jiraTicketId}`;
      }
      const jiraTicketRef = jiraTicketUrl ? `[${jiraTicketId}](${jiraTicketUrl})` : jiraTicketId;

      await git.push(workspace, jiraBranch).catch(err => {
        emitLog('warn', `Failed to push JIRA branch ${jiraBranch}: ${err.message}`, { agentId, ticketId: jiraTicketId });
      });

      let prUrl = null;
      if (jiraCreatePR !== false) {
        const { baseBranch, devBranch } = await git.getRepoBranches(workspace).catch(() => ({ baseBranch: null, devBranch: null }));
        const targetBranch = devBranch || baseBranch || 'main';

        const jiraPrBody = await git.generatePRDescription(workspace, targetBranch, jiraBranch, outputBuffer);
        const jiraPrBodyWithRef = `Resolves ${jiraTicketRef}\n\n${jiraPrBody}`;

        const baseTitle = await git.suggestPRTitle(workspace, targetBranch, jiraBranch, task.description);
        const jiraPrTitle = `${jiraTicketId}: ${baseTitle}`.substring(0, 100);

        const prResult = await git.createPR(workspace, {
          title: jiraPrTitle,
          body: jiraPrBodyWithRef,
          base: targetBranch,
          head: jiraBranch
        }).catch(err => {
          emitLog('warn', `Failed to create PR for ${jiraTicketId}: ${err.message}`, { agentId });
          return null;
        });

        if (prResult?.success) {
          prUrl = prResult.url;
          emitLog('success', `Created PR: ${prUrl}`, { agentId, ticketId: jiraTicketId });
        }
      }

      if (jiraInstanceId) {
        const commentLines = [`Agent completed task successfully.`];
        if (prUrl) {
          commentLines.push(`\n*Pull Request:* ${prUrl}`);
        } else if (jiraBranch) {
          commentLines.push(`\n*Branch:* \`${jiraBranch}\``);
        }
        await jiraService.addComment(jiraInstanceId, jiraTicketId, commentLines.join('\n')).catch(err => {
          emitLog('warn', `Failed to comment on JIRA ticket ${jiraTicketId}: ${err.message}`, { agentId });
        });
      }

      const { devBranch: dev, baseBranch: base } = await git.getRepoBranches(workspace).catch(() => ({ devBranch: null, baseBranch: null }));
      const returnBranch = dev || base || 'main';
      await git.checkout(workspace, returnBranch).catch(err => {
        emitLog('warn', `Failed to checkout back to ${returnBranch}: ${err.message}`, { agentId });
      });
    }

    // Check for plan questions marker file (feature-ideas / plan-task needing user input)
    const planAnalysisType = task?.metadata?.analysisType;
    if (planAnalysisType === 'feature-ideas' || planAnalysisType === 'plan-task') {
      const planWorkspace = agentState?.metadata?.workspacePath || task?.metadata?.repoPath || ROOT_DIR;
      const markerPath = join(planWorkspace, '.plan-questions.md');

      const markerContent = await tryReadFile(markerPath);
      if (markerContent) {
        const titleMatch = markerContent.match(/^#\s+Plan Question:\s*(.+)/m);
        const title = titleMatch?.[1]?.trim() || 'PLAN.md item needs your input';
        const appId = task.metadata?.app;

        const { addNotification, NOTIFICATION_TYPES, PRIORITY_LEVELS } = await import('./notifications.js');
        await addNotification({
          type: NOTIFICATION_TYPES.PLAN_QUESTION,
          title,
          message: markerContent,
          priority: PRIORITY_LEVELS.MEDIUM,
          link: appId ? `/apps/${appId}/documents` : undefined,
          metadata: { appId, agentId, taskType: planAnalysisType }
        }).catch(err => {
          emitLog('warn', `Failed to create plan_question notification: ${err.message}`, { agentId });
        });

        await rm(markerPath).catch(() => {});
        emitLog('info', `📋 Plan question notification created: ${title}`, { agentId, appId });
      }
    }

    // Advance pipeline to next stage if applicable
    if (task?.metadata?.pipeline) {
      await handlePipelineProgression(task, agentId, effectiveSuccess);
    }

    // Advance Creative Director task chain if applicable. After a Creative
    // Director agent task (treatment or evaluate) finishes, the orchestrator
    // decides what comes next and enqueues it. Scene rendering and final
    // stitching run server-side rather than as separate CoS tasks, so they
    // never reach this hook directly. Failure marks the project failed; the
    // user can resume from the UI.
    if (task?.metadata?.creativeDirector) {
      const { handleCreativeDirectorCompletion } = await import('./creativeDirector/completionHook.js');
      handleCreativeDirectorCompletion(task, agentId, effectiveSuccess)
        .catch((err) => console.log(`⚠️ creativeDirector completion hook failed: ${err.message}`));
    }

    // Clean up worktree if agent was using one (skip merge when JIRA branch — PR handles merge)
    if (!jiraBranch) {
      const taskOpenPR = isTruthyMeta(agent.task?.metadata?.openPR);
      const taskReviewLoop = isTruthyMeta(agent.task?.metadata?.reviewLoop);
      // Review-loop follow-up agents already merged via `gh pr merge` in the agent
      // body — re-merging the worktree branch into the source workspace would
      // duplicate the squashed commits, so suppress the auto-merge fallback.
      const taskReviewLoopFollowUp = isTruthyMeta(agent.task?.metadata?.reviewLoopFollowUp);
      // Claude Code CLI agents run `/simplify` + `/do:pr` themselves (see
      // buildCliCompletionSection in agentPromptBuilder.js) — they push the
      // branch and open the PR on their own. Mirror the TUI cleanup contract
      // so PortOS doesn't double-fire `gh pr create` ("a pull request already
      // exists" would preserve the worktree as a false-positive failure).
      const agentOwnsPR = taskOpenPR && (agent.providerId === 'claude-code' || agent.providerId === 'claude-code-bedrock');
      // Merge per-task reviewer metadata with the user's Code Review Defaults
      // (AI Providers → Code Review Defaults panel). Settings I/O is cached
      // inside the resolver, so this is effectively free even when invoked
      // from a tight CoS sweep.
      const reviewOptions = await resolveReviewLoopOptions(agent.task?.metadata, { normalize: normalizeReviewers, isTruthyMeta });
      const cleanupWarnings = await cleanupAgentWorktree(agentId, effectiveSuccess, {
        openPR: agentOwnsPR ? false : taskOpenPR,
        requestCopilotReview: !agentOwnsPR && taskOpenPR && taskReviewLoop,
        ...reviewOptions,
        skipMerge: taskReviewLoopFollowUp || agentOwnsPR,
        description: task?.description,
        agentOutput: outputBuffer,
        originalTask: task
      });

      if (cleanupWarnings?.length > 0) {
        const { getAgent: getAgentForResult } = await import('./cos.js');
        const currentAgent = await getAgentForResult(agentId).catch(() => null);
        await updateAgent(agentId, { result: { ...currentAgent?.result, warnings: cleanupWarnings } });

        const { addNotification, NOTIFICATION_TYPES, PRIORITY_LEVELS } = await import('./notifications.js');
        const appName = task?.metadata?.appName || task?.metadata?.app || 'PortOS';
        await addNotification({
          type: NOTIFICATION_TYPES.AGENT_WARNING,
          title: `Agent cleanup issue: ${appName}`,
          description: cleanupWarnings.join('\n'),
          priority: PRIORITY_LEVELS.HIGH,
          link: '/cos/agents',
          metadata: { agentId, taskId: task?.id, warnings: cleanupWarnings }
        }).catch(err => {
          emitLog('warn', `Failed to create cleanup warning notification: ${err.message}`, { agentId });
        });

        void spawnMergeRecoveryTask(cleanupWarnings, agentId, task, appName, currentAgent?.metadata?.sourceWorkspace).catch(err => {
          emitLog('warn', `Failed to spawn merge recovery task: ${err.message}`, { agentId, taskId: task?.id });
        });
      }
    }

    // Surface a finalizeAgent throw to the caller after best-effort
    // cleanup completed — without this the runner harness would never see
    // the failure and couldn't requeue or alert.
    if (finalizeError) throw finalizeError;
  } finally {
    runnerAgents.delete(agentId);
  }
}

/**
 * Clean up a worktree for a completed agent.
 * Reads worktree metadata from the agent's registered state and removes the worktree.
 * When openPR is true, pushes the branch and creates a PR instead of auto-merging.
 * When requestCopilotReview is also true, spawns a follow-up internal task that drives
 * the multi-reviewer loop and merges once the review chain is clean — that follow-up is
 * the part the user expects to "keep looping until ready to merge."
 * `reviewers` is the ordered reviewer list (e.g. `[codex, antigravity, copilot]`); the native
 * GitHub Copilot review is pre-requested here only when copilot LEADS the list (otherwise
 * the follow-up requests it at its turn so Copilot sees the post-fix diff). `reviewStopMode`
 * (`all`/`on-findings`/`on-clean`) and `reviewerApplies` are threaded into the follow-up's
 * metadata. CLI reviewers (claude/antigravity/codex) are always driven by the follow-up agent,
 * which works on any forge; copilot is GitHub-only and dropped on non-GitHub remotes.
 * When skipMerge is true (review-loop follow-up agents), the cleanup never auto-merges
 * the worktree branch into the source workspace because `gh pr merge` already handled it.
 * Otherwise, merges the worktree branch back to the source branch on success.
 */
export async function cleanupAgentWorktree(agentId, success, { openPR = false, requestCopilotReview: shouldRequestCopilot = false, reviewers = DEFAULT_REVIEWERS, reviewStopMode = DEFAULT_REVIEW_STOP_MODE, reviewerApplies = false, skipMerge = false, description = null, agentOutput = null, originalTask = null } = {}) {
  const { getAgent: getAgentState } = await import('./cos.js');
  const agentState = await getAgentState(agentId).catch(() => null);
  if (!agentState?.metadata?.isWorktree) return [];
  if (agentState?.metadata?.isPersistentWorktree) return [];

  const { sourceWorkspace, worktreeBranch } = agentState.metadata;
  if (!sourceWorkspace || !worktreeBranch) return [];

  const warnings = [];

  // When openPR is set and task succeeded, push branch and create PR instead of auto-merging
  if (openPR && success) {
    emitLog('info', `🌳 Opening PR for worktree agent ${agentId} branch ${worktreeBranch}`, { agentId, branchName: worktreeBranch });

    const worktreePath = agentState.metadata.workspacePath || join(PATHS.worktrees, agentId);

    const [pushResult, branchInfo] = await Promise.all([
      git.push(worktreePath, worktreeBranch).then(() => true).catch(err => {
        emitLog('warn', `🌳 Failed to push worktree branch ${worktreeBranch}: ${err.message}`, { agentId });
        return false;
      }),
      git.getRepoBranches(sourceWorkspace).catch(() => ({ baseBranch: null, devBranch: null }))
    ]);

    if (pushResult) {
      let targetBranch = branchInfo.baseBranch;
      if (!targetBranch) {
        targetBranch = await git.getDefaultBranch(sourceWorkspace, { allowRemote: false }).catch(() => null) || 'main';
      }
      const prTitle = await git.suggestPRTitle(worktreePath, targetBranch, worktreeBranch, description);

      const prBody = await git.generatePRDescription(worktreePath, targetBranch, worktreeBranch, agentOutput);

      const prResult = await git.createPR(worktreePath, {
        title: prTitle,
        body: prBody,
        base: targetBranch,
        head: worktreeBranch
      }).catch(err => {
        emitLog('warn', `🌳 Failed to create PR for ${worktreeBranch}: ${err.message}`, { agentId });
        return null;
      });

      if (!prResult?.success) {
        const reason = prResult?.error || 'unknown error (createPR returned null or threw)';

        // "No commits between X and Y" means the agent made no code changes.
        // Clean up the worktree silently — nothing to review or merge.
        // Also delete the remote branch (it was pushed before PR creation).
        if (reason.includes('No commits between')) {
          emitLog('info', `🌳 No commits on ${worktreeBranch} vs ${targetBranch} — agent made no changes, cleaning up`, { agentId });
          await git.deleteBranch(sourceWorkspace, worktreeBranch, { remote: true }).catch(err => {
            emitLog('warn', `🌳 Remote branch delete failed for ${worktreeBranch}: ${err.message}`, { agentId });
            warnings.push(`Remote branch delete failed for ${worktreeBranch}: ${err.message}`);
          });
          const result = await removeWorktree(agentId, sourceWorkspace, worktreeBranch, { merge: false }).catch(err => {
            emitLog('warn', `🌳 Worktree cleanup failed for ${agentId}: ${err.message}`, { agentId });
            return { warnings: [`Worktree cleanup failed for ${agentId}: ${err.message}`] };
          });
          warnings.push(...(result?.warnings || []));
          return warnings;
        }

        const cliName = prResult?.cli || 'gh';
        const authHint = prResult?.account
          ? ` (${cliName} authed as ${prResult.account} for ${prResult.owner})`
          : prResult?.owner
            ? ` (${cliName} on ${prResult.host || prResult.owner} — no account auto-pinned)`
            : '';
        emitLog('error', `🌳 PR creation failed for ${worktreeBranch}${authHint}: ${reason}`, { agentId, branchName: worktreeBranch, cli: prResult?.cli, account: prResult?.account, owner: prResult?.owner, host: prResult?.host });
        warnings.push(`PR creation failed for branch ${worktreeBranch}: ${reason}. Worktree preserved for manual PR creation.`);
        return warnings;
      }

      const cliName = prResult.cli || 'gh';
      emitLog('success', `🌳 Created PR: ${prResult.url} (${cliName}${prResult.account ? ` authed as ${prResult.account}` : ''})`, { agentId, branchName: worktreeBranch, cli: prResult.cli, account: prResult.account, owner: prResult.owner, host: prResult.host });

      const reviewerList = normalizeReviewers({ reviewers });
      const copilotIsFirst = reviewerList[0] === DEFAULT_REVIEWER;
      const nonCopilotReviewers = reviewerList.filter(r => r !== DEFAULT_REVIEWER);
      // Pre-request the native Copilot review ONLY when copilot LEADS the order — it
      // then reviews the freshly-opened PR. When copilot is configured after a CLI
      // reviewer (e.g. [codex, copilot]), pre-requesting now would make Copilot review
      // the stale pre-CLI-fix diff; instead the follow-up agent requests it at copilot's
      // turn, after the earlier reviewer's fixes are pushed. This pre-request is a
      // latency optimization only — the follow-up requests Copilot at its turn
      // regardless, so a failed/absent pre-request is recoverable (no reviewer dropped).
      if (shouldRequestCopilot && copilotIsFirst) {
        const reviewResult = await git.requestCopilotReview(worktreePath, prResult.url).catch(err => ({ success: false, error: err.message }));
        if (reviewResult.success && reviewResult.skipped) {
          emitLog('info', `🤖 Skipping Copilot pre-request for ${prResult.url} (non-GitHub forge)`, { agentId, prUrl: prResult.url });
        } else if (reviewResult.success) {
          emitLog('success', `🤖 Requested initial Copilot review on ${prResult.url}`, { agentId, prUrl: prResult.url });
        } else {
          emitLog('warn', `🤖 Copilot pre-request failed for ${prResult.url}: ${reviewResult.error} — follow-up will re-request at its turn`, { agentId, prUrl: prResult.url });
          warnings.push(`Copilot review request failed for ${prResult.url}: ${reviewResult.error}`);
        }
      }
      if (shouldRequestCopilot && nonCopilotReviewers.length > 0) {
        emitLog('info', `🤖 Follow-up will run CLI reviewers: ${nonCopilotReviewers.join(', ')}`, { agentId, prUrl: prResult.url });
      }

      // Spawn the review-loop follow-up agent that runs the multi-reviewer loop until
      // clean and merges. Hand it the FULL ordered list — the follow-up requests Copilot
      // at copilot's turn (so a failed pre-request or copilot-only config still gets a
      // review pass) and invokes the CLI reviewers itself. The only reviewer dropped is
      // copilot on a non-GitHub forge, handled centrally in spawnReviewLoopFollowUp.
      const canSpawnFollowUp = shouldRequestCopilot && reviewerList.length > 0;
      if (canSpawnFollowUp) {
        await spawnReviewLoopFollowUp({
          originalAgentId: agentId,
          originalTask,
          prUrl: prResult.url,
          prBranch: worktreeBranch,
          sourceWorkspace,
          reviewers: reviewerList,
          reviewStopMode,
          reviewerApplies
        }).catch(err => {
          emitLog('warn', `🤖 Failed to spawn review-loop follow-up for ${prResult.url}: ${err.message}`, { agentId, prUrl: prResult.url });
          warnings.push(`Review-loop follow-up spawn failed for ${prResult.url}: ${err.message}`);
        });
      }

      const result = await removeWorktree(agentId, sourceWorkspace, worktreeBranch, { merge: false }).catch(err => {
        emitLog('warn', `🌳 Worktree cleanup failed for ${agentId}: ${err.message}`, { agentId });
        return { warnings: [`Worktree cleanup failed: ${err.message}`] };
      });
      warnings.push(...(result?.warnings || []));
      return warnings;
    }

    // Push failed — preserve worktree/branch for manual intervention
    warnings.push(`Push failed for branch ${worktreeBranch} — worktree preserved at ${worktreePath} for manual retry`);
    emitLog('warn', `🌳 Push failed for ${worktreeBranch} — worktree preserved at ${worktreePath} for manual retry`, { agentId, branchName: worktreeBranch });
    return warnings;
  }

  // Default: auto-merge on success, just cleanup on failure.
  // Review-loop follow-up agents pass skipMerge: true because gh pr merge already
  // handled the merge upstream — re-merging the worktree branch into the local
  // source workspace would duplicate the squashed commits.
  const shouldMerge = success && !skipMerge;
  emitLog('info', `🌳 Cleaning up worktree for agent ${agentId} (merge: ${shouldMerge})`, {
    agentId, branchName: worktreeBranch, merge: shouldMerge
  });

  const result = await removeWorktree(agentId, sourceWorkspace, worktreeBranch, { merge: shouldMerge }).catch(err => {
    emitLog('warn', `🌳 Worktree cleanup failed for ${agentId}: ${err.message}`, { agentId });
    return { warnings: [`Worktree cleanup failed: ${err.message}`] };
  });
  warnings.push(...(result?.warnings || []));
  return warnings;
}

/**
 * Spawn an internal follow-up task that drives the ordered multi-reviewer
 * review-and-fix loop on the just-created PR until the configured reviewer chain
 * is satisfied, then merges the PR. This is what makes the user-facing "review
 * loop" actually loop — the original agent only opens the PR (and at most
 * pre-requests Copilot when it leads) and exits; without this follow-up the loop
 * ends after one iteration and the PR is never merged.
 *
 * `reviewers` is the ordered list (e.g. `[codex, antigravity, copilot]`); the follow-up
 * runs each in order — invoking the CLI reviewers itself and requesting Copilot at
 * its turn — honoring `reviewStopMode` (`all`/`on-findings`/`on-clean`) and
 * `reviewerApplies`. Copilot is GitHub-only, so it is stripped here on non-GitHub
 * forges; if that empties the list, no follow-up is spawned.
 *
 * The follow-up task uses an isolated worktree attached to the existing PR
 * branch (via createWorktree's `existingBranch` option) so it can fix-and-push
 * without trampling concurrent agents.
 */
export async function spawnReviewLoopFollowUp({ originalAgentId, originalTask, prUrl, prBranch, sourceWorkspace, reviewers = DEFAULT_REVIEWERS, reviewStopMode = DEFAULT_REVIEW_STOP_MODE, reviewerApplies = false }) {
  if (!prUrl || !prBranch) return null;

  const parsedPr = git.parsePullRequestUrl(prUrl);
  // Copilot is GitHub-only; CLI-based reviewers (claude/antigravity/codex) work on any
  // forge because the agent invokes the CLI directly. On a non-GitHub forge, drop
  // copilot from the list — if nothing's left, there's no review to run.
  const isNonGithubForge = parsedPr && parsedPr.host && parsedPr.host !== 'github.com';
  const reviewerList = normalizeReviewers({ reviewers });
  const effectiveReviewers = isNonGithubForge ? reviewerList.filter(r => r !== DEFAULT_REVIEWER) : reviewerList;
  if (effectiveReviewers.length === 0) return null;

  const appId = originalTask?.metadata?.app || null;
  const sourceTaskDesc = originalTask?.description || 'CoS automated task';
  const firstLine = sourceTaskDesc.split(/[\r\n]/).find(l => l.trim()) || sourceTaskDesc;
  const followUpTitle = `[Review Loop] ${firstLine.trim().substring(0, 80)} (${prUrl})`;

  const followUpTaskId = `sys-rl-${Date.now().toString(36)}`;
  const followUpTask = {
    id: followUpTaskId,
    status: 'pending',
    priority: (originalTask?.priority || 'MEDIUM').toUpperCase(),
    priorityValue: 2,
    description: followUpTitle,
    metadata: {
      app: appId,
      // useWorktree is required so the follow-up runs in isolation; existingBranch
      // tells createWorktree to attach to the PR branch instead of cutting a new one.
      useWorktree: true,
      existingBranch: prBranch,
      // openPR/reviewLoop must stay false so cleanup doesn't try to create another PR
      // or request another initial review (the agent itself drives the loop)
      openPR: false,
      reviewLoop: false,
      simplify: false,
      // Marker flags consumed by the agent prompt + completion handler
      reviewLoopFollowUp: true,
      reviewLoopPRUrl: prUrl,
      reviewLoopPRBranch: prBranch,
      reviewLoopPRNumber: parsedPr?.number ?? null,
      reviewLoopPRHost: parsedPr?.host ?? null,
      reviewLoopPROwner: parsedPr?.owner ?? null,
      reviewLoopPRRepo: parsedPr?.repo ?? null,
      reviewLoopReviewers: effectiveReviewers,
      reviewLoopStopMode: reviewStopMode,
      reviewLoopReviewerApplies: reviewerApplies,
      sourceTaskId: originalTask?.id || null,
      sourceAgentId: originalAgentId || null,
      // This follow-up may legitimately exit with zero new commits when every
      // reviewer comes back clean — completion handling must not treat a
      // zero-commit exit as a failure.
      readOnly: false
    },
    autoApproved: true,
    section: 'pending'
  };

  await addTask(followUpTask, 'internal', { raw: true });
  emitLog('info', `🔁 Spawned review-loop follow-up task ${followUpTaskId} (${effectiveReviewers.join(', ')}) for PR ${prUrl}`, {
    taskId: followUpTaskId, prUrl, prBranch, sourceAgentId: originalAgentId, sourceTaskId: originalTask?.id
  });
  return followUpTask;
}

/**
 * Auto-create a recovery task when a worktree merge or PR creation fails, so stale
 * branches don't accumulate in managed app repos and block future agent work.
 */
export async function spawnMergeRecoveryTask(cleanupWarnings, agentId, task, appName, sourceWorkspace) {
  let staleBranch = null;
  let isMergeFail = false;

  for (const w of cleanupWarnings) {
    const mergeMatch = w.match(/Auto-merge failed for branch (\S+)/);
    if (mergeMatch) { staleBranch = mergeMatch[1]; isMergeFail = true; break; }

    const prMatch = w.match(/PR creation failed for branch (\S+?):/);
    if (prMatch) { staleBranch = prMatch[1]; break; }
  }

  if (!staleBranch || !sourceWorkspace) return;

  const appId = task?.metadata?.app;

  if (isMergeFail) {
    const defaultBr = await git.getDefaultBranch(sourceWorkspace).catch(() => null) || 'main';
    addTask({
      description: `${RECOVERY_TASK_PREFIX} Resolve merge conflict and clean up stale branch ${staleBranch} in ${appName}`,
      priority: 'HIGH',
      app: appId,
      isRecovery: true,
      context: `An agent failed to auto-merge branch "${staleBranch}" back to ${defaultBr} in ${sourceWorkspace}. `
        + `Resolve this by: (1) checking if the branch's changes are already on ${defaultBr} (superseded by other commits), `
        + `and if so, delete the branch with "git branch -D ${staleBranch}"; `
        + `(2) if the changes are NOT on ${defaultBr}, attempt "git merge ${staleBranch} --no-edit" from ${defaultBr}, resolve any conflicts, and commit; `
        + `(3) after merging or determining the branch is stale, delete it with "git branch -D ${staleBranch}". `
        + `Original agent: ${agentId}, original task: ${task?.description || 'unknown'}.`,
      useWorktree: false,
    }, 'user').catch(err => {
      emitLog('warn', `Failed to create merge recovery task: ${err.message}`, { agentId, staleBranch });
    });
    emitLog('info', `🔧 Auto-created merge recovery task for stale branch ${staleBranch}`, { agentId, appName });
  } else {
    // PR/MR creation failed — spawn an agent to investigate and retry. Pick gh vs
    // glab based on the repo's forge so the recovery agent gets commands that
    // actually work against this remote.
    const [{ cli }, detectedBase] = await Promise.all([
      git.resolveForgeForRepo(sourceWorkspace).catch(() => ({ cli: 'gh' })),
      git.getDefaultBranch(sourceWorkspace).catch(() => null)
    ]);
    const targetBase = detectedBase || 'main';
    const isGitLab = cli === 'glab';
    const reqWord = isGitLab ? 'MR' : 'PR';
    const listCmd = isGitLab
      ? `glab mr list --source-branch ${staleBranch}`
      : `gh pr list --head ${staleBranch}`;
    const createCmd = isGitLab
      ? `glab mr create --source-branch ${staleBranch} --target-branch ${targetBase} --title '...' --description '...'`
      : `gh pr create --head ${staleBranch} --base ${targetBase} --title '...' --body '...'`;

    addTask({
      description: `${RECOVERY_TASK_PREFIX} Investigate and retry failed ${reqWord} for branch ${staleBranch} in ${appName}`,
      priority: 'HIGH',
      app: appId,
      isRecovery: true,
      context: `An agent pushed branch "${staleBranch}" to ${sourceWorkspace} but automated ${reqWord} creation failed. `
        + `Investigate by: (1) checking if a ${reqWord} already exists for this branch: "${listCmd}"; `
        + `(2) if no ${reqWord} exists, review the branch changes and create one: "${createCmd}"; `
        + `(3) if the branch is stale or changes are already on ${targetBase}, delete the remote branch: "git push origin --delete ${staleBranch}". `
        + `Original agent: ${agentId}, original task: ${task?.description || 'unknown'}.`,
      useWorktree: false,
    }, 'user').catch(err => {
      emitLog('warn', `Failed to create ${reqWord} recovery task: ${err.message}`, { agentId, staleBranch });
    });
    emitLog('info', `🔧 Auto-created ${reqWord} recovery task for branch ${staleBranch}`, { agentId, appName, cli });
  }
}
