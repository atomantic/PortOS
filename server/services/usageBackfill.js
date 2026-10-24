import { notifyUsageBackfillUpdated } from './usageBackfillEvents.js';
import { Worker } from 'worker_threads';
import { homedir } from 'os';
import { atomicWrite, PATHS, readJSONFile } from '../lib/fileUtils.js';
import { applyGrokUsageRepair } from './grokUsageBackfill.js';
import {
  applyHistoricalUsageCorrections,
  getReconciledUsageRunIds,
  getSiblingReconciledUsageRunIds
} from './usage.js';
import { listProviders } from './providers.js';
import { mergeUsageClaims, snapshotUsageClaims } from './usageReconciler.js';

const idleJob = () => ({
  status: 'idle',
  processed: 0,
  total: 0,
  found: 0,
  corrected: 0,
  grok: null,
  error: null,
  startedAt: null,
  completedAt: null
});

let job = idleJob();

const publicJob = () => ({ ...job });

const markRunMetadata = async (corrections) => {
  for (const correction of corrections) {
    // Non-strict exception: skip an unreadable run rather than replacing it
    // with a default; later backfills can retry the repaired metadata.
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
    ...idleJob(),
    status: 'running',
    startedAt: new Date().toISOString()
  };

  notifyUsageBackfillUpdated();

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

  // One repair per click, including when the transcript worker fails. It
  // writes the in-memory ledger, so it stays on this thread rather than in
  // the worker (that thread has its own copy of usage.js).
  let grokOnce = null;
  const repairGrok = () => {
    grokOnce ??= applyGrokUsageRepair({ home, providers: providerList })
      .then((result) => ({
        grok: {
          added: result.added || 0,
          turns: result.turns || 0,
          images: result.images || 0,
          videos: result.videos || 0,
          backedUp: Boolean(result.backedUp),
          note: result.note || null,
        },
        grokError: null,
      }))
      .catch((error) => ({ grok: null, grokError: error.message }));
    return grokOnce;
  };

  const fail = (error) => {
    job = { ...job, status: 'error', error, completedAt: new Date().toISOString() };
    notifyUsageBackfillUpdated();
  };

  let messageTail = Promise.resolve();
  worker.on('message', (message) => {
    messageTail = messageTail.then(async () => {
      if (message?.type === 'progress') {
        job = { ...job, ...message.progress, grok: job.grok ?? null };
        notifyUsageBackfillUpdated();
        return;
      }
      if (message?.type === 'error') {
        const repaired = await repairGrok();
        const error = [message.error || 'Backfill failed', repaired.grokError && `Grok usage repair failed: ${repaired.grokError}`]
          .filter(Boolean).join('. ');
        job = { ...job, status: 'error', error, grok: repaired.grok, completedAt: new Date().toISOString() };
        notifyUsageBackfillUpdated();
        return;
      }
      if (message?.type !== 'complete') return;
      const result = message.result || {};
      if (result.claimsSnapshot) mergeUsageClaims(result.claimsSnapshot);
      const applied = await applyHistoricalUsageCorrections(result.corrections || []);
      const appliedCorrections = (result.corrections || [])
        .filter((correction) => applied.correctedRunIds.includes(correction.runId));
      await markRunMetadata(appliedCorrections);
      const repaired = await repairGrok();
      if (repaired.grokError) {
        job = {
          ...job,
          status: 'error',
          error: `Grok usage repair failed: ${repaired.grokError}`,
          corrected: applied.corrected,
          grok: null,
          completedAt: new Date().toISOString()
        };
        notifyUsageBackfillUpdated();
        return;
      }
      job = {
        ...job,
        status: 'complete',
        processed: result.processed || 0,
        total: result.total || 0,
        found: result.corrections?.length || 0,
        corrected: applied.corrected,
        grok: repaired.grok,
        completedAt: new Date().toISOString()
      };
      notifyUsageBackfillUpdated();
    }).catch((error) => {
      fail(error.message);
    });
  });
  worker.on('error', (error) => {
    messageTail = messageTail.then(async () => {
      const repaired = await repairGrok();
      const message = [error.message, repaired.grokError && `Grok usage repair failed: ${repaired.grokError}`]
        .filter(Boolean).join('. ');
      job = { ...job, status: 'error', error: message, grok: repaired.grok, completedAt: new Date().toISOString() };
      notifyUsageBackfillUpdated();
    }).catch((err) => fail(err.message));
  });
  worker.unref();
  return publicJob();
}


export function __resetHistoricalUsageBackfillForTests() {
  job = idleJob();
}
