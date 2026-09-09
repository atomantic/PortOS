import { getCudaCapability, getCudaUtilization } from '../lib/cudaCapability.js';
import { listJobs, getRunningJob } from './mediaJobQueue/index.js';
import { sanitizeJob } from './mediaJobQueue/sanitizeJob.js';
import { listModels } from './imageTo3d/models.js';
import { getLoadedModels } from './ollamaManager.js';
import * as cos from './cos.js';

const LIVE_STATUSES = new Set(['queued', 'running']);

export async function getActiveProcessing() {
  const [capability, jobs, models, loadedModels, taskData, agents] = await Promise.all([
    getCudaCapability(),
    Promise.resolve(listJobs()).then((items) => items.filter((job) => LIVE_STATUSES.has(job.status))),
    listModels().catch(() => []),
    getLoadedModels().catch(() => []),
    cos.getAllTasks().catch(() => ({ user: {}, cos: {} })),
    // `null` = the read FAILED, distinct from `[]` = read fine, no agents. The
    // counts below degrade differently for the two, so they must stay separable.
    cos.getAgents().catch(() => null),
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
  const pendingTasks = [...(taskData.user?.tasks || []), ...(taskData.cos?.tasks || [])]
    .filter((task) => task.status === 'pending' && !claimedTaskIds.has(task.id)).length;
  const gpuBusy = Boolean(getRunningJob());
  return {
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
      imageTo3d: models.filter((model) => model.status === 'generating').map((model) => ({ id: model.id, name: model.name || model.id })),
      ollama: loadedModels,
    },
    agents: {
      active: runningAgents ? runningAgents.length : (cosStatus?.activeAgents || 0),
      queued: pendingTasks,
    },
  };
}
