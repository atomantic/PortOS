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
    trusted: agents !== null || Boolean(cosStatus),
    active: runningAgents ? runningAgents.length : (cosStatus?.activeAgents || 0),
    queued: pendingTaskIds.filter((id) => !claimedTaskIds.has(id)).length,
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
  const [jobs, models, pendingTaskIds, agents, mindState] = await Promise.all([
    Promise.resolve(listJobs()).then((items) => items.filter((job) => LIVE_STATUSES.has(job.status))),
    listGeneratingModelSummaries().catch(() => []),
    cos.getPendingTaskIds().catch(() => []),
    // `null` = the read FAILED, distinct from `[]` = read fine, no agents. The
    // counts degrade differently for the two, so they must stay separable.
    cos.getAgents().catch(() => null),
    // Same contract one layer down: the reader reports `trusted: false` rather
    // than an empty mind, so an unreadable state cannot read as an idle one.
    readPersistentMindStateForSafetyCheck().catch(() => ({ trusted: false, persistentMind: null })),
  ]);
  const cosStatus = agents === null ? await cos.getStatus().catch(() => null) : null;
  const slices = {
    jobs: jobs.map(sanitizeJob),
    extras: { imageTo3d: models.map((model) => ({ id: model.id, name: model.name || model.id })) },
    agents: agentCounts(agents, cosStatus, pendingTaskIds),
    mind: summarizeMind(mindState),
    // An App Management update/standardize holds a checkout and restarts PM2
    // processes — activity in exactly the sense that matters to a caller
    // deciding whether it may restart the install.
    appOperations: listActiveAppOperations(),
    update: { inProgress: isUpdateInProgress() },
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
