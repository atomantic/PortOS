import { notifyUsageBackfillUpdated } from './usageBackfillEvents.js';
import { Worker } from 'worker_threads';
import { randomUUID } from 'node:crypto';
import { homedir } from 'os';
import { atomicWrite, PATHS, readJSONFile } from '../lib/fileUtils.js';
import { isHostShuttingDown } from '../lib/hostShutdown.js';
import { applyGrokUsageRepair } from './grokUsageBackfill.js';
import { applyAgyUsageRepair } from './agyUsageBackfill.js';
import { applyCodexSpeedRepair } from './codexSpeedRepair.js';
import {
  applyHistoricalUsageCorrections,
  getReconciledUsageRunIds,
  getSiblingReconciledUsageRunIds
} from './usage.js';
import { listProviders } from './provider/providers.js';
import { mergeUsageClaims, snapshotUsageClaims } from './usageReconciler.js';

const idleJob = () => ({
  status: 'idle',
  processed: 0,
  total: 0,
  found: 0,
  corrected: 0,
  grok: null,
  codex: null,
  agy: null,
  error: null,
  startedAt: null,
  completedAt: null
});

const SHUTDOWN_ERROR = 'Historical usage backfill interrupted by server shutdown';
let job = idleJob();
let stopActiveWorker = null;

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

export async function stopHistoricalUsageBackfill() {
  await stopActiveWorker?.();
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
  if (isHostShuttingDown() || job.status === 'running') return publicJob();

  const id = randomUUID();
  job = {
    ...idleJob(),
    id,
    status: 'running',
    startedAt: new Date().toISOString()
  };

  notifyUsageBackfillUpdated();

  const fail = (error, repairs = {}) => {
    if (job.id !== id || job.status !== 'running') return;
    job = { ...job, ...repairs, status: 'error', error, completedAt: new Date().toISOString() };
    notifyUsageBackfillUpdated();
  };

  // Resolved HERE, not inside the worker: the toolkit singleton that backs
  // `listProviders()` is never initialized in a worker thread, so a worker-side
  // lookup would silently find no provider to attribute a nested session to.
  // `job.status` is already `running` above, so the await can't let a second
  // POST start a duplicate scan.
  const providerList = providers ?? await listProviders().catch(() => []);
  let worker;
  try {
    const { listUsageRunIds } = await import('./usageBackfillWorker.js');
    const runIds = await listUsageRunIds(runsDir);
    const [reconciledRunIds, siblingReconciledRunIds] = await Promise.all([
      getReconciledUsageRunIds(runIds), getSiblingReconciledUsageRunIds(runIds),
    ]);
    // An accepted request may still be in preflight when the shutdown starts.
    if (isHostShuttingDown()) {
      fail(SHUTDOWN_ERROR);
      return publicJob();
    }
    worker = new WorkerClass(new URL('./usageBackfillWorker.js', import.meta.url), {
      workerData: {
        runsDir,
        runIds,
        home,
        reconciledRunIds,
        siblingReconciledRunIds,
        providers: providerList,
        // The worker has a separate claim ledger. Seed it with messages already
        // billed by live completion so the historical scan doesn't bill them again.
        claimsSeed: snapshotUsageClaims()
      }
    });
  } catch (error) {
    fail(error.message);
    return publicJob();
  }

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
          fast: result.fast || 0,
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

  let codexOnce = null;
  const repairCodex = () => {
    codexOnce ??= applyCodexSpeedRepair({ home, providers: providerList })
      .then((result) => ({
        codex: {
          added: result.added || 0,
          sessions: result.sessions || 0,
          backedUp: Boolean(result.backedUp),
          note: result.note || null,
        },
        codexError: null,
      }))
      .catch((error) => ({ codex: null, codexError: error.message }));
    return codexOnce;
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
    // Sequential: each repair loads and saves the same ledger. The write queue
    // keeps one save from dropping another, and finishing one plan before the
    // next starts keeps a repair id written by the first visible to the second.
    const repairedGrok = await repairGrok();
    const repairedCodex = await repairCodex();
    const repairedAgy = await repairAgy();
    const errors = [
      repairedGrok.grokError && `Grok usage repair failed: ${repairedGrok.grokError}`,
      repairedCodex.codexError && `Codex speed repair failed: ${repairedCodex.codexError}`,
      repairedAgy.agyError && `Antigravity usage repair failed: ${repairedAgy.agyError}`,
    ].filter(Boolean);
    return {
      grok: repairedGrok.grok,
      codex: repairedCodex.codex,
      agy: repairedAgy.agy,
      error: errors.length ? errors.join('. ') : null,
    };
  };

  const failWithRepairs = async (error) => {
    if (job.id !== id || job.status !== 'running') return;
    const { error: repairError, ...repairs } = await repairMedia();
    fail([error, repairError].filter(Boolean).join('. '), repairs);
  };

  let messageTail = Promise.resolve();
  let exited = false;
  let termination;
  const stop = async () => {
    if (!exited) {
      termination ??= worker.terminate();
      await termination;
    }
    await messageTail;
  };
  stopActiveWorker = stop;
  const enqueue = (handle) => {
    messageTail = messageTail.then(handle).catch((error) => fail(error.message));
  };

  worker.on('message', (message) => {
    enqueue(async () => {
      if (job.id !== id || job.status !== 'running') return;
      if (message?.type === 'progress') {
        job = { ...job, ...message.progress, grok: job.grok ?? null, codex: job.codex ?? null, agy: job.agy ?? null };
        notifyUsageBackfillUpdated();
        return;
      }
      if (message?.type === 'error') {
        await failWithRepairs(message.error || 'Backfill failed');
        return;
      }
      if (message?.type !== 'complete') return;
      const result = message.result || {};
      const applied = await applyHistoricalUsageCorrections(result.corrections || []);
      if (result.claimsSnapshot) mergeUsageClaims(result.claimsSnapshot);
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
          codex: repaired.codex,
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
        codex: repaired.codex,
        agy: repaired.agy,
        completedAt: new Date().toISOString()
      };
      notifyUsageBackfillUpdated();
    });
  });
  worker.on('error', (error) => {
    enqueue(() => failWithRepairs(error.message));
  });
  worker.once('exit', (code) => {
    exited = true;
    // The final message or error may still be applying repairs on this thread.
    enqueue(async () => {
      try {
        if (termination) fail(SHUTDOWN_ERROR);
        else await failWithRepairs(`Historical usage backfill worker exited before reporting a result (code ${code})`);
      } finally {
        if (stopActiveWorker === stop) stopActiveWorker = null;
      }
    });
  });
  worker.unref();
  return publicJob();
}


export function __resetHistoricalUsageBackfillForTests() {
  job = idleJob();
  stopActiveWorker = null;
}
