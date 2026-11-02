import { maintenance } from '../lib/maintenanceAdmission.js';
import { runtimeUpdateEvents } from './runtimeUpdateEvents.js';

async function wake() {
  const { wakeAfterMaintenance } = await import('./maintenanceControl.js');
  await wakeAfterMaintenance({ waitForCompletion: true });
}

async function reportOverlap(record) {
  const { createItem } = await import('./review.js');
  await createItem({ type: 'alert', title: 'Check work recovered during a harness update',
    description: `PortOS recovered existing work while ${record.runtime} was updating. The update may have overlapped it; check the affected work and harness before retrying.`,
    metadata: { referenceId: `harness-update-overlap:${record.id}`, category: 'harness-update-overlap', link: '/cos/agents' } });
}

function bounded(task, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Harness recovery step timed out')), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve().then(task), timeout]).finally(() => clearTimeout(timer));
}

/** Retry dead-owner reconciliation after boot, including a group that exits later. */
function createHarnessActionRecovery({ admission = maintenance, resume = wake,
  notify = () => runtimeUpdateEvents.emit('changed'), report = reportOverlap, intervalMs = 5000, timeoutMs = 15_000 } = {}) {
  let timer = null;
  let checking = false;
  const inFlight = new Map();
  const runObligation = (record, kind, task) => {
    const key = `${record.id}:${kind}`;
    if (inFlight.has(key)) return inFlight.get(key);
    const pending = Promise.resolve().then(task).then(() => {
      try {
        admission.harnessActions.markWakeProgress(record.id, {
          reported: kind === 'report', woken: kind === 'wake',
        });
      } catch (error) {
        if (error.code !== 'MAINTENANCE_STALE') throw error;
      }
    }).finally(() => { if (inFlight.get(key) === pending) inFlight.delete(key); });
    inFlight.set(key, pending);
    return pending;
  };
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      const result = admission.harnessActions.reconcile();
      if (result) {
        notify();
      }
      for (const record of admission.harnessActions.pendingWake()) {
        const work = [];
        if (record.overlap && !record.reported) work.push(runObligation(record, 'report', () => report(record)));
        if (!record.woken) work.push(runObligation(record, 'wake', resume));
        const results = await Promise.allSettled(work.map(task => bounded(() => task, timeoutMs)));
        const failure = results.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
      }
    } catch (error) {
      // A transaction may be busy, a group may still exist, or service startup
      // may be incomplete. Keep the fence and retry; never infer settlement.
      console.warn(`⚠️ Harness action recovery deferred: ${error.message}`);
    } finally { checking = false; }
  };
  const start = () => {
    if (timer) return;
    timer = setInterval(() => { void check(); }, intervalMs);
    timer.unref?.();
  };
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  return { check, start, stop };
}

const recovery = createHarnessActionRecovery();
export const startHarnessActionRecovery = () => recovery.start();
export const stopHarnessActionRecovery = () => recovery.stop();
export const checkHarnessActionRecovery = () => recovery.check();
export const __testing = { createHarnessActionRecovery };
