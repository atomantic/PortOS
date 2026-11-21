import { watch, mkdirSync } from 'node:fs';
import { maintenance } from '../lib/maintenanceAdmission.js';
import { assertNotRealDataWrite } from '../lib/testDataIsolation.js';

let watcher;
let timer;
let boundIo;
let lastReadiness = null;
let diskTimer;

export function getMaintenanceStatus() {
  const agentDiskPressure = maintenance.agentDiskPressure();
  return { ...maintenance.status(), ...(agentDiskPressure && { agentDiskPressure }) };
}

// Coarse banner projection: state, plus the blocker count only while draining
// (the one state that displays it). Operation-list/revision churn in a stable
// state leaves it unchanged. Carries no hold capability, resource, owner or PID.
export function readinessProjection(status = getMaintenanceStatus()) {
  const { state, agentDiskPressure } = status;
  return { state, blockerCount: state === 'draining' ? status.blockers.length : 0,
    ...(agentDiskPressure && { agentDiskPressure }) };
}

function emitReadiness(next) {
  if (lastReadiness?.state === next.state && lastReadiness.blockerCount === next.blockerCount
    && lastReadiness.agentDiskPressure === next.agentDiskPressure) return;
  const recoveredDisk = lastReadiness?.agentDiskPressure && !next.agentDiskPressure && next.state === 'normal';
  lastReadiness = next;
  boundIo?.emit('maintenance:readiness', next);
  if (recoveredDisk) {
    import('./cos/cos.js').then(({ dequeueNextTask }) => dequeueNextTask())
      .catch(error => console.error(`❌ CoS dequeue after disk recovery failed: ${error.message}`));
  }
}

function emitChanges() {
  boundIo?.emit('maintenance:changed');
  emitReadiness(readinessProjection());
  if (!watcher && boundIo) bindMaintenanceIo(boundIo);
}

export function bindMaintenanceIo(io) {
  boundIo = io;
  if (!diskTimer) {
    // Free space can change without a journal write, including while intake is paused.
    diskTimer = setInterval(() => emitReadiness(readinessProjection()), 15_000);
    diskTimer.unref?.();
  }
  if (watcher) return;
  lastReadiness = readinessProjection();
  assertNotRealDataWrite(maintenance.directory, 'maintenance notifications');
  mkdirSync(maintenance.directory, { recursive: true, mode: 0o700 });
  // Cross-process runner settlements also invalidate the UI. Payload contains
  // no operation capability or private resource identity; GET remains auth gated.
  try {
    watcher = watch(maintenance.directory, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; emitChanges(); }, 100);
      timer.unref?.();
    });
    watcher.on('error', (err) => {
      console.error(`❌ Maintenance directory watcher error: ${err.message}`);
      watcher?.close();
      watcher = null;
    });
    watcher.unref?.();
  } catch (err) {
    console.error(`❌ Failed to watch maintenance directory: ${err.message}`);
    watcher = null;
  }
}

export function _getMaintenanceWatcher() {
  return watcher;
}

export async function wakeAfterMaintenance({ waitForCompletion = false } = {}) {
  // Re-evaluate saved policies. These functions retain their daemon, pause,
  // domain, budget and quota gates; do not call CoS.resume or mind.resume.
  const [{ dequeueNextTask, resumeDeferredCompletions }, { recheckPersistentMindSchedule }] = await Promise.all([
    import('./cos/cos.js'), import('./persistent/persistentMindSupervisor.js'),
  ]);
  // The normal-state response must not wait for filesystem verification. Finish
  // the bounded deterministic repair before admitting more queued agent work.
  const repair = resumeDeferredCompletions().catch(error => {
    console.warn(`⚠️ Completion recovery deferred after maintenance: ${error.message}`);
    throw error;
  });
  const dequeue = repair.catch(() => {}).then(() => dequeueNextTask());
  const mind = recheckPersistentMindSchedule();
  if (waitForCompletion) {
    const results = await Promise.allSettled([repair, dequeue, mind]);
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  } else {
    void repair.catch(() => {});
    void dequeue.catch(error => console.error(`❌ CoS dequeue after maintenance failed: ${error.message}`));
    await Promise.allSettled([mind]);
  }
}

export async function resumeMaintenance(input) {
  const status = maintenance.resume(input);
  await wakeAfterMaintenance();
  return status;
}
