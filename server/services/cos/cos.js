/**
 * Chief of Staff (CoS) Service
 *
 * Manages the autonomous agent manager that works the task queues,
 * spawns sub-agents, and orchestrates task completion.
 *
 * Decomposed modules:
 * - cosDequeue.js       — event-driven queue admission and dispatch
 * - cosOrphanReset.js   — stale task-state reconciliation
 * - cosPerpetualRefill.js — queues the next task after a perpetual completion
 * - cosState.js          — shared state management (loadState, saveState, config, mutex)
 * - cosAgentLifecycle.js — agent lifecycle (register, update, complete, terminate)
 * - cosAgentIndex.js     — date-bucket index + on-disk archive layout
 * - cosAgentFeedback.js  — per-agent feedback capture + task-type classifier
 * - cosAgentArchive.js   — state-eviction sweeps
 * - cosReports.js        — reports, briefings, and activity tracking
 * - cosEvents.js         — event emitter and logging
 * - cosHealthMonitor.js  — daemon health checks (PM2/memory, auto-restart)
 */

import { maintenance } from '../../lib/maintenanceAdmission.js';
import { isHostShuttingDown } from '../../lib/hostShutdown.js';
import { mergePersistentMindMaintainer } from '../../lib/persistent/persistentMindMaintainer.js';
import { getActiveProvider } from '../provider/providers.js';
import { unclaimedTaskIds, runningAgentsByTaskId, spawningAgentForTask, spawnClaimAgeMs } from '../../lib/cos/cosSpawnWindow.js';
import { clearStaleActiveAgents } from '../appActivity.js';
import { logCosScheduleUpdate } from '../userActionScheduleLog.js';
import { schedule as scheduleEvent, cancel as cancelEvent, getEvent } from '../eventScheduler.js';
import { COMPLETION_RECOVERY_BATCH_SIZE } from '../agent/agentDeliveryActivity.js';
import { recordJobExecution } from '../autonomousJobs.js';
import { sleep } from '../../lib/fileUtils.js';
import { currentTaskTypeName } from '../../lib/taskTypeRenames.js';
import { addNotification, NOTIFICATION_TYPES } from '../notifications.js';
import { todayInTimezone } from '../../lib/timezone.js';
import { getUserTimezone } from '../userTimezone.js';
import { normalizeDomainAutonomy, getDomainMode } from '../../lib/domainAutonomy.js';
import { normalizeDomainBudgets } from '../../lib/domainBudgets.js';
import { mergePersistentMindCapabilities } from '../../lib/persistent/persistentMindCapabilities.js';
import { mergePersistentMindProfile, normalizePersistentMindProfile } from '../../lib/persistent/persistentMindProfile.js';
import { mergePersistentMindPrompt } from '../../lib/persistent/persistentMindPrompt.js';
import { mergePersistentMindPlaybook } from '../../lib/persistent/persistentMindPlaybook.js';
import { mergePersistentMindThinkingPresets } from '../../lib/persistent/persistentMindThinkingPresets.js';
import { hasActiveTaskOwner } from '../agent/agentState.js';

// Shared state management (extracted to avoid circular deps)
import { loadState, saveState, withStateLock, loadConfig, saveConfig, withConfigLock, ensureDirectories, canQueueImprovementTasks, isDaemonRunning, setDaemonRunning, DEFAULT_CONFIG } from './cosState.js';
import { ServerError } from '../../lib/errorHandler.js';

// Events and logging
import { cosEvents, emitLog } from './cosEvents.js';

import { runHealthCheck } from './cosHealthMonitor.js';

// Task store: CRUD + queue persistence (the `cos_tasks` queues). Callers import
// these from the declaring modules, not from here. The store
// emits `tasks:changed`; init() turns that into a request to the dequeue scheduler.
import { getPendingTaskIds as readPendingTaskIds, getCosTasks, getAllTasks, getTaskById, updateTask, sweepResolvedFailureTasks } from './cosTaskStore.js';
import { isLeaseLive } from './cosTaskClaim.js';
import { retryTasksResolvedByInvestigation } from '../investigationRetry.js';
import { MAX_TOTAL_SPAWNS } from '../../lib/cos/cosTaskMetadata.js';
import { handBackBlockedPrRemediation } from '../blockedPrRemediation.js';
import { notifyCriticalHealth, clearCriticalHealthIfRecovered } from '../healthCriticalNotifier.js';
import { loadLateBoundService } from '../../lib/lateBoundServices.js';

const RESUME_DEQUEUE_DELAY_MS = 500;
// CD recovery normally resolves in <100ms; hold start() at most this long so
// a stuck recovery doesn't block daemon boot indefinitely.
const CD_RECOVERY_BOOT_TIMEOUT_MS = 60_000;
// Initial idle-review queue kicks off after start() — far enough back that
// a fresh install isn't overwhelmed but close enough to not stall users.
const POST_STARTUP_QUEUE_DELAY_MS = 30_000;
// Boot can reach the auto-start path from more than one initializer while the
// server and runner settle. A boolean check is not sufficient: both callers
// can observe the daemon as stopped before either one sets the in-memory flag.
// Share the entire startup promise so recovery, scheduling, and the initial
// dequeue happen exactly once.
let daemonStartPromise = null;

// Internal imports for functions used in this module
import { loadAgentIndex } from './cosAgentIndex.js';
import { archiveStaleAgents as _archiveStaleAgents } from './cosAgentArchive.js';
import { initializeAgentFeedback } from './cosAgentFeedback.js';
import { resolveAgentProviderAndModel } from '../agent/agentProviderResolution.js';

import { evaluateTasks, unblockExpiredCooldowns } from './cosTaskGenerator.js';

// Autonomous-job + improvement-check timer machinery (extracted to
// cosJobScheduler.js). Imported for internal use by start()/stop()/init() and
// the job-lifecycle event handlers below. The improvement-check timer asks for
// a dequeue via the `cos:dequeue-requested` event wired in init().
import {
  registerJobSchedules,
  unregisterJobSchedules,
  scheduleNextImprovementCheck,
  registerSingleJobSchedule,
  clearSpawningJob,
  handleJobSpawnFailed,
  handleJobAgentCompleted
} from './cosJobScheduler.js';

import { localEndpointCapacityError } from './cosLocalEndpointSlots.js';
import {
  initializePersistentMindSupervisor,
  shutdownPersistentMindSupervisor,
  handlePersistentMindGlobalPause,
  handlePersistentMindGlobalResume,
  refreshPersistentMindWakeCadence,
  registerPersistentMindTurnAdapter,
  unregisterPersistentMindTurnAdapter,
} from '../persistent/persistentMindSupervisor.js';
import { requireCosOrphanRecoveryHandlers } from '../bootHookRegistry.js';
import { approvePersistentMindThinkingPresets, cancelPersistentMindThinkingRequest } from '../persistent/persistentMindThinkingRequests.js';
// `../persistent/persistentMindAdapter.js` is late-bound where the daemon registers the
// adapter, NOT imported here. It pulls in the whole CoS tool registry — and through it the
// voice tool surface, ask service and image-gen backends — a graph the daemon only
// executes once it is actually running, but that a static edge instantiated in
// every suite importing cos.js for an unrelated helper.

import { dequeueNextTask, isRunnerHolding, scheduleDequeue, tryImmediateSpawn } from './cosDequeue.js';
import { resetOrphanedTasks } from './cosOrphanReset.js';
import { agentScheduledType, perpetualRefillPlan, refillPerpetualForCompletedAgent } from './cosPerpetualRefill.js';

export { dequeueNextTask, perpetualRefillPlan, resetOrphanedTasks };
export { isPerpetualRefillCandidate } from './cosPerpetualRefill.js';

/**
 * Get current CoS status
 */
export async function getStatus() {
  const state = await loadState();
  const provider = await getActiveProvider();
  const idx = await loadAgentIndex();

  // Count active agents from state
  const activeAgents = Object.values(state.agents).filter(a => a.status === 'running').length;
  const pausedAgents = Object.values(state.agents).filter(a => a.status === 'paused').length;

  // Derive tasksCompleted from union of index (disk) + state completed agents,
  // since state.stats.tasksCompleted can drift after state resets
  const stateCompletedIds = Object.keys(state.agents).filter(id => state.agents[id].status === 'completed');
  const stateOnlyCompleted = stateCompletedIds.filter(id => !idx.has(id)).length;
  const tasksCompleted = Math.max(state.stats.tasksCompleted, idx.size + stateOnlyCompleted);
  const recoveryEvent = getEvent('cos-pending-merge-sweep');
  const recoveryBlocked = !isDaemonRunning() ? 'CoS is stopped' : state.paused ? 'CoS is paused'
    : getDomainMode(state.config, 'cos') !== 'execute' ? 'CoS auto-run must be in Execute mode'
      : !recoveryEvent?.active ? 'Completion recovery is not scheduled' : null;

  return {
    running: isDaemonRunning(),
    paused: state.paused || false,
    pausedAt: state.pausedAt,
    pauseReason: state.pauseReason,
    config: state.config,
    stats: { ...state.stats, tasksCompleted },
    activeAgents,
    pendingTasks: unclaimedTaskIds(await readPendingTaskIds(), runningAgentsByTaskId(Object.values(state.agents))).length,
    pausedAgents,
    completionRecovery: {
      blockedReason: recoveryBlocked,
      nextRunAt: recoveryBlocked ? null : recoveryEvent.nextRunAt,
      intervalMs: recoveryEvent?.intervalMs || null,
      batchSize: COMPLETION_RECOVERY_BATCH_SIZE,
    },
    provider: provider ? { id: provider.id, name: provider.name } : null
  };
}

/**
 * Update configuration
 */
export async function updateConfig(updates) {
  let persistentMindWakeCadenceChanged = false;
  // Config has its own file and its own tail (#6182) — a settings write no
  // longer serializes behind the runtime-record writes in state.json.
  const config = await withConfigLock(async () => {
    const current = await loadConfig();
    // domainAutonomy is a partial-friendly map: a PATCH that names only one
    // domain must merge over the others rather than replace the whole object.
    // Capture the prior map BEFORE the spread clobbers it, then normalize the
    // merge so an unknown/invalid stored value resolves to the `execute` default.
    const priorDomainAutonomy = current.domainAutonomy;
    // Same for domainBudgets — a PATCH naming one domain (or one cap on one
    // domain) must merge field-by-field over the rest, not replace the map.
    const priorDomainBudgets = current.domainBudgets;
    const priorPersistentMindCapabilities = current.persistentMindCapabilities;
    const priorPersistentMindProfile = current.persistentMindProfile;
    const priorPersistentMindPrompt = current.persistentMindPrompt;
    const priorPersistentMindPlaybook = current.persistentMindPlaybook;
    const priorPersistentMindThinkingPresets = current.persistentMindThinkingPresets;
    const next = { ...current, ...updates };
    if (updates.persistentMindMaintainer !== undefined) {
      next.persistentMindMaintainer = mergePersistentMindMaintainer(current.persistentMindMaintainer, updates.persistentMindMaintainer);
    }
    if (updates.domainAutonomy !== undefined) {
      next.domainAutonomy = normalizeDomainAutonomy({
        ...priorDomainAutonomy,
        ...updates.domainAutonomy
      });
    }
    if (updates.domainBudgets !== undefined) {
      const mergedBudgets = { ...priorDomainBudgets };
      for (const [id, caps] of Object.entries(updates.domainBudgets)) {
        mergedBudgets[id] = { ...(priorDomainBudgets?.[id] || {}), ...caps };
      }
      next.domainBudgets = normalizeDomainBudgets(mergedBudgets);
    }
    if (updates.persistentMindProfile !== undefined) {
      const nextPersistentMindProfile = mergePersistentMindProfile(
        priorPersistentMindProfile,
        updates.persistentMindProfile,
      );
      persistentMindWakeCadenceChanged = nextPersistentMindProfile.wakeIntervalMinutes
        !== normalizePersistentMindProfile(priorPersistentMindProfile).wakeIntervalMinutes;
      next.persistentMindProfile = nextPersistentMindProfile;
    }
    if (updates.persistentMindCapabilities !== undefined) {
      next.persistentMindCapabilities = mergePersistentMindCapabilities(
        priorPersistentMindCapabilities,
        updates.persistentMindCapabilities,
      );
    }
    if (updates.persistentMindThinkingPresets !== undefined) {
      next.persistentMindThinkingPresets = mergePersistentMindThinkingPresets(
        priorPersistentMindThinkingPresets,
        updates.persistentMindThinkingPresets,
      );
    }
    if (updates.persistentMindCapabilities?.thinkingPresetAllowlist !== undefined) {
      next.persistentMindCapabilities.thinkingPresetGrants = await approvePersistentMindThinkingPresets(
        next, next.persistentMindCapabilities.thinkingPresetAllowlist,
      );
    }
    if (updates.persistentMindPrompt !== undefined) {
      next.persistentMindPrompt = mergePersistentMindPrompt(
        priorPersistentMindPrompt,
        updates.persistentMindPrompt,
      );
    }
    if (updates.persistentMindPlaybook !== undefined) {
      next.persistentMindPlaybook = mergePersistentMindPlaybook(
        priorPersistentMindPlaybook,
        updates.persistentMindPlaybook,
      );
    }
    // A PATCH names one approval field at a time. Spreading `updates` would
    // replace the whole gate and drop the siblings the client did not send.
    if (updates.confidenceAutoApproval !== undefined) {
      next.confidenceAutoApproval = {
        ...DEFAULT_CONFIG.confidenceAutoApproval,
        ...(current.confidenceAutoApproval || {}),
        ...updates.confidenceAutoApproval,
      };
      const { lowThreshold, highThreshold } = next.confidenceAutoApproval;
      const touchesThreshold = updates.confidenceAutoApproval.lowThreshold != null
        || updates.confidenceAutoApproval.highThreshold != null;
      if (touchesThreshold && lowThreshold > highThreshold) {
        throw new ServerError('confidenceAutoApproval.lowThreshold must be less than or equal to highThreshold', {
          status: 400,
          code: 'VALIDATION_ERROR',
        });
      }
    }
    if (updates.safetyKindApproval !== undefined) {
      next.safetyKindApproval = {
        ...DEFAULT_CONFIG.safetyKindApproval,
        ...(current.safetyKindApproval || {}),
        ...updates.safetyKindApproval,
      };
    }
    return saveConfig(next);
  });
  if (updates.persistentMindCapabilities !== undefined || updates.persistentMindThinkingPresets !== undefined) {
    await cancelPersistentMindThinkingRequest({ ifRevoked: true });
  }
  const improveKeys = ['improvementEnabled', 'selfImprovementEnabled', 'appImprovementEnabled'];
  const improvePatch = Object.fromEntries(
    improveKeys.filter((key) => Object.hasOwn(updates, key)).map((key) => [key, updates[key]]),
  );
  await logCosScheduleUpdate({
    target: 'cos-config',
    patch: improvePatch,
    source: { service: 'cos', fn: 'updateConfig' },
  });
  cosEvents.emit('config:changed', config);
  if (persistentMindWakeCadenceChanged) {
    await refreshPersistentMindWakeCadence();
  }
  if (isDaemonRunning() && updates.domainAutonomy !== undefined) {
    const mode = getDomainMode(config, 'cos');
    if (mode === 'execute') await handlePersistentMindGlobalResume();
    else await handlePersistentMindGlobalPause(`CoS autonomy changed to ${mode}`);
  }
  return config;
}

/**
 * Start the CoS daemon
 */
export function start() {
  if (!daemonStartPromise) {
    daemonStartPromise = runStart().finally(() => {
      daemonStartPromise = null;
    });
  }
  return daemonStartPromise;
}

async function runStart() {
  if (isDaemonRunning()) {
    emitLog('info', '⏭️ CoS already running');
    return { success: true, unchanged: true };
  }

  emitLog('info', 'Starting Chief of Staff daemon...');

  const state = await withStateLock(async () => {
    const s = await loadState();
    s.running = true;
    await saveState(s);
    return s;
  });

  setDaemonRunning(true);

  try {
    await bootDaemon(state);
  } catch (err) {
    // A failed start must not leave the flag reading "Already running" with
    // half the timers armed — tear down whatever was scheduled, then rethrow.
    console.error(`❌ CoS daemon start failed: ${err?.message || err}`);
    await teardownDaemon().catch(teardownErr =>
      console.error(`❌ CoS teardown after failed start failed: ${teardownErr?.message || teardownErr}`));
    throw err;
  }
  return { success: true };
}

async function bootDaemon(state) {
  // First clean up orphaned agents (agents marked running but no live process)
  const { cleanupOrphanedAgents } = requireCosOrphanRecoveryHandlers();
  const cleanedAgents = await cleanupOrphanedAgents();
  if (cleanedAgents > 0) {
    emitLog('info', `Cleaned up ${cleanedAgents} orphaned agent(s)`);
  }

  // Wait for Creative Director boot recovery to finish retiring stale CD
  // tasks before we reset orphans. Without this gate, resetOrphanedTasks
  // would respawn stale CD treatment/evaluate tasks before recovery can
  // mark them `completed`, racing two agents on the same project. The
  // promise resolves whether recovery ran successfully, was a no-op (no
  // mid-flight projects), or wasn't called at all (markRecoveryDone is
  // exposed for that case). 60s ceiling — recovery on a healthy boot
  // resolves in <100ms, but we'd rather pay a slow-boot tax than reopen
  // the duplicate-agent race when initMediaJobQueue or earlier startup
  // steps stall.
  const { cdRecoveryDone } = await import('../creativeDirector/recovery.js');
  await Promise.race([
    cdRecoveryDone,
    sleep(CD_RECOVERY_BOOT_TIMEOUT_MS),
  ]);

  // Then reset any orphaned in_progress tasks (no running agent)
  await resetOrphanedTasks({ bootRecovery: true });

  // Clear stale activeAgentId pointers in app-activity.json. Without this, an
  // idle-review agent that died across a restart (or a long-stale Feb-era state
  // file) leaves activeAgentId set forever — isAppOnCooldown treats that as
  // "agent still working" and queueEligibleImprovementTasks silently skips the
  // app every cycle. Re-load state since the orphan-cleanup steps above have
  // already mutated the on-disk agents map.
  const freshState = await loadState();
  const liveAgentIds = new Set(Object.keys(freshState.agents || {}));
  const { cleared: clearedActiveAgents } = await clearStaleActiveAgents(liveAgentIds).catch(err => {
    console.warn(`⚠️ clearStaleActiveAgents failed: ${err?.message || err}`, err?.stack || '');
    return { cleared: [] };
  });
  if (clearedActiveAgents.length > 0) {
    emitLog('info', `🧹 Cleared ${clearedActiveAgents.length} stale activeAgentId pointer(s) from app-activity`);
  }

  // Archive stale completed agents from state.json on startup
  const { archived } = await _archiveStaleAgents().catch(err => {
    console.warn(`⚠️ _archiveStaleAgents failed: ${err?.message || err}`, err?.stack || '');
    return { archived: 0 };
  });
  if (archived > 0) {
    emitLog('info', `📦 Startup: archived ${archived} stale agent(s) from state`);
  }

  // Lossless raw-recording maintenance; historical records never expire.
  scheduleEvent({
    id: 'cos-recording-maintenance', type: 'interval', intervalMs: 3600000,
    handler: async () => {
      const { runAutomaticAgentStorage } = await import('./cosAgentStorage.js');
      await runAutomaticAgentStorage();
    },
    metadata: { description: 'Compress old CoS raw recordings; retain run history' }
  });

  // Health check + orphan cleanup (15 min)
  scheduleEvent({
    id: 'cos-health-check',
    type: 'interval',
    intervalMs: state.config.healthCheckIntervalMs,
    handler: async () => {
      if (!isDaemonRunning()) return;
      await runHealthCheck();
      const { runDevelopmentWatchdog } = await import('../developmentWatchdog.js');
      await runDevelopmentWatchdog().catch(err => console.error(`❌ Development watchdog failed: ${err.message}`));
      const cleaned = await cleanupOrphanedAgents();
      if (cleaned > 0) {
        emitLog('info', `🧹 Periodic cleanup: ${cleaned} orphaned agent(s)`);
      }
      await resetOrphanedTasks();
      const { recoverBlockedSystemTasks } = await import('../blockedSystemInvestigation.js');
      await recoverBlockedSystemTasks().catch(err => console.error(`❌ Blocked-system investigation recovery failed: ${err.message}`));
      // Evaluation is event-driven, so without this cadence a timed pause
      // (`worktree-busy`, `orphan-cooldown`) whose `cooldownUntil` lapsed would
      // sit blocked until the next restart or manual evaluate.
      const revived = await getAllTasks()
        .then(({ user, cos: internal }) => unblockExpiredCooldowns(user, internal))
        .catch((err) => {
          console.warn(`⚠️ unblockExpiredCooldowns failed: ${err?.message || err}`);
          return 0;
        });
      if (revived > 0) scheduleDequeue();
      const { archived } = await _archiveStaleAgents().catch(err => {
        console.warn(`⚠️ _archiveStaleAgents failed: ${err?.message || err}`, err?.stack || '');
        return { archived: 0 };
      });
      if (archived > 0) {
        emitLog('info', `📦 Auto-archived ${archived} stale agent(s) from state`);
      }
      // Reap resolved failure artifacts (stale failure-blocked tasks +
      // investigations whose origin is gone/completed) via federation-safe
      // status flip — never deletion (#2619). Bounded per tick by the store.
      const swept = await sweepResolvedFailureTasks().catch((err) => {
        console.warn(`⚠️ sweepResolvedFailureTasks failed: ${err?.message || err}`);
        return { reaped: 0 };
      });
      if (swept.reaped > 0) {
        emitLog('info', `🧹 Auto-expired ${swept.reaped} resolved failure task(s) (${swept.staleBlocks} block(s), ${swept.investigations} investigation(s))`);
      }
    },
    metadata: { description: 'CoS health check + orphan cleanup + agent archival + failure-artifact reaper' }
  });

  // Pending-merge drain (30 min). `evaluateTasks` also sweeps opportunistically,
  // but evaluation is event-driven — with no periodic evaluation timer that drain
  // fires roughly once per restart, so a green merge-only PR opened while PortOS
  // runs would sit at `ticks: 0` forever (#3630). This timer is the cadence
  // `MAX_PENDING_MERGE_TICKS` is documented against, and it is deliberately NOT
  // coupled to the `pr-watcher` task type — a disabled watcher must not strand
  // queued merges. Same autonomy gate as the evaluateTasks call site: merging
  // writes to a default branch, so it only runs when the user has CoS auto-run
  // set to `execute` and the daemon is not paused.
  // The handoff follow-up poll (prWatcher.followUpHandoffReceipt) shares the
  // gate and is cancelled with the daemon.
  // Existing retirement journals must recover even when branch-reconcile is
  // disabled or every agent slot is occupied. The service reuses its exact cut;
  // it never goes through normal agent/worktree admission.
  scheduleEvent({
    id: 'cos-runtime-verification', type: 'interval', intervalMs: 60 * 1000,
    handler: async () => {
      if (await pendingMergeSweepBlocked()) return;
      const { sweepRuntimeVerifications } = await import('../runtimeVerification.js');
      await sweepRuntimeVerifications().catch(error => console.warn(`⚠️ Runtime verification deferred: ${error.message}`));
    },
    metadata: { description: 'Resume runtime verification after a verified boot' },
  });
  const { PENDING_MERGE_SWEEP_INTERVAL_MS, setHandoffFollowUpGate } = await import('../prWatcher.js');
  setHandoffFollowUpGate(pendingMergeSweepBlocked);
  scheduleEvent({
    id: 'cos-pending-merge-sweep',
    type: 'interval',
    intervalMs: PENDING_MERGE_SWEEP_INTERVAL_MS,
    handler: async () => {
      if (await pendingMergeSweepBlocked()) return;
      const { sweepRepoStateVerifications } = await import('../agent/agentRepoStateVerification.js');
      await sweepRepoStateVerifications().catch(err => console.warn(`⚠️ Completion recovery sweep deferred: ${err.message}`));
      const prWatcher = await import('../prWatcher.js');
      const sweep = await prWatcher.sweepPendingMergePrs().catch((err) => {
        console.warn(`⚠️ sweepPendingMergePrs failed: ${err?.message || err}`);
        return null;
      });
      if (sweep && (sweep.merged || sweep.escalated || sweep.timedOut)) {
        emitLog('info', `🤖 Pending merges: ${sweep.merged} merged, ${sweep.escalated} escalated, ${sweep.timedOut} timed out`);
      }

    },
    metadata: { description: 'CoS pending merge-only PR drain' }
  });

  // Register autonomous job schedules (individual timers per job)
  await registerJobSchedules();

  // Schedule improvement task checks based on next due time
  await scheduleNextImprovementCheck();

  // Run initial evaluation to pick up existing pending tasks, then health check
  // Skip improvement task generation on startup to avoid spawning agents on fresh installs
  emitLog('info', 'Running initial task evaluation...');
  await evaluateTasks({ initialStartup: true });
  await runHealthCheck();
  const { createPersistentMindTurnAdapter } = await loadLateBoundService('persistentMindAdapter');
  await registerPersistentMindTurnAdapter(createPersistentMindTurnAdapter());
  await initializePersistentMindSupervisor();

  cosEvents.emit('status', { running: true });
  emitLog('success', 'CoS daemon started');

  // Recover durable completions from the previous process immediately. The
  // periodic sweep remains crash fallback, not the first post-restart attempt.
  void resumeDeferredCompletions().catch(error => emitLog('warn', `Completion recovery deferred after startup: ${error.message}`));

  // Queue due improvement tasks shortly after startup (not during initial eval
  // to avoid overwhelming fresh installs, but soon enough to not stall)
  setTimeout(() => {
    if (!isDaemonRunning()) return;
    loadState().then(async (state) => {
      // Gate on the CoS auto-run domain (parity with evaluateTasks and the
      // cos-improvement-check timer) — see canQueueImprovementTasks.
      if (!canQueueImprovementTasks(state)) return;
      const cosTaskData = await getCosTasks();
      const { queueEligibleImprovementTasks } = await import('./cosImprovementTasks.js');
      await queueEligibleImprovementTasks(state, cosTaskData);
      scheduleDequeue();
    }).catch(err => emitLog('warn', `Post-startup improvement queuing failed: ${err.message}`));
  }, POST_STARTUP_QUEUE_DELAY_MS);
}

/** Replay the initial pending snapshot in bounded batches on a lifecycle wake-up.
 * The verifier already coalesces concurrent callers and retains retry backoff.
 * This never starts a paused/stopped daemon or grants investigation authority.
 */
export async function resumeDeferredCompletions() {
  if (maintenance.held()) return { checked: 0, skipReason: 'maintenance-held' };
  const reason = await pendingMergeSweepBlocked();
  if (reason) return { checked: 0, skipReason: reason };
  const { resumeDeferredRepoStateVerifications } = await import('../agent/agentRepoStateVerification.js');
  return resumeDeferredRepoStateVerifications(async () => maintenance.held()
    ? 'maintenance-held' : pendingMergeSweepBlocked());
}

// Null when a pending-merge sweep may merge, else the skip reason.
async function pendingMergeSweepBlocked() {
  if (!isDaemonRunning()) return 'daemon-stopped';
  const s = await loadState();
  if (s.paused) return 'daemon paused';
  if (getDomainMode(s.config, 'cos') !== 'execute') return 'CoS auto-run is not set to execute';
  return null;
}

/**
 * Stop the CoS daemon
 */
export async function stop() {
  // A Stop issued mid-start would otherwise see the flag already true, cancel
  // timers that don't exist yet, and then watch the resumed boot arm them all
  // (#11860). Let the start settle so Stop tears down a fully started daemon.
  if (daemonStartPromise) await daemonStartPromise.catch(() => {});
  if (!isDaemonRunning()) {
    return { success: true, unchanged: true };
  }

  await teardownDaemon();
  return { success: true };
}

async function teardownDaemon() {
  await shutdownPersistentMindSupervisor();
  unregisterPersistentMindTurnAdapter();

  // Cancel all scheduled events
  cancelEvent('cos-health-check');
  cancelEvent('cos-recording-maintenance');
  cancelEvent('cos-improvement-check');
  cancelEvent('cos-runtime-verification');
  cancelEvent('cos-pending-merge-sweep');
  (await import('../prWatcher.js')).cancelHandoffFollowUps();
  await unregisterJobSchedules();

  await withStateLock(async () => {
    const state = await loadState();
    state.running = false;
    await saveState(state);
  });

  setDaemonRunning(false);
  cosEvents.emit('status', { running: false });
}

/**
 * Pause the CoS daemon (for always-on mode)
 * Daemon stays running but skips evaluations
 */
export async function pause(reason = null) {
  const result = await withStateLock(async () => {
    const state = await loadState();

    if (state.paused) {
      return { success: true, unchanged: true, pausedAt: state.pausedAt };
    }

    state.paused = true;
    state.pausedAt = new Date().toISOString();
    state.pauseReason = reason;
    await saveState(state);

    emitLog('info', `CoS paused${reason ? `: ${reason}` : ''}`);
    cosEvents.emit('status:paused', { paused: true, pausedAt: state.pausedAt, reason });
    return { success: true, pausedAt: state.pausedAt };
  });
  if (result.success && !result.unchanged) await handlePersistentMindGlobalPause(reason || 'Chief of Staff paused');
  return result;
}

/**
 * Resume the CoS daemon from pause
 */
export async function resume() {
  const result = await withStateLock(async () => {
    const state = await loadState();

    if (!state.paused) {
      return { success: true, unchanged: true };
    }

    state.paused = false;
    state.pausedAt = null;
    state.pauseReason = null;
    await saveState(state);

    emitLog('info', 'CoS resumed');
    cosEvents.emit('status:resumed', { paused: false });
    return { success: true };
  });

  // Trigger immediate task dequeue on resume (outside lock to avoid holding it)
  if (!result.unchanged && isDaemonRunning()) {
    await handlePersistentMindGlobalResume();
    setTimeout(() => scheduleDequeue(), RESUME_DEQUEUE_DELAY_MS);
  }

  return result;
}

/**
 * Check if CoS is paused
 */
export async function isPaused() {
  const state = await loadState();
  return state.paused || false;
}

/** A stopped task is spawnable only through an explicit budget reset, which has its own ownership fence. */
const isStoppedForReset = (task, resetSpawnBudget) => resetSpawnBudget && ['in_progress', 'blocked'].includes(task.status);

/**
 * The task as its stale holder's retirement left it, ready for an explicit spawn.
 *
 * The reaper hands a dead run's task to `handleOrphanedTask`, which decides
 * the AUTOMATIC retry: requeue, an `orphan-cooldown` block, a `max-retries`
 * block, or `completed` when the dead run had already committed. "Run now" is
 * the user asking for this retry, so it lifts the timed backoff that exists to
 * pace automatic ones. The other outcomes are verdicts, and it reports them.
 *
 * @returns {Promise<{ task: object } | { error: string }>}
 */
async function taskAfterHolderRetired(taskId, holder, resetSpawnBudget) {
  const task = await getTaskById(taskId);
  if (!task) return { error: 'Task not found' };
  if (task.status === 'pending' || isStoppedForReset(task, resetSpawnBudget)) return { task };
  const { blockedCategory, blockedReason, lastOrphanedAgentId } = task.metadata || {};
  if (task.status !== 'blocked' || blockedCategory !== 'orphan-cooldown' || lastOrphanedAgentId !== holder.id) {
    return { error: `Agent ${holder.id} is no longer running and its task is now ${task.status}${blockedReason ? ` (${blockedReason})` : ''}` };
  }
  const taskType = task.taskType || 'user';
  // Same field set the cooldown sweeper clears (unblockExpiredCooldowns), and
  // only that: the store merges metadata, so an edit that landed since the read
  // above (a re-pinned provider, new context) survives and is what gets
  // spawned. The fence names the block being lifted, so one that changed hands
  // in that time is left alone. The dequeue is suppressed because this call
  // dispatches the task itself.
  const revived = await updateTask(taskId, {
    status: 'pending',
    metadata: { blockedReason: undefined, blockedCategory: undefined, blockedAt: undefined, cooldownUntil: undefined },
  }, taskType, {
    expectedStatus: 'blocked',
    expectedMetadata: { blockedCategory: 'orphan-cooldown', lastOrphanedAgentId: holder.id },
    suppressDequeue: true,
  });
  if (revived?.error) return { error: revived.error };
  if (!revived || revived.statusChanged) return { error: 'Task changed while its dead agent was being retired' };
  return { task: { ...revived, taskType } };
}

/**
 * Force-spawn a pending task by ID, bypassing cooldowns and evaluation intervals.
 */
export async function forceSpawnTask(taskId, { resetSpawnBudget = false } = {}) {
  maintenance.assertOpen();
  // Before the budget-reset write and the `task:ready` emit: an owner registered
  // after the shutdown marker snapshot is charged as an orphan next boot (#14170).
  if (isHostShuttingDown()) return { error: 'PortOS is shutting down — run the task again after it restarts' };
  let task = await getTaskById(taskId);
  if (!task) return { error: 'Task not found' };
  if (task.metadata?.preflight?.requestId) return { error: 'Preflight progress cards cannot be spawned' };
  let resetStopped = isStoppedForReset(task, resetSpawnBudget);
  if (task.status !== 'pending' && !resetStopped) return { error: `Task is ${task.status}, not pending` };
  if (task.approvalRequired) return { error: 'Task requires approval before it can be spawned' };

  const analysis = currentTaskTypeName(task.metadata?.analysisType || task.metadata?.selfImprovementType);
  if (analysis === 'do-release' || analysis === 'release-sync') {
    const { releaseTaskDispatchDisposition } = await import('../releaseSynchronization.js');
    const disposition = await releaseTaskDispatchDisposition(task);
    if (disposition === 'review-policy-unverified') return { error: 'Release synchronization review policy was not captured; recover from historical delivery evidence (docs/VERSIONING.md).' };
    if (disposition === 'retired-continuation') return { error: 'This release synchronization was retired by an operator.' };
    if (disposition === 'delivered-continuation') return { error: 'This release was independently delivered; the historical continuation is retained.' };
    if (disposition === 'wait-for-synchronization') return { error: 'The previous release synchronization is unfinished.' };
  }

  if (!isDaemonRunning()) return { error: 'CoS daemon is stopped — start it before force-spawning tasks' };

  const state = await loadState();
  if (state.paused) return { error: 'CoS daemon is paused — resume before force-spawning tasks' };
  // Dispatch HOLDS a task while the runner is down rather than failing it —
  // right for the autonomous queue, wrong for an explicit "Run now", which would
  // get `{ success: true }` and a "Spawning" toast for a task that quietly stays
  // pending. Say what is actually wrong instead.
  if (await isRunnerHolding()) {
    return { error: 'CoS Runner is not reachable — start the cos-runner app before force-spawning tasks' };
  }
  let running = Object.values(state.agents).filter(a => a.status === 'running');
  // An agent is registered as running BEFORE spawnAgentForTask flips its task off
  // `pending`, so the status check above still passes for the seconds between
  // those two writes — an explicit "Run now" landing there would get a bogus
  // `{ success: true }` and a "Spawning" toast for a second dispatch that
  // withSpawnDedupGuard then silently drops. Refuse it here instead, where every
  // caller (UI, voice, API) sees the same honest answer.
  const runningAgents = runningAgentsByTaskId(running);
  const holder = runningAgents.get(taskId);
  if (resetStopped && holder) return { error: `Agent ${holder.id} still owns this task` };
  if (spawningAgentForTask(taskId, runningAgents)) {
    return { error: `Agent ${holder.id} is already running this task` };
  }
  // Past the spawn window (lib/cos/cosSpawnWindow.js), a `pending` task under a
  // `running` agent is either a zombie record or a live run whose task write
  // lagged. Age is not evidence of death, and prepareAgentSpawn refuses every
  // active owner, so falling through would report a spawn that never happens
  // (#14039). Settle through the one reaper's liveness evidence (pid, runner
  // listing, in-process handles) — the same sweep GET /agents starts — then
  // admit only if the shared ownership gate now agrees. The sweep is
  // single-flight: this joins one already running rather than racing it.
  let ownerAgents = state.agents;
  if (holder) {
    await requireCosOrphanRecoveryHandlers().cleanupOrphanedAgents();
    ownerAgents = (await loadState()).agents;
    running = Object.values(ownerAgents).filter(a => a.status === 'running');
  }
  if (hasActiveTaskOwner(taskId, ownerAgents)) {
    const ownerNote = holder
      ? `Agent ${holder.id} still owns this task (running for ${Math.round(spawnClaimAgeMs(holder) / 1000)}s) and its process could not be confirmed dead`
      : 'A finishing agent still owns this task';
    return {
      error: `${ownerNote} — stop that agent or wait for it to finish before running the task again`,
      code: 'TASK_OWNER_HELD',
    };
  }
  if (holder) {
    const settled = await taskAfterHolderRetired(taskId, holder, resetSpawnBudget);
    if (settled.error) return { error: settled.error };
    task = settled.task;
    resetStopped = isStoppedForReset(task, resetSpawnBudget);
  }
  if (running.length >= state.config.maxConcurrentAgents) {
    return { error: `No available agent slots (${running.length}/${state.config.maxConcurrentAgents})` };
  }

  // Pre-validate provider/model resolution before emitting `task:ready`. The
  // actual spawn runs asynchronously in a `task:ready` listener, so a
  // resolution failure there (e.g. a task pinned to an `api`-type provider with
  // no file-writing harness) would bail silently and leave the task `pending`
  // — while this call had already returned `{ success: true }` and the UI
  // toasted "Spawning". Resolving here surfaces the real, actionable error
  // (which provider to use) synchronously instead of lying to the user.
  const resolution = await resolveAgentProviderAndModel(task);
  if (!resolution.ok) {
    return { error: resolution.error };
  }

  // Same reason as the resolution pre-check above: the local-endpoint cap
  // (#4834) is enforced later, inside the `task:ready` listener, so without this
  // "Run now" would toast "Spawning" for a task the chokepoint immediately holds
  // as pending. Checked against the RESOLVED provider (post-fallback), so it
  // never refuses a run that would have swapped to a cloud provider anyway.
  const localCapacityError = await localEndpointCapacityError(resolution.provider, ownerAgents, taskId);
  if (localCapacityError) {
    return { error: localCapacityError };
  }

  // Same reason once more: the spawn cap is enforced inside the `task:ready`
  // listener, which blocks the task after this call has already answered
  // "Spawning". Name the cap and the way past it instead.
  const totalSpawns = Number(task.metadata?.totalSpawnCount) || 0;
  if (!resetSpawnBudget && totalSpawns >= MAX_TOTAL_SPAWNS) {
    return {
      error: `Spawn budget exhausted (${totalSpawns}/${MAX_TOTAL_SPAWNS}) — reset the spawn budget to run this task again`,
      code: 'SPAWN_BUDGET_EXHAUSTED',
    };
  }
  if (resetSpawnBudget) {
    // The store refuses a reset under a live claim lease; say so instead of the
    // generic "changed" refusal, and when the lease frees up.
    if (isLeaseLive(task.metadata)) return { error: `A claim lease on this task is live until ${task.metadata.leaseExpiresAt}; reset after it expires` };
    const orphan = resetStopped ? await import('../explicitSpawnBudgetReset.js')
      .then(({ prepareExplicitOrphanBudgetReset }) => prepareExplicitOrphanBudgetReset(task)) : null;
    if (orphan?.error) return { error: orphan.error };
    const saved = await updateTask(task.id, { ...(resetStopped ? { status: 'pending' } : {}),
      metadata: { ...orphan?.pointer, totalSpawnCount: undefined } }, task.taskType || 'user', {
      expectedStatus: task.status, expectedTask: { description: task.description, priority: task.priority, metadata: task.metadata },
      recoveryOwner: { id: orphan?.owner?.id || 'explicit-spawn-budget-reset', startedAt: orphan?.owner?.startedAt || null, requireInactive: true,
        ...(orphan?.owner ? { requireRegistered: true, expectedOwnerMetadata: structuredClone(orphan.owner.metadata) } : {}) },
      spawnBudgetOperation: { kind: 'reset', requireInactive: true }, suppressDequeue: true, preserveRetryBudget: true,
    });
    if (saved?.error) return { error: saved.error };
    if (!saved || saved.statusChanged) return { error: 'Task or ownership changed before spawn budget reset' };
    task = { ...saved, taskType: task.taskType || 'user' };
  }

  cosEvents.emit('task:ready', { ...task, taskType: task.taskType || 'internal' });
  return { success: true, taskId };
}

/**
 * Check if daemon is running
 */
export function isRunning() {
  return isDaemonRunning();
}

/**
 * Wire event listeners, load state, and auto-start the daemon when configured.
 * Called once from `server/index.js` during boot.
 */
export async function init() {
  await ensureDirectories();
  initializeAgentFeedback();

  // When an agent completes, refill perpetual work then dequeue the next task
  cosEvents.on('agent:completed', (agent) => {
    // Settle deterministic cleanup even for one-shot/failed runs. Then refill
    // before dequeue so unrelated idle work cannot take the newly freed slot.
    // Each phase owns its rejection because this is an event boundary.
    setImmediate(() => {
      Promise.resolve()
        .then(async () => {
          if (agent?.metadata?.recoveryOrigin?.subsystem === 'repository-cleanup') {
            const { settleRetirementReviewRun } = await import('../branchReconcileCompletion.js');
            await settleRetirementReviewRun(agent);
          }
          if (agentScheduledType(agent) !== 'branch-reconcile') return;
          const { settleBranchReconcileRun } = await import('../branchReconcileCompletion.js');
          await settleBranchReconcileRun(agent);
        })
        .catch(err => console.error(`❌ Branch reconciliation completion failed: ${err.message}`))
        .then(async () => {
          if (!isDaemonRunning() || !agent?.taskId) return;
          const { recoverBlockedSystemTask } = await import('../blockedSystemInvestigation.js');
          await recoverBlockedSystemTask(agent.taskId);
        })
        .catch(err => console.error(`❌ Blocked-system investigation recovery failed: ${err.message}`))
        // A run that finished as the server exits still finalizes, but admits
        // nothing next (#14170). The hourly improvement check resumes the drain.
        .then(() => (isHostShuttingDown() ? null : refillPerpetualForCompletedAgent(agent)))
        .catch(err => console.error(`❌ Perpetual refill after ${agent?.id} failed: ${err.message}`))
        // Same window as the refill above: this runs before the completing
        // task's `updateTask` settles it, so the idle tier's generator must
        // exclude it from any in-flight tally (#3179).
        .then(() => dequeueNextTask({ ignoreTaskId: agent?.taskId }))
        .catch(err => console.error(`❌ Dequeue after ${agent?.id} completion failed: ${err.message}`));
    });

    handleJobAgentCompleted(agent).catch(err =>
      console.error(`❌ Failed to record job incident for agent ${agent?.id}: ${err.message}`));

    // Create notification when a daily briefing completes
    if (agent?.metadata?.jobId === 'job-daily-briefing' && agent?.result?.success) {
      getUserTimezone()
        .then(async tz => {
          const today = todayInTimezone(tz);
          const { getBriefingImageAttachments } = await import('./cosReports.js');
          const attachments = await getBriefingImageAttachments(today);
          return addNotification({
            type: NOTIFICATION_TYPES.BRIEFING_READY,
            title: 'Daily Briefing Ready',
            description: `Your daily briefing for ${today} is ready for review.`,
            priority: 'low',
            link: '/cos/briefing',
            metadata: { date: today, agentId: agent.id, ...(attachments.length ? { attachments } : {}) }
          });
        })
        .catch(err => console.error(`❌ Failed to create briefing notification: ${err.message}`));
    }
  });

  cosEvents.on('swarm:cleanup-delivery-verified', ({ agentId }) => {
    import('../swarmCleanupRefill.js').then(({ refillDeliveredCleanupSwarm }) => refillDeliveredCleanupSwarm(agentId, {
      wake: () => dequeueNextTask(), refillPlan: perpetualRefillPlan,
    }))
      .catch(err => console.error(`❌ Swarm cleanup continuation failed: ${err.message}`));
  });

  // Record autonomous job execution only after the agent actually spawns.
  // Update lastRun BEFORE clearing the spawning guard to prevent a race where
  // a pending timer fires between clearSpawningJob and recordJobExecution,
  // sees no guard and stale lastRun, and spawns a duplicate agent.
  cosEvents.on('job:spawned', async ({ jobId }) => {
    await recordJobExecution(jobId).catch(err =>
      console.error(`❌ Failed to record job execution for ${jobId}: ${err.message}`)
    );
    clearSpawningJob(jobId, { spawned: true });
    // Re-register with updated lastRun so the next timer has the correct delay
    await registerSingleJobSchedule(jobId).catch(err =>
      console.error(`❌ Failed to re-register job schedule for ${jobId}: ${err.message}`)
    );
  });

  cosEvents.on('job:spawn-failed', ({ jobId, reason, error }) =>
    handleJobSpawnFailed(jobId, reason, error).catch(err =>
      console.error(`❌ Failed to re-arm job schedule after spawn failure for ${jobId}: ${err.message}`)
    )
  );

  // Event-driven triggers: task/file changes → dequeueNextTask.
  // The task store (cosTaskStore.js) persists tasks and emits this event; the
  // spawn-side reaction lives here so the store stays free of scheduler logic.
  // - 'added': fill open slots via dequeueNextTask, and (for user tasks) also
  //   fire tryImmediateSpawn so the just-added task starts instantly, bypassing
  //   the evaluation interval that's meant for system task generation.
  // - 'approved': a newly approved task can now spawn — re-run dequeue. Either
  //   queue: a user row withheld by the #7300 hold is released the same way.
  // - 'unblocked': a blocked or completed task flipped back to pending (#2614, #12058)
  //   is newly spawnable exactly like an approval — re-run dequeue.
  // - 'requeued': an in_progress task flipped back to pending — a failed run's
  //   retry released from its cleanup hold (#3373) or an orphan sweep requeue.
  //   Newly spawnable, and long after the completion dequeue ran — re-run dequeue.
  // - a transition INTO `completed` (any action): if the finished task is an
  //   INVESTIGATION, revive the failure-blocked task(s) it was diagnosing instead
  //   of leaving them for a human to un-block by hand.
  cosEvents.on('tasks:changed', (data) => {
    if (!isDaemonRunning() || !data?.action) return;
    if (data.action === 'added') {
      // An explicit dispatcher (for example a scheduled job's Run now route)
      // owns the spawn and will call forceSpawnTask after persistence. Skipping
      // the automatic wake here prevents that dispatcher from racing a normal
      // internal-task dequeue and reporting a false in-progress failure.
      if (data.suppressDequeue) return;
      // Order matters: dequeueNextTask is scheduled before the user-task
      // tryImmediateSpawn, matching the pre-extraction sequence (addTask emitted
      // tasks:changed — registering dequeue via this listener — before it called
      // setImmediate(tryImmediateSpawn)). dequeue fills slots in priority order
      // first; tryImmediateSpawn then handles the just-added task.
      scheduleDequeue();
      if (data.type === 'user' && data.task) setImmediate(() => tryImmediateSpawn(data.task)
        .catch(err => console.error(`❌ Immediate spawn for task ${data.task?.id} failed: ${err?.message ?? String(err)}`)));
    } else if (data.action === 'approved' || data.action === 'unblocked' || data.action === 'requeued') {
      if (data.suppressDequeue) return;
      scheduleDequeue();
    } else if (data.suppressCompletionWake !== true && data.task?.status === 'completed' && data.previousStatus !== 'completed') {
      // A finished investigation releases the task(s) its failure was blocking
      // (see investigationRetry.js). Keyed on the completion rather than on who
      // wrote it, so it covers BOTH an investigation agent finishing its run and
      // a human ticking the task off after fixing the cause by hand — and on the
      // TRANSITION, not the level, so a later edit to an already-completed
      // investigation can't spend a second auto-retry on a task that re-blocked.
      // The service no-ops for every other completed task, and each revive emits
      // its own `unblocked` above, which is what re-runs the dequeue.
      setImmediate(() => retryTasksResolvedByInvestigation(data.task)
        .catch(err => console.error(`❌ Auto-retry after investigation ${data.task?.id} failed: ${err.message}`)));
    }
  });

  // A delivery follow-up owns a parent continuation, not a new cron obligation.
  // Replay of the same completed observation is safe: the parent verifier binds
  // its exact cleanup owner and receipt, and coalesces concurrent wake-ups.
  const { bindCompletionRetirementEvents } = await import('../agent/agentRepoStateVerification.js');
  bindCompletionRetirementEvents(cosEvents);
  const { bindInvestigationDependencyEvents, reconcileInvestigationDependencies } = await import('../investigationDependencyWait.js');
  bindInvestigationDependencyEvents(cosEvents);
  await reconcileInvestigationDependencies().catch(error => console.warn(`⚠️ Investigation dependency recovery deferred: ${error.message}`));

  // Contributor remediation retains its forge hand-back when blocked. Ordinary
  // merge follow-ups stay in automated recovery rather than the human inbox.
  cosEvents.on('tasks:changed', (data) => {
    handBackBlockedPrRemediation(data)
      .catch(err => console.error(`❌ Blocked PR remediation hand-back failed for task ${data?.task?.id}: ${err.message}`));
    if (isDaemonRunning() && data?.type === 'internal' && data.task?.status === 'blocked') {
      import('../blockedSystemInvestigation.js').then(({ recoverBlockedSystemTask }) => recoverBlockedSystemTask(data.task.id))
        .catch(err => console.error(`❌ Blocked-system investigation recovery failed: ${err.message}`));
    }
  });

  // A critical health transition reaches the bell even when no CoS view is open.
  cosEvents.on('health:critical', (issues) => {
    notifyCriticalHealth(issues)
      .catch(err => console.error(`❌ Critical-health notification failed: ${err.message}`));
  });
  cosEvents.on('health:check', (check) => {
    clearCriticalHealthIfRecovered(check)
      .catch(err => console.error(`❌ Critical-health recovery check failed: ${err.message}`));
  });

  // Changing the investigation override can make an already-queued held task
  // eligible. Re-run the normal dequeue so autonomy, budgets, leases, and
  // capacity remain the same as for every other system task.
  cosEvents.on('config:changed', () => {
    if (isDaemonRunning()) {
      scheduleDequeue();
      // Standing role/grant changes reconcile immediately; the watchdog's
      // persisted policy fingerprint coalesces unrelated config updates.
      import('../developmentWatchdog.js').then(({ runDevelopmentWatchdog }) => runDevelopmentWatchdog({ source: 'configuration' }))
        .catch(err => console.error(`❌ Development watchdog configuration reconciliation failed: ${err.message}`));
    }
  });

  cosEvents.on('task:on-demand-requested', () => {
    if (isDaemonRunning()) scheduleDequeue();
  });

  // The improvement-check timer (cosJobScheduler.scheduleNextImprovementCheck)
  // queues eligible improvement tasks then asks for a dequeue via this event,
  // since dequeueNextTask lives here. Mirrors the pre-extraction direct call.
  cosEvents.on('cos:dequeue-requested', () => {
    if (isDaemonRunning()) scheduleDequeue();
  });

  // Autonomous job lifecycle → re-register/cancel individual job timers
  cosEvents.on('jobs:toggled', async ({ id }) => {
    if (isDaemonRunning()) await registerSingleJobSchedule(id).catch(err =>
      console.error(`❌ Failed to register job schedule on toggle for ${id}: ${err?.message ?? String(err)}`)
    );
  });

  cosEvents.on('jobs:updated', async ({ id }) => {
    if (isDaemonRunning()) await registerSingleJobSchedule(id).catch(err =>
      console.error(`❌ Failed to register job schedule on update for ${id}: ${err?.message ?? String(err)}`)
    );
  });

  cosEvents.on('jobs:created', async ({ id }) => {
    if (isDaemonRunning()) await registerSingleJobSchedule(id).catch(err =>
      console.error(`❌ Failed to register job schedule on create for ${id}: ${err?.message ?? String(err)}`)
    );
  });

  cosEvents.on('jobs:deleted', async ({ id }) => {
    cancelEvent(`job:${id}`);
  });

  // Schedule changes → re-compute next improvement check
  cosEvents.on('schedule:changed', async () => {
    if (isDaemonRunning()) await scheduleNextImprovementCheck().catch(err =>
      console.error(`❌ Failed to schedule next improvement check: ${err?.message ?? String(err)}`)
    );
  });

  const state = await loadState();

  // Auto-start when alwaysOn/autoStart is set, OR when the previous process left
  // `running: true` on disk. The in-memory daemon flag dies with the process, but
  // initializePersistentMindSupervisor (orphan-turn recovery + watchdog) only
  // runs inside start(). Without this, a portos-server restart with the mind mid-
  // turn leaves activeTurn stuck on disk forever — especially once the instance
  // password is on and keepalive's unauthenticated POST /api/cos/start 401s.
  if (state.config.alwaysOn || state.config.autoStart || state.running) {
    const reason = (state.config.alwaysOn || state.config.autoStart)
      ? 'alwaysOn mode'
      : 'persisted running=true after restart';
    console.log(`🚀 CoS auto-starting (${reason})`);
    await start();
  }
}
