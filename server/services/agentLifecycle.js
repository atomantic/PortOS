/**
 * Agent Lifecycle
 *
 * The spawn/completion ORCHESTRATOR: it picks a provider, prepares the
 * workspace, dispatches to one of the three spawn modes, and drives pipeline
 * progression + worktree cleanup on the way out.
 *
 * Layering (issue #2837): this module sits ABOVE the spawners
 * (`agentCliSpawning.js`, `agentTuiSpawning.js`) and `agentManagement.js`, and
 * imports all three. The pieces THEY need are therefore not allowed to live
 * here — they were extracted into leaf modules that nothing in the cluster is
 * imported by:
 *
 *   - `agentFinalization.js`       — finalizeAgent / releaseAgentLane (both spawners)
 *   - `agentSummaryExtraction.js`  — extractFinalSummary / extractSimplifySummaries
 *   - `agentRunnerSync.js`         — syncRunnerAgents (agentManagement, subAgentSpawner)
 *   - `agentState.js`              — the shared in-memory agent maps
 *
 * This module used to re-export all of them so `from './agentLifecycle.js'`
 * kept resolving for callers written before the extraction. Those pass-throughs
 * are gone (#3450): their last consumer was `subAgentSpawner.js`'s back-compat
 * barrel, and re-exporting a leaf from the orchestrator above it is what made
 * "where does finalizeAgent live" a three-answer question. Import a leaf from
 * the leaf. Do NOT move a function back in here if a spawner or agentManagement
 * calls it — that re-creates the cycle, and `agentImportCycles.test.js` will fail.
 */

import { join } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { cosEvents, emitLog } from './cosEvents.js';
// The DEFINING module, not a barrel (#3450) — see the note in
// `agentManagement.js`. This module owns the `spawnAgentForTask` transition the
// facade re-exports, so it is permanently inside the facade's closure and must
// name `completeAgent`'s home directly.
import { registerAgent, updateAgent, completeAgent } from './cosAgentLifecycle.js';
// `getAgentRecord`, NOT `getAgent`: the record without its transcript. Both
// consumers below want only `.status` / `.metadata`, and `getAgent` hydrates a
// completed or paused record by reading the whole output.txt, line-splitting it
// into per-line objects, and running `repairCodexTaskSummary` (which can write
// metadata.json back). That is megabytes and a disk write on a long TUI run —
// paid to read one string. Same trap documented at agentWorktreeCleanup.js:562.
import { getConfig, updateTask, getTaskById, getAgentRecord } from './cos.js';
import { spawnAgentViaRunner, getRunnerHealth, classifyRunnerSpawnFailure, RUNNER_SPAWN_REFUSED, RUNNER_SPAWN_AMBIGUOUS } from './cosRunnerClient.js';
import { MAX_TOTAL_SPAWNS, normalizeReviewers } from '../lib/validation.js';
import { isInternalTaskId } from '../lib/taskParser.js';
import { isRetryHeld } from '../lib/taskRetryHold.js';
import { ensureDir, PATHS, sleep, tryReadFile } from '../lib/fileUtils.js';
import { createToolExecution, startExecution, completeExecution, errorExecution } from './toolStateMachine.js';
import { determineLane, acquire, release } from './executionLanes.js';
import { analyzeAgentFailure } from './agentErrorAnalysis.js';
import { createAgentRun } from './agentRunTracking.js';
import { appendRunEvent } from './agentRunEventLog.js';
import { committedDuringRun, toEpochMs } from '../lib/gitCommitProbe.js';
import { capturePrimaryCheckoutState } from '../lib/primaryCheckoutGuard.js';
import { buildAgentPrompt, getAppWorkspace, inlinePrLifecycleSection, isClaimFlowTask } from './agentPromptBuilder.js';
import { isOllamaClaudeProvider, isClaudeCommand, providerSuppliesGithubToken } from '../lib/providerModels.js';
import { canTypeSlashCommands } from '../lib/slashdoInvocation.js';
import { prClaimWasVerified } from '../lib/prDisposition.js';
import { composeProviderEnv } from '../lib/cliChildEnv.js';
import { PROVIDER_TYPES } from '../lib/aiToolkit/constants.js';
import { buildCliSpawnConfig, isClaudeCliProvider, isTuiProvider, getClaudeSettingsEnv, spawnDirectly } from './agentCliSpawning.js';
import { buildTuiSpawnConfig, spawnTuiAgent } from './agentTuiSpawning.js';
import { releaseAppReviewMarker } from './appActivity.js';
import { ensureInstanceId } from './instances.js';
import { isClaimableBy, buildClaim, buildRelease, getClaimOwner, getTargetInstance, isTargetedElsewhere } from './cosTaskClaim.js';
import { resolveForgeTokenEnv } from './git.js';
import { runnerAgents, pausedAgents, spawningTasks, useRunner, isTruthyMeta } from './agentState.js';
import { withSpawnDedupGuard, withMapEntryCleanup, withUpdateInProgressGuard, SPAWN_DEDUP_SKIP, SPAWN_UPDATE_SKIP } from './agentGuards.js';
import { isUpdateInProgress } from './updateChecker.js';
import { v4 as uuidv4 } from '../lib/uuid.js';

// Extracted helpers — these carve the two giant orchestrators
// (spawnAgentForTask / handleAgentCompletion) into focused, testable modules.
// Imported for use here only; the pass-through re-exports that used to sit
// below them were retired with the `subAgentSpawner.js` barrel (#3450).
import { resolveAgentProviderAndModel } from './agentProviderResolution.js';
import { prepareAgentWorkspace } from './agentWorkspacePrep.js';
// `releaseRetryHold` is imported STATICALLY here (the TUI/direct-CLI spawners
// reach for it via `await import()` only because they sit BELOW this module and
// a top-level import there would race the cycle) — this module already imports
// `cleanupAgentWorktree` from the same file, so there is no new edge.
import { cleanupAgentWorktree, releaseRetryHold } from './agentWorktreeCleanup.js';
import { runAgentCompletionCleanup } from './agentCompletionCleanup.js';
import { dispatchRecoveredTaskOutputHook, finalizeAgent, releaseAgentLane, stampLiExecutionVerdict } from './agentFinalization.js';
import { extractFinalSummary } from './agentSummaryExtraction.js';
import { handleOrphanedTask } from './agentManagement.js';

const ROOT_DIR = PATHS.root;
const AGENTS_DIR = PATHS.cosAgents;



/**
 * Spawn an agent for a task.
 *
 * The entire spawn body runs under `withSpawnDedupGuard` (agentGuards.js),
 * which owns the whole `spawningTasks` dedup lifecycle: it rejects a
 * concurrent duplicate (the `has()` check → `SPAWN_DEDUP_SKIP`), acquires the
 * guard SYNCHRONOUSLY before the first `await` in `runAgentSpawn`, and releases
 * it in a `finally` so no early `return null` or throw can strand the task id
 * in the set. Extracting the guard makes the late-delete race it closes
 * unit-testable against the real helper (issue #2548) instead of a replica.
 *
 * Outside that, `withUpdateInProgressGuard` holds every spawn while a PortOS
 * self-update is running (issue #4124) — `update.sh` pm2-restarts this server,
 * which severs any agent it started, so the task stays queued for after the
 * restart instead. This is the LAST-LINE gate: the primary hold sits at
 * subAgentSpawner's `task:ready` listener, where the app-review marker and the
 * job spawn-failed signal can also be released (an unconditional bail from here
 * would strand both — the #989 failure mode). Both exist because this is the
 * one function every spawn path ends at, so a future direct caller that
 * bypasses the listener is still gated.
 */
export async function spawnAgentForTask(task) {
  const outcome = await withUpdateInProgressGuard(isUpdateInProgress, () =>
    withSpawnDedupGuard(spawningTasks, task.id, () => runAgentSpawn(task)));
  if (outcome === SPAWN_UPDATE_SKIP) {
    console.log(`⏸️ Holding task ${task.id} — a PortOS self-update is in progress`);
    return null;
  }
  if (outcome === SPAWN_DEDUP_SKIP) {
    console.log(`⚠️ Task ${task.id} already being spawned, skipping duplicate`);
    return null;
  }
  return outcome;
}

/**
 * The guarded spawn body. Runs only inside `withSpawnDedupGuard` above, which
 * holds the `spawningTasks` guard across this whole function and releases it in
 * a finally — so this body never needs to touch the dedup set itself; every
 * early `return null` and any throw is covered by the wrapper's release.
 */
async function runAgentSpawn(task) {
  // Normalize taskType once, up front (issue #2633). Direct `task:ready` emits —
  // the Creative Director bridge, `dequeueNextTask`, and `spawnPriority0OnDemand` —
  // publish task records without a `taskType`. Every claim/in_progress `updateTask`
  // below falls back to `task.taskType || 'user'`, so an internal-file (`sys-*`)
  // task without taskType would target TASKS.md instead of COS-TASKS.md, miss the
  // record, and return a truthy `{ error }` object the `if (!updateResult)` check
  // does not catch. Derive the type from the id here (mirrors the completion path,
  // ~line 1084) so every write below routes to the correct file.
  if (task && !task.taskType) {
    task.taskType = isInternalTaskId(task.id || '') ? 'internal' : 'user';
  }

  // Cross-instance claim guard (issue #1563, acceptance criterion 2). When this
  // task list is shared with a federated peer (full-sync mode, #1561), the peer
  // may already be working this task. Refuse to spawn while another instance
  // holds a live lease — otherwise both peers spawn an agent for the same task,
  // create conflicting `cos/<taskId>/<agentId>` worktrees on the same repo, and
  // race the orphan-reset. This is a cheap, no-I/O fast-reject on the dequeued
  // task; the authoritative acquire-with-fresh-reread happens below, before any
  // spawn setup. No-op for a non-federated install (no claim metadata) and for
  // re-claiming our own task on retry/resume.
  // Resolve identity defensively: a cold-start identity failure (e.g. writing
  // data/instances.json fails) returns null here; the wrapper's finally still
  // releases the dedup guard, so the task id is never stranded in spawningTasks.
  let instanceId;
  try {
    instanceId = await ensureInstanceId();
  } catch (err) {
    emitLog('error', `Failed to resolve instance identity for task ${task.id}: ${err?.message || err}`, { taskId: task.id });
    return null;
  }
  // Targeted assignment guard (issue #4520). A task pinned to a specific
  // federated instance runs ONLY there — every other peer passes over it, even
  // when it is unclaimed and this instance is idle. Checked before the lease so
  // the log names the standing decision rather than a transient claim. Unpinned
  // tasks (the default) reach the opportunistic lease check unchanged.
  if (isTargetedElsewhere(task.metadata, instanceId)) {
    console.log(`📍 Task ${task.id} is assigned to instance ${getTargetInstance(task.metadata)} — skipping spawn on ${instanceId}`);
    return null;
  }
  if (!isClaimableBy(task.metadata, instanceId)) {
    console.log(`🔒 Task ${task.id} is claimed by instance ${getClaimOwner(task.metadata)} (live lease) — skipping spawn on ${instanceId}`);
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
    // The spawn-dedup guard is released by withSpawnDedupGuard's finally around
    // this whole body (see spawnAgentForTask) — cleanupOnError only owns the
    // lane, tool-execution, claim, and app-review marker releases.
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
    // A retry held for its resume pointer (#3373) is not spawnable, however this
    // dispatch reached us. The dequeue tiers can't see it (they select `pending`),
    // but a `task:ready` emitted before the hold was armed — or a stale generator
    // snapshot — arrives with a task object from before the failure, and the claim
    // check below passes because the hold keeps OUR OWN lease. Spawning here is
    // exactly the race the hold exists to close: the retry would start clean while
    // the pointer naming its predecessor's branch is still being resolved. The
    // release re-emits `tasks:changed`, which re-runs the dequeue.
    if (isRetryHeld(freshTask.metadata)) {
      console.log(`⏳ Task ${task.id} is held for its retry pointer — not spawning until cleanup releases it`);
      await cleanupOnError('retry held pending cleanup');
      return null;
    }
    // Re-check the pin against the freshest record (#4520): the dequeued snapshot
    // may predate a reassignment that synced in from a peer, and a task
    // reassigned mid-dispatch must not be started here.
    if (isTargetedElsewhere(freshTask.metadata, instanceId)) {
      console.log(`📍 Task ${task.id} is assigned to instance ${getTargetInstance(freshTask.metadata)} — yielding on ${instanceId}`);
      await cleanupOnError('assigned to another instance');
      return null;
    }
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
  //   worktree + JIRA provisioning. cleanupOnError releases the execution
  //   lane and the tool-execution state (the dedup guard itself is released
  //   by withSpawnDedupGuard's finally around this whole body). Also re-emit
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
      // A PERMANENT provider-config failure (e.g. an `api`-only provider pinned
      // to an agent task, which has no file-writing harness) fails identically on
      // every re-dispatch. Leaving the task pending makes it silently re-fail
      // forever AND wedge its app's single improvement slot. Block it with an
      // actionable reason so it stops re-dispatching and surfaces in the UI.
      //
      // Do this BEFORE cleanupOnError releases the federation lease, and while we
      // still hold it: the block write itself frees the lease (updateTask strips
      // the claim on any non-`in_progress` status change), so the terminal
      // transition + lease release are one atomic write. Blocking AFTER the
      // release would open a window where a federated peer could claim + start the
      // task (e.g. with a working CLI provider) and then have its live
      // `in_progress` record clobbered to `blocked` — which outranks `in_progress`
      // in the claim-aware merge. Transient failures fall through, skip the block,
      // and stay pending to retry.
      if (resolution.permanent) {
        await updateTask(task.id, {
          status: 'blocked',
          metadata: {
            ...task.metadata,
            blockedReason: resolution.error,
            blockedCategory: 'provider-config',
            blockedAt: new Date().toISOString()
          }
        }, task.taskType || 'user').catch(() => {});
      }
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

    // Auto-snapshot the workspace context of the app CoS was last working in
    // when this dispatch switches to a different app/repo (#2035). Snapshot-only
    // — it never restores and never calls an LLM. Dynamic import avoids pulling
    // the workspace-context graph into this hot module's load path; the call is
    // defensive so a missing current context (or any failure) can't break the
    // spawn.
    await import('./workspaceContext.js')
      .then((ws) => ws.snapshotOnRepoSwitch(task.metadata?.app || null))
      .catch((err) => {
        emitLog('warn', `Workspace auto-snapshot skipped for task ${task.id}: ${err?.message || err}`, { taskId: task.id });
      });

    const isTui = isTuiProvider(provider);

    // Lean mode: an Ollama-backed Claude session gets `--bare --strict-mcp-config`
    // (see applyLeanClaudeArgs) so the user's personal environment — hooks,
    // plugins, MCP servers, global CLAUDE.md — doesn't drown the small local
    // model. This is orthogonal to the prompt split below.
    const leanMode = isOllamaClaudeProvider(provider);

    // System/user prompt split: for ANY Claude Code session (TUI or headless
    // CLI), the PortOS operating contract rides in a real system prompt via
    // `--append-system-prompt-file` while the pasted/stdin prompt carries only
    // the task — so the model weights the contract as instructions, not
    // conversation (and hosted providers get better prompt-cache reuse on the
    // stable system block). Gated on a light-context Claude command: non-Claude
    // providers (codex, antigravity, opencode) have no equivalent flag and keep
    // the combined prompt; API providers never take the light path so the split
    // is a no-op for them. `--append-system-prompt-file` validated on claude CLI
    // v2.1.201 in both `--print` and stream-json arg shapes.
    const isLightContext = isTui || provider.type === PROVIDER_TYPES.CLI;
    const splitSystemPrompt = isLightContext && isClaudeCommand(provider.command);

    // Build the agent prompt. `provider.type` drives the light-vs-full split
    // inside buildAgentPrompt — see its doc comment.
    const promptResult = await buildAgentPrompt(task, config, workspacePath, worktreeInfo, isTruthyMeta, {
      providerType: provider.type,
      providerId: provider.id,
      providerCommand: provider.command,
      agentId, // scopes the completion sentinel filename — see doneSentinelName
      leanMode,
      split: splitSystemPrompt
    });
    const prompt = typeof promptResult === 'string' ? promptResult : promptResult.userPrompt;
    const systemPrompt = typeof promptResult === 'string' ? null : promptResult.systemPrompt;

    // Create agent directory
    const agentDir = join(AGENTS_DIR, agentId);
    if (!existsSync(agentDir)) {
      await ensureDir(agentDir);
    }

    // Save prompt to file
    await writeFile(join(agentDir, 'prompt.txt'), prompt);
    let systemPromptFile = null;
    if (systemPrompt) {
      systemPromptFile = join(agentDir, 'system-prompt.md');
      await writeFile(systemPromptFile, systemPrompt);
    }

    // Create run entry for usage tracking
    const { runId } = await createAgentRun({
      agentId,
      task,
      model: selectedModel,
      provider,
      workspacePath,
      appName: resolvedAppName
    });
    const executionMode = isTui ? (useRunner ? 'runner-tui' : 'tui') : useRunner ? 'runner' : 'direct';

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
    // The checkout the worktree was cut FROM (null for a non-worktree run, which
    // works in the primary directly and so has nothing to protect).
    const sourceWorkspace = worktreeInfo
      ? (task.metadata?.app ? await getAppWorkspace(task.metadata.app) : ROOT_DIR)
      : null;

    await registerAgent(agentId, task.id, {
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
      primaryCheckoutBaseline: sourceWorkspace ? await capturePrimaryCheckoutState(sourceWorkspace) : null,
      worktreeBranch: worktreeInfo?.branchName || null,
      isWorktree: !!worktreeInfo,
      isPersistentWorktree: !!worktreeInfo?.isPersistentWorktree,
      taskDescription: task.description,
      taskType: task.taskType,
      priority: task.priority,
      providerId: provider.id,
      // Persisted alongside the id because the cleanup path's `agentOwnsPR` gate
      // must derive from the SAME `canTypeSlashCommands` predicate the prompt used
      // to decide whether the agent opens its own PR (#3114). An id alone can't
      // answer that — a path-configured `claude` under a custom id is slashdo-
      // capable, and a lean `--bare` session is not.
      providerCommand: provider.command || null,
      leanMode,
      // Whether THIS run's prompt told the agent to push, open, review, and merge
      // its own PR. Persisted rather than re-derived at cleanup time: the two
      // must agree exactly or PortOS double-fires `gh pr create`. A pre-upgrade
      // record has no value here, so cleanup falls back to the old
      // `canTypeSlashCommands` derivation — what those runs were prompted with.
      //
      // Stamped from `inlinePrLifecycleSection`, the SAME predicate that decided
      // whether the prompt above emitted the PR steps — NOT from `provider.type`
      // alone. Ownership depends on task shape too (read-only, no-code-output,
      // discard-worktree, JIRA/leave-open, and no-worktree runs are all told
      // PortOS owns the PR), and a provider-only stamp claimed ownership for
      // every one of them — routing a Creative Director reasoning run into the
      // did-you-open-it net, which then opened a PR for it and filed a HIGH
      // notification blaming the agent for skipping a step it was never given.
      ownsPrWorkflow: inlinePrLifecycleSection(task, {
        providerType: provider.type,
        providerId: provider.id,
        providerCommand: provider.command,
        leanMode,
        worktreeInfo,
        isTruthyMetaFn: isTruthyMeta,
      }) !== null,
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
      useRunner,
      executionMode,
      taskAnalysisType: task.metadata?.analysisType || null,
      taskReviewType: task.metadata?.reviewType || null,
      taskApp: task.metadata?.app || null,
      // Marks a run dispatched by an explicit "Run Now" (on-demand) trigger, so
      // the perpetual drain-on-completion refill (perpetualRefillPlan in cos.js)
      // continues a MANUAL drain in the user-initiated on-demand lane rather than
      // the auto-run-gated queue lane. `isTruthyMeta` accepts the boolean set at
      // spawn AND the string `"true"` a COS-TASKS.md round-trip yields.
      taskOnDemand: isTruthyMeta(task.metadata?.onDemand),
      // LI hand-off provenance (#2765): projected onto the agent so the completion
      // hook (recordTaskCompletion) can attribute the run's success/failure back to
      // the proposal's domain. agent.metadata is a hand-picked projection of
      // task.metadata (not a full spread), so this must be listed explicitly.
      taskLiProposal: task.metadata?.liProposal || null,
      // Quota-burn provenance. Same hand-picked-projection reason as
      // `taskLiProposal`: the runner listens for `agent:completed` and dispatches
      // the NEXT job in this family's burn plan when the previous one finishes,
      // so it must be able to tell a burn run from any other agent from the
      // agent record alone.
      taskQuotaBurnFamily: task.metadata?.quotaBurnFamily || null,
      // The reset of the short rolling window that refuses first, carried for the
      // same reason: when this run is REFUSED, the continuation blocks the family
      // until that window rolls instead of re-dispatching into the same wall
      // (see quotaBurnDenials.js). A COS-TASKS.md round-trip can hand it back as
      // a string, so coerce rather than projecting whatever arrived.
      taskQuotaBurnLimitingResetAt: Number(task.metadata?.quotaBurnLimitingResetAt) || null,
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
      missionName: task.metadata?.missionName || null,
      missionId: task.metadata?.missionId || null,
      jiraTicketId: task.metadata?.jiraTicketId || null,
      jiraTicketUrl: task.metadata?.jiraTicketUrl || null,
      jiraBranch: task.metadata?.jiraBranch || null,
      jiraInstanceId: task.metadata?.jiraInstanceId || null,
      jiraCreatePR: task.metadata?.jiraCreatePR ?? null,
      configOpenPR: isTruthyMeta(task.metadata?.openPR),
      // Claim prompts own their external claim/<item> worktree and forge
      // lifecycle even though CoS must keep configOpenPR/configUseWorktree off
      // to avoid provisioning a nested worktree. Preserve that distinction in
      // the run record so completion diagnostics cannot mistake the claim path
      // for the generic commit-only handoff.
      configClaimFlow: isClaimFlowTask(task, isTruthyMeta),
      configSimplify: isTruthyMeta(task.metadata?.simplify),
      configReviewLoop: isTruthyMeta(task.metadata?.reviewLoop),
      configReviewers: normalizeReviewers(task.metadata),
      configUseWorktree: !!worktreeInfo,
      configWorktreeAutoDetected: !!worktreeInfo && !explicitWorktree,
      configCodingOnMain: !worktreeInfo && !jiraBranchName
    });

    emitLog('info', `Agent ${agentId} initializing...${worktreeInfo ? ' (worktree)' : ''}${jiraBranchName ? ` (JIRA: ${jiraTicket?.ticketId})` : ''}`, { agentId, taskId: task.id });

    // NOTE: the agent is already registered as `running` above, so until this
    // write lands the task still reads `pending` — one task, two live states.
    // Readers that pair the task list with the agent list must reconcile that
    // (forceSpawnTask's live-agent refusal, activeProcessing's queued count, the
    // CoS Tasks tab). Widening this gap widens their window.
    //
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
    // Surface a silent `{ error }` miss (issue #2633) — the task id wasn't present
    // in the file for `task.taskType`, so the claim didn't land. This is EXPECTED
    // for legitimately-unpersisted autonomous emits: Priority 3 mission tasks
    // (cos.js `spawnDequeuePriority3Missions`) and Priority 4 idle-review tasks
    // carry `taskType: 'internal'` but are never written to COS-TASKS.md, so their
    // in_progress `updateTask` returns `{ error: 'Task not found' }`. Warn-log it
    // for visibility, but do NOT block the spawn on it — the pre-#2633 behavior
    // spawned these anyway, and treating the error as fatal would silently kill
    // every mission / idle-review autonomous spawn. Only a `null` (updateTask
    // threw) is fatal.
    if (updateResult?.error) {
      emitLog('warn', `⚠️ in_progress claim for task ${task.id} returned an error (taskType=${task.taskType}): ${updateResult.error}`, { taskId: task.id, error: updateResult.error });
    }
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
    // Task-level OpenCode/Ollama generation controls override provider defaults
    // for this one run. The child-environment composer turns these into the
    // dynamic `agent.build` config instead of mutating saved provider state.
    const taskTemperature = task.metadata?.temperature === '' ? NaN : Number(task.metadata?.temperature);
    const taskThinking = task.metadata?.thinking;
    const runProvider = {
      ...provider,
      ...(Number.isFinite(taskTemperature) && taskTemperature >= 0 && taskTemperature <= 2
        ? { temperature: taskTemperature }
        : {}),
      ...([true, false, 'true', 'false'].includes(taskThinking) ? { thinking: taskThinking } : {}),
      ...(typeof task.metadata?.effort === 'string' ? { effort: task.metadata.effort } : {}),
    };
    // Per-task reasoning-effort override (task form / schedule config). The
    // builders no-op it for providers without an effort control.
    const taskEffort = task.metadata?.effort || null;
    const cliConfig = isTui
      ? buildTuiSpawnConfig(runProvider, selectedModel, { systemPromptFile, effort: taskEffort })
      : buildCliSpawnConfig(runProvider, selectedModel, cliSettingsEnv, { systemPromptFile, effort: taskEffort });

    emitLog('success', `Spawning agent for task ${task.id}`, {
      agentId,
      model: selectedModel,
      mode: executionMode,
      cli: cliConfig.command,
      lane: laneName,
      worktree: !!worktreeInfo
    });

    // Dedup-window fix: the `spawningTasks` guard stays held across the actual
    // spawn call, not just up to the in_progress flip — withSpawnDedupGuard
    // (around this whole body) only releases it once runAgentSpawn settles.
    // Releasing between `updateTask` and `spawnViaRunner` / `spawnDirectly`
    // opened a window where a concurrent `spawnAgentForTask(task)` call (e.g. a
    // re-fired `task:ready` from a follow-up scheduler tick) saw an empty set
    // and a task whose registered agent hadn't yet been queued to the runner,
    // and proceeded to spawn a second agent for the same task id. release()
    // must NOT run here on the success path; the lane is released by the
    // agent-completion handler when the work finishes.
    handedOff = true;
    if (isTui) {
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
        cleanupWorktreeFn: cleanupAgentWorktree,
        isTruthyMetaFn: isTruthyMeta,
        leanMode,
        useDurableRunner: useRunner,
      });
    }
    if (useRunner) {
      return await spawnViaRunner(agentId, task, { prompt, workspacePath, model: selectedModel, provider: runProvider, runId, cliConfig, executionId: toolExecution.id, laneName });
    }
    // Direct spawn mode (fallback)
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
  }
  // No finally here: withSpawnDedupGuard (around runAgentSpawn) owns the
  // spawningTasks release, so it fires whether this body returns or throws.
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
    await sleep(checkIntervalMs);
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

  // Two independent async env lookups, resolved together: Claude's
  // ~/.claude/settings.json Bedrock config, and the repo-owner-pinned GH_TOKEN
  // (so the runner-spawned agent's own `gh pr create` auths as the right
  // account — see resolveForgeTokenEnv; `{}` when there's no owner match). Skip
  // the token probe when the provider supplies its own GH_TOKEN/GITHUB_TOKEN so
  // its explicit credential wins.
  const [claudeSettingsEnv, forgeTokenEnv] = await Promise.all([
    isClaudeCliProvider(provider) ? getClaudeSettingsEnv() : Promise.resolve({}),
    providerSuppliesGithubToken(provider) ? Promise.resolve({}) : resolveForgeTokenEnv(workspacePath),
  ]);

  // The runner can reject the spawn outright — a command missing from its
  // allowlist, malformed cliArgs — or be unreachable. No child ever exists, so
  // NO runner event will ever arrive to complete this agent. Left unhandled the
  // throw reaches subAgentSpawner's `task:ready` listener, which only logs; and
  // because `runnerAgents` still holds the entry, `isAgentOwnedLocally` makes
  // the orphan sweep skip the record too, so the 3s timer above flips it to
  // `working` and it sits there for the life of the process. Finalize with the
  // real error instead, through the ordinary finalizeAgent → releaseRetryHold
  // chain so the TASK is transitioned too — see the catch below. (The TUI arm of
  // this dispatch owns the equivalent handling inside spawnTuiAgent, where
  // `finish()` is the idempotent finalizer that runs the same chain.)
  //
  // A throw here therefore means "no child exists": `spawnAgentViaRunner`
  // reconciles an ambiguous transport failure against the runner's own /agents
  // view first and RESOLVES (with `adopted: true`) when the spawn had in fact
  // landed, so the `runnerAgents` entry set above survives and this run is never
  // finalized as a rejection it cannot know occurred (#4615).
  let result;
  try {
    result = await spawnAgentViaRunner({
      agentId,
      taskId: task.id,
      prompt,
      workspacePath,
      model,
      // A DELTA, not a full env — the cos-runner bases it on its own process.env
      // and does the PWD pin / CLAUDECODE strip. composeProviderEnv owns the layer
      // order: forgeTokenEnv before provider.envVars so an explicit provider
      // override wins, and the OpenCode declared-models map after it so the
      // injected `--model ollama/<id>` is accepted (#2243/#2190 — this path was
      // the site that sweep originally missed).
      envVars: composeProviderEnv({
        before: { ...forgeTokenEnv, ...claudeSettingsEnv },
        provider,
        model,
      }),
      cliCommand: cliConfig.command,
      cliArgs: cliConfig.args
    });
  } catch (err) {
    const message = err?.message || String(err);
    // Reaching here means the spawn rpc's own reconcile found no agent in the
    // runner, so no child is running under this id either way. What is still
    // unknown for an ambiguous failure is WHY — see RUNNER_SPAWN_AMBIGUOUS
    // (#4615).
    const refused = classifyRunnerSpawnFailure(err) === RUNNER_SPAWN_REFUSED;
    clearTimeout(agentInfo.initializationTimeout);
    runnerAgents.delete(agentId);
    // A handoff that did not land (#4540). Recorded as its own boundary
    // rather than left to the failure the finalize below records: "the run
    // never started because the runner would not take it" and "the run started
    // and failed" produce the same terminal record today, and only the ledger
    // can still tell them apart afterwards.
    await appendRunEvent({
      kind: 'run.handoff',
      runId,
      agentId,
      taskId: task.id,
      eventId: `handoff:${agentId}:${runId || 'no-run'}:${refused ? 'rejected' : 'unconfirmed'}`,
      // `accepted: false` is a claim only an explicit refusal earns. An
      // ambiguous transport failure never got an answer, so it records the
      // `null` sentinel — "not known to have been accepted" — rather than
      // asserting a rejection the server cannot actually have observed. A
      // diagnostic that reads a lost acknowledgement as a refusal sends the
      // reader after the wrong cause (#4615).
      data: {
        to: 'none',
        accepted: refused ? false : null,
        outcome: refused ? RUNNER_SPAWN_REFUSED : RUNNER_SPAWN_AMBIGUOUS,
        reason: message,
      },
    });
    releaseAgentLane({ agentId, success: false, exitCode: 1, executionId, laneName, errorExecutionMessage: message });
    // Finalize through the SAME chokepoint every other ending uses (#3632).
    // Finalizing the agent alone — which is all this used to do — left the TASK
    // sitting `in_progress` holding its federation claim until the 15-minute
    // orphan sweep, and that sweep is for orphans: it charges
    // `orphanRetryCount` against MAX_ORPHAN_RETRIES and arms a 30-minute
    // cooldown for a failure the task did not cause. finalizeAgent owns the
    // task transition, execution tracking, and the per-type failure ledger;
    // releaseRetryHold then flips the held retry to `pending` immediately (and
    // `updateTask` strips the claim keys on the way out of `in_progress`), so
    // the task is re-dequeuable the moment the rejection lands.
    //
    // `spawn-rejected` is its own reason, deliberately NOT the TUI's
    // `spawn-error`: that one is `actionable` (→ the task is BLOCKED for a
    // human), which is right when a PTY genuinely can't start but wrong for a
    // runner that was merely unreachable for a moment. See its entry in
    // COMPLETION_REASON_ANALYSES.
    const errorAnalysis = analyzeAgentFailure('', task, model, {
      completionReason: 'spawn-rejected',
      completionError: message,
    });
    // validationPassed is the null sentinel (#2344), applied inside
    // finalizeAgent: no success criterion was ever evaluated, so this records
    // "not declared" rather than a false "declared and failed".
    await finalizeAgent({
      agentId,
      task,
      runId,
      providerId: provider.id,
      success: false,
      exitCode: 1,
      duration: 0,
      outputBuffer: '',
      errorAnalysis,
      isTruthyMetaFn: isTruthyMeta,
      error: message,
      completionReason: 'spawn-rejected',
      workspacePath,
      // The agent never ran, so it cannot have opened a PR — skip the
      // PR-claim verification entirely (it only applies to claimed successes).
      prExpected: false,
    }).catch(err => {
      emitLog('error', `finalizeAgent threw for rejected spawn ${agentId}: ${err.message}`, { agentId, taskId: task.id, error: err.message });
    });
    await releaseRetryHold({ agentId, task, success: false })
      .catch(err => emitLog('warn', `Retry-hold release failed for rejected spawn ${agentId}: ${err.message}`, { agentId, taskId: task.id }));
    emitLog('error', `Agent ${agentId} failed to spawn via runner: ${message}`, { agentId, taskId: task.id });
    cosEvents.emit('agent:error', { agentId, taskId: task.id, error: message });
    return null;
  }

  // Ownership of the process now sits with the CoS Runner, not this server
  // (#4540). This is the boundary the in-memory `runnerAgents` map forgets on
  // every restart — after which "which process should I look in for this run"
  // has no recorded answer at all.
  //
  // Recorded the instant the runner accepts, BEFORE the pid persist below: the
  // handoff has already happened by then, and a failed `updateAgent` would
  // otherwise leave a live runner-owned process with no record of who owns it —
  // precisely the orphan this ledger exists to explain. The natural key is the
  // run: a run is handed to the runner exactly once, so a retried spawn cannot
  // double-count it.
  await appendRunEvent({
    kind: 'run.handoff',
    runId,
    agentId,
    taskId: task.id,
    eventId: `handoff:${agentId}:${runId || 'no-run'}:cos-runner`,
    data: {
      to: 'cos-runner',
      accepted: true,
      pid: result.pid ?? null,
      providerId: provider.id,
      laneName: laneName ?? null,
      // The acknowledgement was lost and the runner turned out to have the
      // agent anyway (#4615). The handoff DID land, so `accepted` stays true —
      // `adopted` is what says the server learned it by asking rather than by
      // being told.
      ...(result.adopted ? { outcome: RUNNER_SPAWN_AMBIGUOUS, adopted: true, reason: result.adoptedReason ?? null } : {}),
    },
  });

  // Store PID in persisted state for zombie detection
  await updateAgent(agentId, { pid: result.pid });

  if (result.adopted) {
    emitLog('warn', `Agent ${agentId} spawn acknowledgement was lost (${result.adoptedReason}); adopted the live runner process (PID: ${result.pid})`, { agentId, taskId: task.id, pid: result.pid });
  }
  emitLog('info', `Agent ${agentId} spawned via runner (PID: ${result.pid})`, { agentId, pid: result.pid });
  return agentId;
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
 * Post-restart recovery: retire a completion event for an agent that is NOT in
 * the in-memory `runnerAgents` map, using the persisted cos state as the only
 * source of truth.
 *
 * A server restart drops every in-memory agent entry, so a completion that
 * lands afterwards has no live record to finalize. This path deliberately
 * BYPASSES `finalizeAgent` (and therefore worktree cleanup): the dead run's
 * worktree is still on disk, and `handleOrphanedTask` needs it to resume rather
 * than redo the work. Because it bypasses finalize, everything finalize would
 * normally do that still matters here — notably the LI hand-off verdict stamp
 * (#2779) — has to be done explicitly below.
 *
 * Split out of `handleAgentCompletion` (#3872) so that function reads as
 * "route, then complete the live agent" instead of two unrelated jobs sharing
 * one name.
 */
async function completeUntrackedAgentFromCosState(agentId, exitCode, success, duration) {
  // Dynamic import: `cos.js` imports back into this cluster, so a static import
  // of the transcript-hydrating `getAgent` here would close an import cycle.
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
  const task = cosAgent.taskId ? await getTaskById(cosAgent.taskId).catch(() => null) : null;
  await dispatchRecoveredTaskOutputHook({
    agentId,
    task,
    success,
    workspacePath: cosAgent.metadata?.workspacePath || null,
  });
  await completeAgent(agentId, {
    success,
    exitCode,
    duration,
    orphaned: true,
    error: success ? undefined : 'Agent completed after server restart'
  });
  if (cosAgent.taskId) {
    if (task && task.status !== 'completed') {
      if (success) {
        // Stamp the LI hand-off verdict here too (#2779, codex P2) — this post-restart
        // recovery bypasses finalizeAgent, so without it a hand-off that finished while
        // the server was down would never federate its outcome. Only `success` is known
        // on this path (no validationPassed/errorAnalysis), so it records a clean success.
        const taskUpdate = await stampLiExecutionVerdict({ status: 'completed' }, task, { success });
        await updateTask(cosAgent.taskId, taskUpdate, task.taskType || 'user');
      } else {
        // Hand the dead run's metadata to the retry handler so it can resume what
        // was left behind. This path bypasses `finalizeAgent` (and its worktree
        // cleanup), so the worktree is still on disk, branch and all — without it
        // the retry builds a fresh tree off the default branch and redoes work
        // that is sitting right there.
        await handleOrphanedTask(cosAgent.taskId, agentId, getTaskById, { agentMetadata: cosAgent.metadata, agentStartedAt: cosAgent.startedAt });
        // If orphan recovery settled the task into a terminal `blocked` state (retry budget
        // exhausted), the local completion already recorded the proposal failure — so stamp
        // the LI failure verdict here too (#2779, codex P2) or the originating peer would
        // receive a terminal task with no verdict. A revived (pending) task carries no
        // settled outcome yet, so it is intentionally left unstamped until it re-completes.
        const settled = await getTaskById(cosAgent.taskId).catch(() => null);
        if (settled && settled.status === 'blocked' && settled.metadata?.liProposal) {
          const stamp = await stampLiExecutionVerdict({}, settled, { success: false });
          if (stamp.metadata) {
            await updateTask(cosAgent.taskId, stamp, settled.taskType || 'user').catch(() => {});
          }
        }
      }
    }
  }
}

/**
 * Handle agent completion (from runner events).
 *
 * Router, then the live in-memory completion path. The two early exits are the
 * pause guard and the post-restart recovery hand-off — both return before any
 * finalization runs against a live agent.
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
    // Agent not in memory map (server restarted). Retire it from cos state.
    return completeUntrackedAgentFromCosState(agentId, exitCode, success, duration);
  }

  const { task, runId, model, executionId, laneName } = agent;

  // withMapEntryCleanup drops the runnerAgents entry in a finally even if any
  // inner completion step throws — otherwise a memory-extraction crash etc.
  // would strand it forever and no future spawn could reclaim the slot. The
  // error still propagates to the caller (agentGuards.js, issue #2548). The
  // already-finalized guard below sits INSIDE it so its early return drops the
  // entry too, rather than hand-rolling a second delete.
  return withMapEntryCleanup(runnerAgents, agentId, async () => {
    // The persisted record, read once and shared with the PR-ownership check
    // further down. Read off the PERSISTED record, not the in-memory
    // `runnerAgents` entry: the entry carries only `providerId` (and a
    // post-restart survivor recovered by syncRunnerAgents carries even less), so
    // a lean `--bare` runner agent would read as slashdo-capable — and be
    // downgraded for not opening a PR PortOS was about to open for it.
    // `registerAgent` writes those fields into metadata precisely so this
    // question survives a restart, and nothing mutates them mid-run.
    const persistedAgent = await getAgentRecord(agentId).catch(() => null);

    // Already-finalized backstop, mirroring the untracked branch above. Another
    // owner may have written the terminal record before this event arrived —
    // most often the TUI spawner's `finish()`, which finalizes on its own
    // sentinel and THEN kills the session, so the runner reports that kill as a
    // late exit-143 completion. Finalizing again would overwrite the recorded
    // success with this event's exit code and an `analyzeAgentFailure` verdict
    // read from an output buffer this path cannot see (a TUI writes output.txt
    // under the dated run dir, not AGENTS_DIR/<id>) — i.e. an empty buffer
    // classified `startup-failure`. See syncRunnerAgents for how a live TUI came
    // to be in `runnerAgents` at all.
    if (persistedAgent && persistedAgent.status !== 'running') {
      console.log(`✅ Agent ${agentId} already ${persistedAgent.status} — ignoring duplicate completion (exit ${exitCode})`);
      return;
    }

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

    // Post-execution validation: a non-zero exit that still left a commit inside
    // the run's own window DID the work (#3637 — the probe is the window, not a
    // task-id commit marker no agent ever emitted).
    // `runnerAgents` (in-memory) stamps `startedAt: Date.now()` — a NUMBER — while
    // the persisted record stores an ISO string; toEpochMs handles both.
    const runStartedAt = toEpochMs(agent.startedAt);
    let effectiveSuccess = success;
    if (!effectiveSuccess && task?.id) {
      const workspacePath = agent.workspacePath || ROOT_DIR;
      const commitFound = await committedDuringRun(workspacePath, runStartedAt);
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

    // The gate for finalizeAgent's PR-claim verification (#3358): a PortOS-owned
    // PR is created by `runAgentCompletionCleanup` below, i.e. AFTER finalize, so
    // verifying here would fail every correct run.
    //
    // Deliberately the SLASH-command predicate, not `agentOwnsPrWorkflow` — since
    // #3733 a slashdo-free harness also opens its own PR, but cleanup re-checks
    // the forge and opens one itself when it didn't, so failing the run here for
    // a PR that is about to exist would turn a recovered handoff into a false
    // needs-attention.
    //
    // `persistedAgent` is the record read once at the top of this callback — see
    // the note there for why the metadata must come off disk rather than the
    // in-memory entry.
    const runnerAgentOwnsPR = isTruthyMeta(task?.metadata?.openPR) && canTypeSlashCommands({
      providerId: persistedAgent?.metadata?.providerId ?? agent.providerId,
      providerCommand: persistedAgent?.metadata?.providerCommand ?? null,
      leanMode: persistedAgent?.metadata?.leanMode === true,
    });

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
    // emitLog + the agent's persisted state (completeAgent is the first
    // STATE WRITE inside finalizeAgent and the most likely throw point —
    // the output-hook dispatch and success-criteria evaluation now precede
    // it (#2727) but both carry their own .catch, so neither throws out —
    // the partial-state cases are best-effort by design).
    let finalizeError = null;
    // The verdict finalizeAgent persisted — a PR-claim downgrade (#3358) has to
    // reach the cleanup below, which otherwise removes the worktree, deletes the
    // local branch, and skips the resume pointer for a run it believes succeeded.
    let cleanupSuccess = effectiveSuccess;
    // Whether finalize's PR-claim check actually produced a forge answer. Threaded
    // to cleanup rather than re-derived there: a run whose check threw, was
    // user-terminated, or whose finalize threw outright verified nothing, and
    // cleanup must ask the forge itself rather than assume the PR exists.
    let runnerPrClaimVerified = false;
    try {
      const finalized = await finalizeAgent({
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
        workspacePath: agent.workspacePath || null,
        prExpected: runnerAgentOwnsPR,
        // The run window the commit criterion is evaluated against (#3637).
        startedAt: Number.isFinite(runStartedAt) ? runStartedAt : null,
      });
      if (finalized && typeof finalized.success === 'boolean') cleanupSuccess = finalized.success;
      runnerPrClaimVerified = prClaimWasVerified(finalized?.prVerdict);
    } catch (err) {
      finalizeError = err;
      emitLog('error', `finalizeAgent threw for ${agentId} (continuing cleanup): ${err.message}`, { agentId, error: err.message });
    }

    // Post-finalize cleanup: JIRA push/PR/comment, plan-question marker,
    // pipeline progression, the Creative Director chain hook, and worktree
    // cleanup (+ cleanup-warning notification and merge-recovery task). Runs
    // inside this try so a throw still hits the finally below.
    await runAgentCompletionCleanup({ agentId, task, agent, effectiveSuccess: cleanupSuccess, outputBuffer, prClaimVerified: runnerPrClaimVerified });

    // Surface a finalizeAgent throw to the caller after best-effort
    // cleanup completed — without this the runner harness would never see
    // the failure and couldn't requeue or alert.
    if (finalizeError) throw finalizeError;
  });
}
