import { runDevelopmentWatchdog } from '../developmentWatchdog.js';

export async function countPending() {
  const receipt = await runDevelopmentWatchdog({ dryRun: true, force: true, source: 'probe' });
  return { count: receipt.decisions.filter(d => d.outcome === 'would-queue').length, detail: receipt.complete ? 'Maintenance snapshot complete' : 'Maintenance sources incomplete' };
}

export async function run({ params, family } = {}) {
  if (family) return { dispatched: false, reason: 'maintenance-is-not-quota-spending' };
  const receipt = await runDevelopmentWatchdog({ force: true, dryRun: params?.dryRun === true, source: 'manual' });
  return { dispatched: receipt.counts.dispatched > 0, summary: `Maintenance scan: ${receipt.counts.dispatched} queued`, detail: receipt };
}
