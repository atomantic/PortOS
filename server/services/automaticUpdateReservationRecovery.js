/** Recover inactive admission residue while an update waits for its fence. */
import { maintenance } from '../lib/maintenanceAdmission.js';
import { assertInactiveActivity, isOrdinaryAgentRecord, reconcileWaitingUpdate } from './maintenanceReservationDisposition.js';
import { recordedMediaChildIds } from '../lib/mediaRecoveryActivity.js';

const topazChecks = new Map();

export async function checkActivity(update, operations) {
  let runnerScopeUnavailable = false;
  const { databaseRestoreRecovery } = await import('../lib/db.js');
  if (databaseRestoreRecovery.isFenced()) {
    const { resumeDatabaseRestore } = await import('./backupRestoreRecovery.js');
    const outcome = await resumeDatabaseRestore();
    if (outcome.status !== 'ok') throw new Error('Database restore recovery is still active or incomplete.');
  }
  const [{ getSystemActivity }, { getActiveAgentsFromRunner }, { getAgentRecord }, { getMediaRecoveryActivity, listJobs }, { isSoleDeferredUpdateAppOperation }, { assertNoObservedReservationProcesses, snapshotMaintenanceProcesses }, { assertNoScopedLegacyProcesses, getProcessWorkingDirectories }, { PATHS }] = await Promise.all([
    import('./activeProcessing.js'), import('./cosRunnerClient.js'), import('./cosAgentLifecycle.js'), import('./mediaJobQueue/index.js'), import('./appOperations.js'),
    import('./maintenanceProcessInventory.js'), import('./maintenanceScopedProcesses.js'), import('../lib/paths.js'),
  ]);
  const runnerOps = operations.filter(op => op.kind === 'runner');
  const agentOps = operations.filter(op => op.kind === 'agent');
  const [activity, processes, owners, agents] = await Promise.all([
    getSystemActivity(), snapshotMaintenanceProcesses(), Promise.all(runnerOps.map(op => getAgentRecord(op.resource))),
    Promise.all(agentOps.map(async op => op.resource.startsWith('agent-') ? getAgentRecord(op.resource)
      : (await import('./cosTaskStore.js')).getTaskById(op.resource))),
  ]);
  const runner = await getActiveAgentsFromRunner().catch(async error => {
    // Direct mode is supported when no local runner process is present. An
    // unresponsive runner that still exists remains an actual blocker.
    const marker = `${PATHS.root.replaceAll('\\', '/').toLowerCase()}/server/cos-runner/index.js`;
    if (processes.some(proc => String(proc.command).replaceAll('\\', '/').toLowerCase().includes(marker))) throw error;
    const relative = processes.filter(proc => /(?:^|[\s"'=])(?:\.\/)?server[\\/]cos-runner[\\/]index\.js(?:$|[\s"'])/i.test(String(proc.command ?? '')));
    if (relative.length) {
      const cwd = await getProcessWorkingDirectories(relative.map(proc => proc.pid)).catch(() => null);
      const { realpathSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const canonical = path => { try { return realpathSync(path); } catch { return resolve(path); } };
      if (cwd && relative.some(proc => cwd.has(proc.pid) && canonical(cwd.get(proc.pid)) === canonical(PATHS.root))) throw error;
      if (!cwd || relative.some(proc => !cwd.has(proc.pid))) runnerScopeUnavailable = true;
    }
    return [];
  });
  const ownOperation = isSoleDeferredUpdateAppOperation(activity.appOperations, update.ownerPid);
  assertInactiveActivity(ownOperation ? { ...activity, appOperations: [] } : activity, runner, { waitingUpdate: true });
  let media = getMediaRecoveryActivity();
  if (media.trusted && media.pending) {
    const now = Date.now();
    const candidate = listJobs({ kind: 'video-upscale' }).find(job => job.params?.mode === 'topaz'
      && !['queued', 'running'].includes(job.status) && job.result?.topazUncertain === true
      && now - (topazChecks.get(job.id) ?? 0) >= 60000);
    if (candidate) {
      topazChecks.set(candidate.id, now);
      const { reconcileTopazStatus } = await import('./videoGen/topazJob.js');
      await reconcileTopazStatus(candidate.id).catch(() => {});
      media = getMediaRecoveryActivity();
    }
  }
  if (!media.trusted || media.pending)
    throw Object.assign(new Error('Media recovery is active or its inventory is unavailable.'), { code: 'MAINTENANCE_STALE' });
  const taskFor = async record => record?.taskId ? (await import('./cosTaskStore.js')).getTaskById(record.taskId) : null;
  const [ownerTasks, agentTasks] = await Promise.all([
    Promise.all(owners.map(taskFor)), Promise.all(agents.map(taskFor)),
  ]);
  const ordinaryRunners = runnerOps.filter((op, index) => isOrdinaryAgentRecord(op, owners[index], ownerTasks[index]));
  const ordinaryAgents = agentOps.filter((op, index) => isOrdinaryAgentRecord(op, agents[index], agentTasks[index]));
  const segments = recordedMediaChildIds(listJobs()).map(resource => ({ kind: 'media', resource }));
  await assertNoObservedReservationProcesses([...operations, ...segments], PATHS.installRoot, async () => processes);
  const limitations = await assertNoScopedLegacyProcesses(operations, processes, { data: PATHS.data, codeRoot: PATHS.root,
    updatePid: update.ownerPid,
    loadAgent: async id => agents[agentOps.findIndex(op => op.resource === id)]
      ?? owners[runnerOps.findIndex(op => op.resource === id)] ?? null,
    loadProvider: async id => (await import('./providers.js')).getProviderById(id),
    loadApp: async id => (await import('./apps.js')).getAppById(id) });
  if (runnerScopeUnavailable) limitations.push('runner-cwd-unavailable');
  return { pids: [...owners.filter((_, index) => ordinaryRunners.includes(runnerOps[index])),
    ...agents.filter((_, index) => ordinaryAgents.includes(agentOps[index]))]
    .filter(owner => Number.isSafeInteger(owner?.pid) && owner.pid > 0)
    .map(owner => ({ pid: owner.pid, completedAt: owner.completedAt ?? owner.pausedAt ?? null })),
  ordinaryOwnerIds: [...ordinaryRunners, ...ordinaryAgents].map(op => op.id), processes, limitations };
}

function createAutomaticUpdateReservationRecovery({ gate = maintenance, check = checkActivity,
  isDead, isAlive, intervalMs = 5000 } = {}) {
  let timer, checking = false, stopped = false, lastError;
  const run = async () => {
    if (checking || stopped) return null;
    checking = true;
    try {
      const receipt = await reconcileWaitingUpdate({ gate, checkActivity: check, isDead, isAlive, isEnabled: () => !stopped });
      if (receipt) console.log(`🧹 Recorded inactive admission disposition for ${receipt.request.operations.length} reservation(s)`);
      lastError = null;
      return receipt;
    } catch (error) {
      // Busy work and a racing journal are expected; retry without changing it.
      if (error.message !== lastError) {
        lastError = error.message;
        console.warn(`⚠️ Deferred update recovery is waiting: ${error.message}`);
      }
      return null;
    } finally { checking = false; }
  };
  const start = () => {
    if (timer) return;
    stopped = false;
    timer = setInterval(() => { void run(); }, intervalMs);
    timer.unref?.();
    void run();
  };
  const stop = () => { stopped = true; if (timer) clearInterval(timer); timer = null; };
  return { run, start, stop };
}

const recovery = createAutomaticUpdateReservationRecovery();
export { createAutomaticUpdateReservationRecovery as __createAutomaticUpdateReservationRecovery };
export const startAutomaticUpdateReservationRecovery = () => recovery.start();
export const stopAutomaticUpdateReservationRecovery = () => recovery.stop();
