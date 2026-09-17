import { getCudaCapability, getCudaUtilization } from '../lib/cudaCapability.js';
import { summarizeSystemActivity } from '../lib/systemIdle.js';
import { listJobs, getRunningJob } from './mediaJobQueue/index.js';
import { sanitizeJob } from './mediaJobQueue/sanitizeJob.js';
import { listGeneratingModelSummaries } from './imageTo3d/models.js';
import { getLoadedModels } from './ollamaManager.js';
import { listActiveAppOperations } from './appOperations.js';
import { readPersistentMindStateForSafetyCheck } from './cosState.js';
import { isUpdateInProgress } from './updateChecker.js';
import * as cos from './cos.js';

// Lazy — NOT a static top-level import. `services/runner.js` and
// `services/backup.js` both drag heavy subtrees (provider CLI spawning;
// `socket.js` → `instances.js` respectively) that this module's own callers
// (`routes/systemHealth.js`, the dashboard) must not eagerly reach just to
// read a count/flag. `routes/update.js` already defers this whole module the
// same way for the same reason — see "Import scoping" in server/AGENTS.md.
const importRunner = () => import('./runner.js');
const importBackup = () => import('./backup.js');

const LIVE_STATUSES = new Set(['queued', 'running']);

/**
 * What the Persistent Mind is doing, WITHOUT any of what it is thinking about.
 *
 * Counts and lifecycle only: a queued message's text, its attachments, and the
 * turn's own content never appear here. This rides the same `/api/system/
 * processing` payload the dashboard polls every few seconds, and a mind's
 * messages are the most personal records on the install.
 *
 * `trusted: false` (unreadable state) is deliberately NOT collapsed into "idle".
 * `summarizeSystemActivity` treats it as a blocker, matching the update path's
 * own `PERSISTENT_MIND_STATE_UNTRUSTED` refusal.
 */
function summarizeMind(snapshot) {
  if (!snapshot?.trusted) return { trusted: false, status: 'unknown', thinking: false, queued: 0 };
  const mind = snapshot.persistentMind;
  const activeTurn = mind?.activeTurn || null;
  return {
    trusted: true,
    enabled: mind?.enabled === true,
    started: mind?.started === true,
    status: typeof mind?.status === 'string' ? mind.status : 'disabled',
    thinking: Boolean(activeTurn),
    thinkingSince: activeTurn?.startedAt || null,
    queued: Array.isArray(mind?.queuedMessages) ? mind.queuedMessages.length : 0,
  };
}

/**
 * In-flight LLM/pipeline run count, off the toolkit's own `activeRuns` +
 * `externalRuns` tracking (`getActiveRunCount` in `services/runner.js`).
 * Counts and lifecycle only — no prompt or response content ever reaches this
 * slice. `trusted: false` (the count could not be read) is NOT collapsed into
 * "idle", the same contract the agent and Persistent Mind slices keep: a
 * failed read must never manufacture the zero that unlocks a restart.
 */
function llmRunState(count) {
  return count === null ? { trusted: false, active: 0 } : { trusted: true, active: count };
}

/**
 * Active vs queued CoS agents, from ONE read of the agent list.
 *
 * A task stays 'pending' until spawnAgentForTask flips it to 'in_progress',
 * which happens AFTER its agent is registered as running — so a snapshot taken
 * in between would count one task as queued AND active, and the widget read
 * 'N active, N queued' for a queue of N. A task a live agent holds is active.
 *
 * When the agent list is readable, BOTH counts come off that one read: taking
 * `active` from `getStatus()` and `queued` from here would let the two skew
 * against each other, which is the same defect one layer up. When it is NOT
 * readable (`agents === null`), there is no claim set to subtract — fall back to
 * `getStatus()`'s own tally rather than reporting zero active agents while still
 * counting their tasks as queued, which would understate BOTH numbers at once.
 *
 * And when BOTH reads failed, `active` is 0 because nothing could be counted —
 * not because nothing is running. `trusted: false` says which, so the idle
 * verdict can refuse instead of reading that zero as an empty install and
 * restarting out from under a live agent (the contract the Persistent Mind
 * slice already keeps). The queued count is unaffected: the pending-task list
 * is a separate read, and with no claim set to subtract it over-reports rather
 * than under-reports, which is the safe direction for a gate.
 */
function agentCounts(agents, cosStatus, pendingTaskIds) {
  const runningAgents = agents === null ? null : agents.filter((agent) => agent.status === 'running');
  const claimedTaskIds = new Set((runningAgents || []).map((agent) => agent.taskId).filter(Boolean));
  return {
    // An unreadable pending-task list is its own untrusted reading: zero queued
    // tasks is the value that unlocks a restart, so it may not come from a
    // failed read any more than a zero agent count may.
    trusted: (agents !== null || Boolean(cosStatus)) && pendingTaskIds !== null,
    active: runningAgents ? runningAgents.length : (cosStatus?.activeAgents || 0),
    queued: pendingTaskIds ? pendingTaskIds.filter((id) => !claimedTaskIds.has(id)).length : 0,
  };
}

/**
 * Just the slices `summarizeSystemActivity` reads, plus the verdict.
 *
 * Split out because two callers — `GET /api/update/auto` and the auto-update
 * tick — want only `activity`, and the full snapshot also shells out to
 * nvidia-smi and makes an HTTP request to Ollama, whose latency is unbounded
 * when the daemon is wedged. Neither feeds the verdict.
 */
export async function getSystemActivity() {
  const [jobs, models, pendingTaskIds, agents, mindState, activeRunCount, backupInProgress] = await Promise.all([
    Promise.resolve(listJobs()).then((items) => items.filter((job) => LIVE_STATUSES.has(job.status))),
    // `null` = the read FAILED, distinct from `[]` = read fine, nothing
    // building. Both of these degrade to the value that unlocks a restart, so
    // neither may be manufactured from a failed read.
    listGeneratingModelSummaries().catch(() => null),
    cos.getPendingTaskIds().catch(() => null),
    // `null` = the read FAILED, distinct from `[]` = read fine, no agents. The
    // counts degrade differently for the two, so they must stay separable.
    cos.getAgents().catch(() => null),
    // Same contract one layer down: the reader reports `trusted: false` rather
    // than an empty mind, so an unreadable state cannot read as an idle one.
    readPersistentMindStateForSafetyCheck().catch(() => ({ trusted: false, persistentMind: null })),
    // Same contract again: a failed read degrades to `null`, not 0.
    importRunner().then((m) => m.getActiveRunCount()).catch(() => null),
    // The only way this rejects is the lazy import itself failing (the module
    // is otherwise a synchronous, no-I/O flag read) — an anomaly rare enough
    // that it is itself reason to refuse rather than read as "no backup
    // running", the same fail-closed direction every other slice here takes.
    importBackup().then((m) => m.isBackupInProgress()).catch(() => true),
  ]);
  const cosStatus = agents === null ? await cos.getStatus().catch(() => null) : null;
  const slices = {
    jobs: jobs.map(sanitizeJob),
    // `null` survives to the verdict as a blocker; the widget's own
    // `extras?.imageTo3d || []` already reads it as an empty list.
    extras: { imageTo3d: models === null ? null : models.map((model) => ({ id: model.id, name: model.name || model.id })) },
    agents: agentCounts(agents, cosStatus, pendingTaskIds),
    mind: summarizeMind(mindState),
    // A prompt/stage run holds a provider connection or a CLI/TUI child
    // process — activity in exactly the sense the updater must not restart
    // through, and distinct from a CoS agent (its own slice above, spawned
    // through a different path entirely).
    llm: llmRunState(activeRunCount),
    // An App Management update/standardize holds a checkout and restarts PM2
    // processes — activity in exactly the sense that matters to a caller
    // deciding whether it may restart the install.
    appOperations: listActiveAppOperations(),
    update: { inProgress: isUpdateInProgress() },
    // No trusted contract needed: an in-process flag with no I/O once loaded.
    backup: { inProgress: backupInProgress },
  };
  return { ...slices, activity: summarizeSystemActivity(slices) };
}

export async function getActiveProcessing() {
  const [capability, activity, loadedModels] = await Promise.all([
    getCudaCapability(),
    getSystemActivity(),
    getLoadedModels().catch(() => []),
  ]);
  const utilization = capability.status === 'available' ? await getCudaUtilization() : { status: capability.status, gpus: [] };
  const gpuBusy = Boolean(getRunningJob());
  return {
    ...activity,
    updatedAt: new Date().toISOString(),
    gpu: {
      status: capability.status,
      laneBusy: gpuBusy,
      laneKind: getRunningJob()?.kind || null,
      gpus: (utilization.gpus.length ? utilization.gpus : capability.gpus).map((gpu) => ({
        name: gpu.name,
        utilizationPercent: gpu.utilizationPercent ?? null,
        memoryUsedMib: gpu.memoryUsedMib ?? null,
        memoryTotalMib: gpu.memoryTotalMib ?? gpu.vramMib ?? null,
      })),
    },
    extras: { ...activity.extras, ollama: loadedModels },
  };
}
