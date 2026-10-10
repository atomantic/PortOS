import { watch, mkdirSync } from 'node:fs';
import { maintenance } from '../lib/maintenanceAdmission.js';
import { assertNotRealDataWrite } from '../lib/testDataIsolation.js';

let watcher;
let timer;
let boundIo;
let lastReadiness = null;

// Coarse banner projection: state, plus the blocker count only while draining
// (the one state that displays it). Operation-list/revision churn in a stable
// state leaves it unchanged. Carries no hold capability, resource, owner or PID.
function readinessProjection(status = maintenance.status()) {
  return { state: status.state, blockerCount: status.state === 'draining' ? status.blockers.length : 0 };
}

function emitChanges() {
  boundIo?.emit('maintenance:changed');
  const next = readinessProjection();
  if (lastReadiness && lastReadiness.state === next.state && lastReadiness.blockerCount === next.blockerCount) return;
  lastReadiness = next;
  boundIo?.emit('maintenance:readiness', next);
}

export function bindMaintenanceIo(io) {
  boundIo = io;
  if (watcher) return;
  lastReadiness = readinessProjection();
  assertNotRealDataWrite(maintenance.directory, 'maintenance notifications');
  mkdirSync(maintenance.directory, { recursive: true, mode: 0o700 });
  // Cross-process runner settlements also invalidate the UI. Payload contains
  // no operation capability or private resource identity; GET remains auth gated.
  watcher = watch(maintenance.directory, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; emitChanges(); }, 100);
    timer.unref?.();
  });
  watcher.unref?.();
}

export async function resumeMaintenance(input) {
  const status = maintenance.resume(input);
  // Re-evaluate saved policies. These functions retain their daemon, pause,
  // domain, budget and quota gates; do not call CoS.resume or mind.resume.
  const [{ dequeueNextTask }, { recheckPersistentMindSchedule }] = await Promise.all([
    import('./cos.js'), import('./persistentMindSupervisor.js'),
  ]);
  await Promise.allSettled([dequeueNextTask(), recheckPersistentMindSchedule()]);
  return status;
}
