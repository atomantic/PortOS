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

export async function getActiveProcessing() {
  const [capability, jobs, models, loadedModels, pendingTaskIds, agents, mindState] = await Promise.all([
    getCudaCapability(),
    Promise.resolve(listJobs()).then((items) => items.filter((job) => LIVE_STATUSES.has(job.status))),
    listGeneratingModelSummaries().catch(() => []),
    getLoadedModels().catch(() => []),
    cos.getPendingTaskIds().catch(() => []),
    // `null` = the read FAILED, distinct from `[]` = read fine, no agents. The
    // counts below degrade differently for the two, so they must stay separable.
    cos.getAgents().catch(() => null),
    // Same contract one layer down: the reader reports `trusted: false` rather
    // than an empty mind, so an unreadable state cannot read as an idle one.
    readPersistentMindStateForSafetyCheck().catch(() => ({ trusted: false, persistentMind: null })),
  ]);
  const cosStatus = agents === null ? await cos.getStatus().catch(() => null) : null;
  const utilization = capability.status === 'available' ? await getCudaUtilization() : { status: capability.status, gpus: [] };
  // A task stays 'pending' until spawnAgentForTask flips it to 'in_progress',
  // which happens AFTER its agent is registered as running — so a snapshot taken
  // in between would count one task as queued AND active, and the widget read
  // 'N active, N queued' for a queue of N. A task a live agent holds is active.
  //
  // When the agent list is readable, BOTH counts come off that one read: taking
  // `active` from `getStatus()` and `queued` from here would let the two skew
  // against each other, which is the same defect one layer up. When it is NOT
  // readable, there is no claim set to subtract — fall back to `getStatus()`'s
  // own tally rather than reporting zero active agents while still counting
  // their tasks as queued, which would understate BOTH numbers at once.
  const runningAgents = agents === null ? null : agents.filter((agent) => agent.status === 'running');
  const claimedTaskIds = new Set((runningAgents || []).map((agent) => agent.taskId).filter(Boolean));
  const pendingTasks = pendingTaskIds.filter((id) => !claimedTaskIds.has(id)).length;
  const gpuBusy = Boolean(getRunningJob());
  const snapshot = {
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
    jobs: jobs.map(sanitizeJob),
    extras: {
      imageTo3d: models.map((model) => ({ id: model.id, name: model.name || model.id })),
      ollama: loadedModels,
    },
    agents: {
      active: runningAgents ? runningAgents.length : (cosStatus?.activeAgents || 0),
      queued: pendingTasks,
    },
    mind: summarizeMind(mindState),
    // An App Management update/standardize holds a checkout and restarts PM2
    // processes — activity in exactly the sense that matters to a caller
    // deciding whether it may restart the install.
    appOperations: listActiveAppOperations(),
    update: { inProgress: isUpdateInProgress() },
  };
  // Derived here, once, so the widget and the auto-updater cannot disagree
  // about what "idle" means. See lib/systemIdle.js.
  return { ...snapshot, activity: summarizeSystemActivity(snapshot) };
}
