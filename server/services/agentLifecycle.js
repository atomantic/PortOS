import { isPrivateSecurityTask } from '../lib/privateSecurityPolicy.js';
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
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { cosEvents, emitLog } from './cosEvents.js';
import { updateAgent, completeAgent } from './cosAgentLifecycle.js';
import { getTaskById, updateTask, getAgentRecord } from './cos.js';
import { spawnAgentViaRunner, getRunnerHealth, classifyRunnerSpawnFailure, RUNNER_SPAWN_REFUSED, RUNNER_SPAWN_AMBIGUOUS } from './cosRunnerClient.js';
import { isInternalTaskId } from '../lib/taskParser.js';
import { PATHS, sleep, tryReadFile } from '../lib/fileUtils.js';
import { completeExecution, errorExecution } from './toolStateMachine.js';
import { release } from './executionLanes.js';
import { analyzeAgentFailure } from './agentErrorAnalysis.js';
import { appendRunEvent } from './agentRunEventLog.js';
import { committedDuringRun, toEpochMs } from '../lib/gitCommitProbe.js';
import { providerSuppliesGithubToken } from '../lib/providerModels.js';
import { canTypeSlashCommands } from '../lib/slashdoInvocation.js';
import { prClaimWasVerified } from '../lib/prDisposition.js';
import { composeProviderEnv } from '../lib/cliChildEnv.js';
import { cliProviderAuthDescriptor } from '../lib/processEnv.js';
import { isClaudeCliProvider, getClaudeSettingsEnv } from './agentCliSpawning.js';
import { resolveForgeTokenEnv } from './forgeAuth.js';
import { resolveAgentApiEnv } from './agentApiAuth.js';
import { runnerAgents, pausedAgents, consumePausedAgentExit, spawningTasks, isTruthyMeta } from './agentState.js';
import { withSpawnDedupGuard, withMapEntryCleanup, withUpdateInProgressGuard, SPAWN_DEDUP_SKIP, SPAWN_UPDATE_SKIP } from './agentGuards.js';
import { isUpdateInProgress } from './updateChecker.js';
import { createAgentSpawnContext, prepareAgentSpawn } from './agentSpawnPreparation.js';
import { dispatchAgentRun } from './agentSpawnDispatch.js';
import { releaseRetryHold } from './agentWorktreeCleanup.js';
import { runAgentCompletionCleanup } from './agentCompletionCleanup.js';
import { finalizeAgent, releaseAgentLane, retireDeadAgent, stampLiExecutionVerdict } from './agentFinalization.js';
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
    console.warn(`⚠️ Task ${task.id} is already being spawned — ignoring this dequeue`);
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
  const context = createAgentSpawnContext(task);
  try {
    const prepared = await prepareAgentSpawn(task, context);
    if (!prepared) return null;
    return await dispatchAgentRun(prepared, { spawnViaRunner });
  } catch (err) {
    if (!context.setupCatchArmed || context.handedOff) throw err;
    const privateSecurity = isPrivateSecurityTask(task);
    const setupError = privateSecurity
      ? 'Private assessment setup failed. Verify its local model, isolated harness, and source access before retrying.'
      : err.message;
    emitLog('error', `Agent spawn setup failed: ${setupError}`, { taskId: task.id, error: setupError });
    await context.blockAndBail({
      reason: setupError,
      category: 'private-security-setup-failed',
      persist: privateSecurity,
    });
    if (task.metadata?.jobId) {
      cosEvents.emit('job:spawn-failed', { jobId: task.metadata.jobId });
    }
    return null;
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
  // ...plus the loopback PortOS session token the agent's own `curl` snippets
  // need on a password-protected install (agentApiAuth.js); `{}` when auth is
  // off. The runner rebuilds its child env from ITS ambient environment, so like
  // GH_TOKEN this has to ride the explicit delta below or the agent never sees it.
  const [claudeSettingsEnv, forgeTokenEnv, agentApiEnv] = await Promise.all([
    isClaudeCliProvider(provider) ? getClaudeSettingsEnv() : Promise.resolve({}),
    providerSuppliesGithubToken(provider) ? Promise.resolve({}) : resolveForgeTokenEnv(workspacePath),
    resolveAgentApiEnv(),
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
      providerAuth: cliProviderAuthDescriptor(provider),
      // A DELTA, not a full env — the cos-runner bases it on its own process.env
      // and does the PWD pin / CLAUDECODE strip. composeProviderEnv owns the layer
      // order: forgeTokenEnv before provider.envVars so an explicit provider
      // override wins, and the OpenCode declared-models map after it so the
      // injected `--model ollama/<id>` is accepted (#2243/#2190 — this path was
      // the site that sweep originally missed).
      envVars: composeProviderEnv({
        before: { ...forgeTokenEnv, ...claudeSettingsEnv, ...agentApiEnv },
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
 * than redo the work. `retireDeadAgent` (#8440) supplies everything finalize
 * would normally do that still matters here — output hook, sentinel removal,
 * run-record close, agent completion — as the same shared step list the
 * orphan sweep uses. Only the direct-success LI verdict stamp below stays
 * here: it doesn't go through `handleOrphanedTask`, so nothing else stamps
 * it. The failure-path stamp moved INTO `handleOrphanedTask` (every terminal
 * settlement there is now stamped), so this function no longer re-reads the
 * task after calling it.
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
  // `retireDeadAgent` forces a private-security run to `success: false` no
  // matter what the caller passed — mirror that here so the recorded `error`
  // message agrees with the record it lands on instead of leaving a failed
  // record with no error string.
  const willSucceed = success && !isPrivateSecurityTask(task) && !isPrivateSecurityTask(cosAgent);
  const { success: retiredSuccess } = await retireDeadAgent({
    agent: cosAgent,
    task,
    success,
    exitCode,
    duration,
    errorMessage: willSucceed ? undefined : 'Agent completed after server restart',
  });
  if (cosAgent.taskId && task && task.status !== 'completed') {
    if (retiredSuccess) {
      // Stamp the LI hand-off verdict here too (#2779, codex P2) — this post-restart
      // recovery bypasses finalizeAgent, so without it a hand-off that finished while
      // the server was down would never federate its outcome. Only `success` is known
      // on this path (no validationPassed/errorAnalysis), so it records a clean success.
      const taskUpdate = await stampLiExecutionVerdict({ status: 'completed' }, task, { success: retiredSuccess });
      await updateTask(cosAgent.taskId, taskUpdate, task.taskType || 'user');
    } else {
      // Hand the dead run's metadata to the retry handler so it can resume what
      // was left behind. This path bypasses `finalizeAgent` (and its worktree
      // cleanup), so the worktree is still on disk, branch and all — without it
      // the retry builds a fresh tree off the default branch and redoes work
      // that is sitting right there. `handleOrphanedTask` stamps the LI verdict
      // itself on every terminal settlement (#8440), so there is nothing left
      // to re-read and stamp here.
      await handleOrphanedTask(cosAgent.taskId, agentId, getTaskById, { agentMetadata: cosAgent.metadata, agentStartedAt: cosAgent.startedAt });
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
    consumePausedAgentExit(agentId);
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
    // Deliberately the SLASH-command predicate, not the `prOpenedBy` ownership
    // stamp — since #3733 a slashdo-free harness also opens its own PR, but
    // cleanup re-checks the forge and opens one itself when it didn't, so
    // failing the run here for a PR that is about to exist would turn a
    // recovered handoff into a false needs-attention. `resolvePrOwnership`'s
    // `prClaimExpected` is the same expression, for the same reason.
    //
    // `persistedAgent` is the record read once at the top of this callback — see
    // the note there for why the metadata must come off disk rather than the
    // in-memory entry.
    const runnerPrClaimExpected = isTruthyMeta(task?.metadata?.openPR) && canTypeSlashCommands({
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
    let runnerNoChangesToShip = false;
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
        prExpected: runnerPrClaimExpected,
        // The run window the commit criterion is evaluated against (#3637).
        startedAt: Number.isFinite(runStartedAt) ? runStartedAt : null,
      });
      if (finalized && typeof finalized.success === 'boolean') cleanupSuccess = finalized.success;
      runnerPrClaimVerified = prClaimWasVerified(finalized?.prVerdict);
      runnerNoChangesToShip = finalized?.prVerdict?.noChangesToShip === true;
    } catch (err) {
      finalizeError = err;
      emitLog('error', `finalizeAgent threw for ${agentId} (continuing cleanup): ${err.message}`, { agentId, error: err.message });
    }

    // Post-finalize cleanup: JIRA push/PR/comment, plan-question marker,
    // pipeline progression, the Creative Director chain hook, and worktree
    // cleanup (+ cleanup-warning notification and merge-recovery task). Runs
    // inside this try so a throw still hits the finally below.
    await runAgentCompletionCleanup({ agentId, task, agent, effectiveSuccess: cleanupSuccess, outputBuffer, prClaimVerified: runnerPrClaimVerified, noChangesToShip: runnerNoChangesToShip });

    // Surface a finalizeAgent throw to the caller after best-effort
    // cleanup completed — without this the runner harness would never see
    // the failure and couldn't requeue or alert.
    if (finalizeError) throw finalizeError;
  });
}
