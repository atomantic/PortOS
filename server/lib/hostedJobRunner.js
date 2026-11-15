/**
 * `createHostedJobRunner()` owns a hosted media provider's job registry, SSE attach, per-job cancel surface and failure finalizer.
 *
 * Shared by the hosted image and video adapters (fal.ai, Runway, Higgsfield,
 * Google) through their domain twins in `services/{imageGen,videoGen}/hostedJobRunner.js`,
 * so a cancellation or cleanup fix lands once on paid providers (#16098).
 *
 * Cancel contract: a job still preparing answers `'pending'` and is refused at
 * `track()`; a tracked job is flagged `aborted`, its controller aborted, and
 * `cancelRemote(entry)` asked to stop the billed remote request (omitted by a
 * provider that cannot cancel remotely).
 */

import { withAbortTimeout } from './abortTimeout.js';
import { fetchWithTimeout } from './fetchWithTimeout.js';
import { createMediaJobPreparation } from './mediaJobPreparation.js';
import { anyAbortSignal } from './requestAbort.js';
import { attachSseClient as attachSse, createJobFailureFinalizer } from './sseUtils.js';

export function createHostedJobRunner({ name, label, events, cancelRemote = null, failedPayload }) {
  const jobs = new Map();
  // jobId → the provider's request entry ({ controller, aborted, …remote ids }).
  const activeRequests = new Map();
  const activeJobs = new Map();
  const preparations = createMediaJobPreparation();

  // jobId is required: with parallel renders an anonymous cancel would stop every in-flight one.
  const cancel = (jobId) => {
    if (!jobId) throw new Error(`${name}.cancel requires a jobId — use cancelAll() to terminate every in-flight render`);
    const pending = preparations.cancel(jobId);
    if (pending) return pending;
    const entry = activeRequests.get(jobId);
    if (!entry) return false;
    entry.aborted = true;
    entry.controller.abort();
    if (cancelRemote) void cancelRemote(entry);
    return true;
  };

  const cancelAll = () => {
    const ids = [...preparations.ids(), ...activeRequests.keys()];
    for (const id of ids) cancel(id);
    return ids.length > 0;
  };

  const finalizeJobFailure = createJobFailureFinalizer({ jobs, activeJobs, activeSlots: activeRequests, label, events, failedPayload });

  return {
    jobs,
    activeJobs,
    activeRequests,
    getActiveJob: () => [...activeJobs.values()].at(-1) ?? null,
    getActiveJobs: () => [...activeJobs.values()],
    attachSseClient: (jobId, res) => attachSse(jobs, jobId, res),
    cancel,
    cancelAll,
    /** Run `generate` inside a cancelable preparation window (mediaJobPreparation.js). */
    prepare: (params, generate) => preparations.run(params, generate),
    /** Install the render handle; synchronous at the submit handoff so a preparing cancel carries onto `entry.aborted`. */
    track: (jobId, entry) => {
      entry.aborted = preparations.take(jobId);
      activeRequests.set(jobId, entry);
      return entry;
    },
    /** A finished render's bytes, bounded (headers and body) by `timeoutMs` and by the job's cancel. */
    download: (entry, url, { timeoutMs, label: what }) => withAbortTimeout(timeoutMs, async (timeoutSignal) => {
      const response = await fetchWithTimeout(url, { signal: anyAbortSignal([timeoutSignal, entry.controller.signal]) }, timeoutMs);
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        throw new Error(`${what} download failed: HTTP ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    }),
    finalizeJobFailure,
    finalizeCanceled: (...args) => finalizeJobFailure.canceled(...args),
  };
}
