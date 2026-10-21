/** Deterministic continuation of existing private retirement transactions.
 * The journal stays authoritative; this bounded in-memory retry cache grants
 * nothing and is rebuilt after restart. No task, agent, or checkout is created.
 */
export const INITIALIZED_RECOVERY_INTERVAL_MS = 30 * 60_000;
const MAX_ATTEMPTS = 2;

export function _createInitializedRecoverySweep({ discover, recover, now = Date.now, report = () => {} }) {
  let running = null;
  let nextScan = 0;
  let cursor = '';
  const attempted = new Map();
  const sweep = async blocked => {
    const reason = await blocked();
    if (reason) return { skipped: reason, outcomes: [] };
    if (now() < nextScan) return { skipped: 'recovery-cadence', outcomes: [] };
    nextScan = now() + INITIALIZED_RECOVERY_INTERVAL_MS;
    const found = await discover();
    if (!found.ok) {
      await report({ transactionId: null, reason: found.reason });
      return { skipped: found.reason, outcomes: [] };
    }
    const outcomes = [];
    const valid = [];
    for (const row of found.transactions) {
      if (row.reason) { await report(row); outcomes.push(row); }
      else if (row.settled) {
        const outcome = { transactionId: row.transactionId, appId: row.appId, branch: row.release?.branch,
          phase: row.phase, journalDigest: row.journalDigest, ok: true, reason: 'retirement-recovery-completed' };
        await report(outcome); outcomes.push(outcome);
      } else valid.push(row);
    }
    const ids = new Set(valid.map(row => row.transactionId));
    for (const key of attempted.keys()) if (!ids.has(key)) attempted.delete(key);
    // Rotate bounded batches so an old held transaction cannot starve later
    // journals. Every retry obtains fresh evidence; cached holds expire.
    const sorted = [...valid.filter(row => row.transactionId > cursor), ...valid.filter(row => row.transactionId <= cursor)];
    let count = 0;
    for (const row of sorted) {
      const prior = attempted.get(row.transactionId);
      if (prior?.digest === row.journalDigest && now() < prior.retryAt) continue;
      const stopped = await blocked();
      if (stopped) return { skipped: stopped, outcomes };
      if (++count > MAX_ATTEMPTS) break;
      cursor = row.transactionId;
      const result = await recover({ appId: row.appId, transactionId: row.transactionId,
        journalDigest: row.journalDigest }, { blocked });
      const outcome = { transactionId: row.transactionId, appId: row.appId,
        phase: result.receiptRecorded ? 'retired' : result.phase || row.phase,
        branch: row.release?.branch, journalDigest: row.journalDigest, ok: result.ok, reason: result.reason || (result.ok ? 'retirement-recovery-completed' : 'retirement-recovery-held') };
      attempted.set(row.transactionId, { digest: row.journalDigest, retryAt: now() + INITIALIZED_RECOVERY_INTERVAL_MS });
      await report(outcome); outcomes.push(outcome);
    }
    return { outcomes };
  };
  return blocked => {
    if (running) return running;
    running = sweep(blocked).finally(() => { running = null; });
    return running;
  };
}

const drain = _createInitializedRecoverySweep({
  discover: async () => (await import('./initializedCheckoutRecovery.js')).discoverInitializedCheckoutRecoveries(),
  recover: async (...args) => (await import('./initializedCheckoutRecovery.js')).recoverInitializedCheckoutAutomatically(...args),
  report: async row => {
    const { recordInitializedRetirementRecovery } = await import('./taskSchedule.js');
    const { appId, ...observation } = row;
    await recordInitializedRetirementRecovery(appId || null, observation);
    // No paths, native diagnostics, patches, or raw metadata in daemon logs.
    const reason = /^[a-z][a-z0-9-]+$/.test(row.reason) ? row.reason : 'retirement-recovery-held';
    const message = `Initialized retirement ${row.transactionId || 'discovery'}: ${reason}`;
    console.info(`🔁 ${message}`);
  },
});

export const sweepInitializedCheckoutRecoveries = drain;
