/** Manages execution evidence, the heavy-job claim and unpublished files for a local video render. */

import { join } from 'path';
import { PATHS, rmGuarded } from '../../lib/fileUtils.js';
import { claimHeavyLocalJob } from '../../lib/heavyJobClaim.js';
import { recordVideoExecution, recordVideoExecutionDiagnostics } from './executionRecorder.js';
import { ServerError } from '../../lib/errorHandler.js';
import { discardUnpublishedVideo } from './generateVideoHelpers.js';
import { videoJobState } from './jobState.js';

export function createRenderDiagnostics({ jobId, executionParent, model }) {
  let memoryEvidence = {};
  let memoryTimer = null;
  let memoryWrites = Promise.resolve();
  const flushMemoryEvidence = () => {
    clearTimeout(memoryTimer);
    memoryTimer = null;
    if (Object.keys(memoryEvidence).length) {
      const memory = { ...memoryEvidence };
      memoryWrites = memoryWrites.catch(() => {}).then(() => recordVideoExecutionDiagnostics(jobId, { memory }, ...(executionParent ? [executionParent] : [])));
    }
    return memoryWrites;
  };
  const collectMemoryEvidence = (raw) => {
    if (model.runtime !== 'minimax_h3' || !raw.startsWith('H3MEMORY:') || raw.length > 1024) return false;
    let sample;
    try { sample = JSON.parse(raw.slice('H3MEMORY:'.length)); } catch { return true; }
    for (const key of ['allocatorLimitBytes', 'peakAllocatedBytes', 'peakRssBytes']) {
      const value = sample?.[key];
      if (Number.isSafeInteger(value) && value >= 0) {
        memoryEvidence[key] = key.startsWith('peak') ? Math.max(memoryEvidence[key] || 0, value) : value;
      }
    }
    if (typeof sample?.allocatorApplied === 'boolean') memoryEvidence.allocatorApplied = sample.allocatorApplied;
    if (!memoryTimer) memoryTimer = setTimeout(() => {
      void flushMemoryEvidence().catch(err => {
        console.error(`❌ Video memory evidence persistence failed [${jobId.slice(0, 8)}]: ${err.message}`);
      });
    }, 250);
    return true;
  };
  const persistTermination = async (exitCode, signal, reason) => {
    // The pre-launch receipt gates execution; later diagnostics must never
    // replace a known render outcome or an admission refusal.
    clearTimeout(memoryTimer);
    memoryTimer = null;
    try {
      // Batch failures were reported by their timer. Retry the latest memory
      // together with termination so a memory-write fault cannot omit a signal.
      await memoryWrites.catch(() => {});
      await recordVideoExecutionDiagnostics(jobId, {
        ...(Object.keys(memoryEvidence).length ? { memory: { ...memoryEvidence } } : {}),
        termination: { exitCode, signal, reason, observedAt: new Date().toISOString() },
      }, ...(executionParent ? [executionParent] : []));
    } catch (error) {
      console.error(`❌ Video termination evidence persistence failed [${jobId.slice(0, 8)}]: ${error.message}`);
    }
  };
  return { collectMemoryEvidence, persistTermination };
}

export async function acquireRenderClaim({
  jobId, meta, executionParent, modelId, actualSeed, width: w, height: h, numFrames: parsedNumFrames,
  steps: actualSteps, batch, cleanupTempFiles, stepwiseDir,
}, { retainOwnership, persistTermination }) {
  // No child and no claim exist yet, so this startup owner releases what the
  // caller handed over. A refusal (busy holder) and a claim I/O rejection both
  // end here, and neither touches another owner's claim.
  const releaseUnclaimedStartup = async () => {
    videoJobState.jobs.delete(jobId);
    const results = await Promise.allSettled([
      cleanupTempFiles({ includeUploads: true }),
      rmGuarded(stepwiseDir, { recursive: true, force: true }),
    ]);
    if (results.some(result => result.status === 'rejected')) retainOwnership();
  };
  let heavyClaim;
  try {
    await recordVideoExecution(jobId, { ...meta, ...(executionParent ? { executionParent } : {}), modelId, seed: actualSeed, width: w, height: h,
      numFrames: parsedNumFrames, steps: actualSteps, ...(batch ? { batchSeeds: batch.map(item => item.seed) } : {}) });
    heavyClaim = await claimHeavyLocalJob({ kind: 'local video generation', id: jobId });
  } catch (err) {
    console.error(`❌ Video generation claim acquisition [${jobId.slice(0, 8)}]: ${err.message}`);
    await releaseUnclaimedStartup();
    await persistTermination(null, null, 'refused');
    throw err;
  }
  if (!heavyClaim.ok) {
    await releaseUnclaimedStartup();
    await persistTermination(null, null, 'refused');
    throw new ServerError(heavyClaim.message, { status: 409, code: 'HEAVY_LOCAL_JOB_BUSY', context: { holder: heavyClaim.holder } });
  }
  return heavyClaim;
}

export function trackRenderOutputs({ jobId, outputPath, batch }, retainOwnership) {
  // Every file this render was asked to write, in the order the runner emits
  // them. Job-level (a relaunch renders the SAME outputs), and the yardstick the
  // post-completion teardown recovery below measures a child's result claims
  // against — so "it printed a path" can never stand in for "it printed OUR path".
  const expectedOutputPaths = batch
    ? batch.map((item) => join(PATHS.videos, item.filename))
    : [outputPath];
  const publications = new Map(expectedOutputPaths.map(path => [path, {}]));
  const discardFailedOutputs = async () => {
    for (const [index, path] of expectedOutputPaths.entries()) {
      if (publications.get(path).committed) continue;
      await discardUnpublishedVideo({ jobId: batch ? batch[index].id : jobId, outputPath: path }).catch(retainOwnership);
    }
  };
  return { expectedOutputPaths, publications, discardFailedOutputs };
}

export function stopAbandonedChild(child, jobId, retainOwnership) {
  if (!child) return;
  // This child has no completion listener. A kill request cannot certify
  // its physical exit, so only explicit recovery can clear this ownership.
  if (child.pid && child.exitCode == null && child.signalCode == null) retainOwnership();
  try {
    child.kill('SIGTERM');
  } catch (err) {
    console.error(`❌ abandoned video render child would not stop [${jobId.slice(0, 8)}]: ${err.message}`);
  }
}
