import { notifyUsageBackfillUpdated } from './usageBackfillEvents.js';
import { Worker } from 'worker_threads';
import { randomUUID } from 'node:crypto';
import { homedir } from 'os';
import { atomicWrite, PATHS, readJSONFile } from '../lib/fileUtils.js';
import { applyGrokUsageRepair } from './grokUsageBackfill.js';
import { applyAgyUsageRepair } from './agyUsageBackfill.js';
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
  agy: null,
  error: null,
  startedAt: null,
  completedAt: null
});

let job = idleJob();
let previewWorker = null;

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


/** Read-only inspection shares the existing job and socket lifecycle, never the repair callback. */
export function startCodexUsagePreview({ from, to, home = homedir(), WorkerClass = Worker } = {}) {
  if (job.status === 'running' || job.status === 'cancelling') return publicJob();
  const id = randomUUID();
  job = { ...idleJob(), id, mode: 'preview', range: { from, to }, status: 'running', startedAt: new Date().toISOString() };
  const finish = (status, extra = {}) => {
    if (job.id !== id || job.status !== 'running') return;
    job = { ...job, status, ...extra, completedAt: new Date().toISOString() };
    previewWorker = null;
    notifyUsageBackfillUpdated();
  };
  // Constructor failures must not leave the shared job stuck running.
  try {
    const worker = new WorkerClass(new URL('./usageBackfillWorker.js', import.meta.url), {
      workerData: { mode: 'preview', from, to, home }
    });
    previewWorker = worker;
    worker.on('message', message => {
      if (message?.type === 'complete') finish('complete', { preview: message.result });
      if (message?.type === 'error') finish('error', { error: 'Codex source preview failed. Retry the scan.' });
    });
    worker.on('error', () => finish('error', { error: 'Codex source preview worker failed. Retry the scan.' }));
    worker.on('exit', () => finish('error', { error: 'Codex source preview stopped before returning a result.' }));
    worker.unref();
  } catch {
    finish('error', { error: 'Codex source preview could not start. Retry the scan.' });
  }
  notifyUsageBackfillUpdated();
  return publicJob();
}

export async function cancelCodexUsagePreview(id) {
  if (job.id !== id || job.mode !== 'preview' || job.status !== 'running' || !previewWorker) return publicJob();
  const worker = previewWorker;
  job = { ...job, status: 'cancelling' };
  notifyUsageBackfillUpdated();
  await worker.terminate().catch(() => {
    if (job.id === id) {
      job = { ...job, status: 'error', error: 'Could not cancel the preview worker. Retry the preview.', completedAt: new Date().toISOString() };
      previewWorker = null;
      notifyUsageBackfillUpdated();
    }
    throw new Error('Could not cancel the preview worker. Retry the preview.');
  });
  if (job.id === id) {
    job = { ...job, status: 'cancelled', completedAt: new Date().toISOString() };
    previewWorker = null;
    notifyUsageBackfillUpdated();
  }
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
  if (job.status === 'running' || job.status === 'cancelling') return publicJob();

  const id = randomUUID();
  job = {
    ...idleJob(),
    id,
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

  let agyOnce = null;
  const repairAgy = () => {
    agyOnce ??= applyAgyUsageRepair({ home, providers: providerList })
      .then((result) => ({
        agy: {
          added: result.added || 0,
          images: result.images || 0,
          backedUp: Boolean(result.backedUp),
          note: result.note || null,
        },
        agyError: null,
      }))
      .catch((error) => ({ agy: null, agyError: error.message }));
    return agyOnce;
  };

  const repairMedia = async () => {
    const [repairedGrok, repairedAgy] = await Promise.all([repairGrok(), repairAgy()]);
    const errors = [
      repairedGrok.grokError && `Grok usage repair failed: ${repairedGrok.grokError}`,
      repairedAgy.agyError && `Antigravity usage repair failed: ${repairedAgy.agyError}`,
    ].filter(Boolean);
    return {
      grok: repairedGrok.grok,
      agy: repairedAgy.agy,
      error: errors.length ? errors.join('. ') : null,
    };
  };

  const fail = (error) => {
    if (job.id !== id || job.status !== 'running') return;
    job = { ...job, status: 'error', error, completedAt: new Date().toISOString() };
    notifyUsageBackfillUpdated();
  };

  let messageTail = Promise.resolve();
  worker.on('message', (message) => {
    messageTail = messageTail.then(async () => {
      if (job.id !== id || job.status !== 'running') return;
      if (message?.type === 'progress') {
        job = { ...job, ...message.progress, grok: job.grok ?? null, agy: job.agy ?? null };
        notifyUsageBackfillUpdated();
        return;
      }
      if (message?.type === 'error') {
        const repaired = await repairMedia();
        const error = [message.error || 'Backfill failed', repaired.error]
          .filter(Boolean).join('. ');
        job = { ...job, status: 'error', error, grok: repaired.grok, agy: repaired.agy, completedAt: new Date().toISOString() };
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
      const repaired = await repairMedia();
      if (repaired.error) {
        job = {
          ...job,
          status: 'error',
          error: repaired.error,
          corrected: applied.corrected,
          grok: repaired.grok,
          agy: repaired.agy,
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
        agy: repaired.agy,
        completedAt: new Date().toISOString()
      };
      notifyUsageBackfillUpdated();
    }).catch((error) => {
      fail(error.message);
    });
  });
  worker.on('error', (error) => {
    messageTail = messageTail.then(async () => {
      if (job.id !== id || job.status !== 'running') return;
      const repaired = await repairMedia();
      const message = [error.message, repaired.error]
        .filter(Boolean).join('. ');
      job = { ...job, status: 'error', error: message, grok: repaired.grok, agy: repaired.agy, completedAt: new Date().toISOString() };
      notifyUsageBackfillUpdated();
    }).catch((err) => fail(err.message));
  });
  worker.unref();
  return publicJob();
}


export function __resetHistoricalUsageBackfillForTests() {
  job = idleJob();
  previewWorker = null;
}
