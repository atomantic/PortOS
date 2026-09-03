import { Worker } from 'worker_threads';
import { homedir } from 'os';
import { atomicWrite, PATHS, readJSONFile } from '../lib/fileUtils.js';
import {
  applyHistoricalUsageCorrections,
  getReconciledUsageRunIds,
  getSiblingReconciledUsageRunIds
} from './usage.js';
import { listProviders } from './providers.js';
import { mergeUsageClaims, snapshotUsageClaims } from './usageReconciler.js';

let job = {
  status: 'idle',
  processed: 0,
  total: 0,
  found: 0,
  corrected: 0,
  error: null,
  startedAt: null,
  completedAt: null
};

const publicJob = () => ({ ...job });

const markRunMetadata = async (corrections) => {
  for (const correction of corrections) {
    const metadata = await readJSONFile(correction.metadataPath, null);
    if (!metadata) continue;
    const now = new Date().toISOString();
    // The two passes carry independent markers. A sibling-only correction must
    // NOT stamp `usageReconciled` — that would tell a later backfill the run's
    // own estimate had already been replaced when it never was.
    if (correction.measured) {
      metadata.usageReconciled = true;
      metadata.usageReconciledAt = now;
    }
    if (correction.siblingScanned) {
      metadata.usageSiblingsReconciled = true;
      metadata.usageSiblingsReconciledAt = now;
    }
    await atomicWrite(correction.metadataPath, metadata);
  }
};

export function getHistoricalUsageBackfillStatus() {
  return publicJob();
}

/**
 * Start the one-shot historical repair. The explicit POST route is the only
 * caller; no boot hook or schedule invokes this function.
 */
export async function startHistoricalUsageBackfill({
  runsDir = PATHS.runs,
  home = homedir(),
  WorkerClass = Worker,
  providers = null
} = {}) {
  if (job.status === 'running') return publicJob();

  job = {
    status: 'running',
    processed: 0,
    total: 0,
    found: 0,
    corrected: 0,
    error: null,
    startedAt: new Date().toISOString(),
    completedAt: null
  };

  // Resolved HERE, not inside the worker: the toolkit singleton that backs
  // `listProviders()` is never initialized in a worker thread, so a worker-side
  // lookup would silently find no provider to attribute a nested session to.
  // `job.status` is already `running` above, so the await can't let a second
  // POST start a duplicate scan.
  const providerList = providers ?? await listProviders().catch(() => []);

  const worker = new WorkerClass(new URL('./usageBackfillWorker.js', import.meta.url), {
    workerData: {
      runsDir,
      home,
      reconciledRunIds: getReconciledUsageRunIds(),
      siblingReconciledRunIds: getSiblingReconciledUsageRunIds(),
      providers: providerList,
      // The worker gets its own empty copy of usageReconciler.js's claim
      // ledger (a separate module instance) — seed it from this thread's
      // ledger so a message the live completion path already billed isn't
      // billed again by the backfill scan.
      claimsSeed: snapshotUsageClaims()
    }
  });

  let messageTail = Promise.resolve();
  worker.on('message', (message) => {
    messageTail = messageTail.then(async () => {
      if (message?.type === 'progress') {
        job = { ...job, ...message.progress };
        return;
      }
      if (message?.type === 'error') {
        job = { ...job, status: 'error', error: message.error || 'Backfill failed', completedAt: new Date().toISOString() };
        return;
      }
      if (message?.type !== 'complete') return;
      const result = message.result || {};
      if (result.claimsSnapshot) mergeUsageClaims(result.claimsSnapshot);
      const applied = await applyHistoricalUsageCorrections(result.corrections || []);
      const appliedCorrections = (result.corrections || [])
        .filter((correction) => applied.correctedRunIds.includes(correction.runId));
      await markRunMetadata(appliedCorrections);
      job = {
        ...job,
        status: 'complete',
        processed: result.processed || 0,
        total: result.total || 0,
        found: result.corrections?.length || 0,
        corrected: applied.corrected,
        completedAt: new Date().toISOString()
      };
    }).catch((error) => {
      job = { ...job, status: 'error', error: error.message, completedAt: new Date().toISOString() };
    });
  });
  worker.on('error', (error) => {
    job = { ...job, status: 'error', error: error.message, completedAt: new Date().toISOString() };
  });
  worker.unref();
  return publicJob();
}


export function __resetHistoricalUsageBackfillForTests() {
  job = {
    status: 'idle',
    processed: 0,
    total: 0,
    found: 0,
    corrected: 0,
    error: null,
    startedAt: null,
    completedAt: null
  };
}
