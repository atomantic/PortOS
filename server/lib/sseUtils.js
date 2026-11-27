// Shared helpers for the per-job SSE streams used by imageGen/local.js and videoGen/local.js.
//
// Both providers attach a list of `res` clients to a per-jobId record and broadcast diffuser progress
// as SSE frames; this module keeps the wire format and the response headers in one place.
//
// `createSseRunner` (bottom of file) layers a run-lifecycle on top of these
// primitives for the pipeline batch runners (manuscript completeness, editorial
// analysis, editorial checks) that all share an identical in-memory `runs` map +
// fire-and-forget coordinator shape.

import { randomUUID } from 'crypto';
import { SSE_HEADERS } from './sseHeaders.js';

// Filters Python child noise (HF/torch/bitsandbytes/xformers warnings, deprecation
// notices, etc.) that would otherwise drown the user's view of real progress.
// `^\[transformers\]` covers transformers' custom logger output (e.g.
// "[transformers] `Siglip2ImageProcessorFast` is deprecated...").
// `\bis deprecated\b` covers generic deprecation prose without a Warning
// suffix that wouldn't match `DeprecationWarning`.
export const PYTHON_NOISE_RE = /xformers|xFormers|triton|Triton|bitsandbytes|Please reinstall|Memory-efficient|Set XFORMERS|FutureWarning|UserWarning|DeprecationWarning|torch\.distributed|Unable to import.*torchao|Skipping import of cpp|NOTE: Redirects|^\[transformers\]|\bis deprecated\b/i;

// Late-connecting EventSource clients sometimes re-attach during the brief
// window between `complete` and the route teardown. Hold the SSE list open
// for this many ms after the underlying job finishes so a client that
// connected just after the terminal broadcast still gets it (replayed from
// `job.lastPayload`) instead of hanging until timeout.
export const SSE_CLEANUP_DELAY_MS = 5000;

export const broadcastSse = (job, payload, { retain = true } = {}) => {
  // Cache the most recent payload on the job so attachSseClient can replay
  // it to a client that connects after this fired. Without this, a client
  // that races with `complete` would hang waiting for a frame that already
  // shipped.
  //
  // `retain: false` is for frames that are a running SNAPSHOT of state a late
  // client can fetch another way (the autopilot's `progress` frame, whose
  // content the status route also serves). Retaining those would let them
  // occupy the single replay slot and hide the last frame that said what the
  // run is actually doing.
  if (retain) job.lastPayload = payload;
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  // Isolate each client's write — a dead client's `res.write` throwing (a
  // closed/broken pipe) must not abort the loop and starve every later
  // client in `job.clients` of a frame their connection is still open for
  // (#8915).
  for (const c of job.clients) {
    try {
      c.write(msg);
    } catch (err) {
      console.error(`❌ SSE client write failed, dropping this subscriber's frame: ${err?.message || err}`);
    }
  }
};

// Dispatches a job's terminal SSE frame and its companion lifecycle event
// (`imageGenEvents`/`videoGenEvents` 'completed'/'failed') INDEPENDENTLY: each
// call gets its own try/catch, so a throw from one — a dead client's
// `res.write` throwing inside `sseSend`, or a throwing listener inside
// `emitEvent` — cannot suppress the other. Terminal dispatch is otherwise a
// bare `broadcastSse(...)` followed by `events.emit(...)`, and the lifecycle
// event drives durable side effects (gallery index, peer sync, job-queue
// settlement) that must fire regardless of whether the best-effort SSE write
// to a possibly-dead client succeeds (#8915). `jobId` is only for the error
// log line.
export const dispatchTerminalEvent = (jobId, sseSend, emitEvent) => {
  try {
    sseSend();
  } catch (err) {
    console.error(`❌ SSE terminal broadcast failed [${String(jobId).slice(0, 8)}]: ${err?.message || err}`);
  }
  try {
    emitEvent();
  } catch (err) {
    console.error(`❌ Lifecycle event dispatch failed [${String(jobId).slice(0, 8)}]: ${err?.message || err}`);
  }
};

export const attachSseClient = (jobs, jobId, res) => {
  const job = jobs.get(jobId);
  if (!job) return false;
  res.writeHead(200, SSE_HEADERS);
  job.clients.push(res);
  // Replay the last broadcasted frame so a client that connected after a
  // `complete`/`error` (within the SSE_CLEANUP_DELAY_MS grace window) sees
  // the terminal state instead of an empty stream.
  if (job.lastPayload) {
    res.write(`data: ${JSON.stringify(job.lastPayload)}\n\n`);
  }
  res.req.on('close', () => {
    job.clients = job.clients.filter((c) => c !== res);
  });
  return true;
};

// Drains any late-connecting EventSource clients then removes the job
// from the per-provider job map. Both providers do this on child exit.
//
// `expectedJob` (optional) guards against a fresh run replacing this one under
// the same key during the grace window: if the map no longer holds the job this
// timer was scheduled for, end only the original job's lingering clients and
// leave the replacement (and the map entry) untouched. Without it, restarting a
// run for the same key inside SSE_CLEANUP_DELAY_MS would have the old timer
// evict the new run and close its clients. Callers that never restart within
// the window can omit it for the original delete-by-key behavior.
export const closeJobAfterDelay = (jobs, jobId, delay = SSE_CLEANUP_DELAY_MS, expectedJob = null) => {
  setTimeout(() => {
    const job = jobs.get(jobId);
    if (expectedJob && job !== expectedJob) {
      // A newer run took this key — drain the stale job's clients but don't
      // delete the live entry.
      for (const c of expectedJob.clients || []) c.end();
      return;
    }
    // `clients` is absent on job maps that use this purely for eviction (the
    // voice fine-tuning registry has no SSE route), so guard like the branch above.
    if (job) for (const c of job.clients || []) c.end();
    jobs.delete(jobId);
  }, delay);
};

// Queue settlement listens for 'failed' with the cancellation reason. Direct SSE consumers
// receive their own canceled terminal frame, including clients attaching after the child exits.
export function dispatchCanceledJob(job, jobId, label, emitSettlement) {
  job.status = 'canceled';
  console.log(`⏹️ ${label} canceled [${jobId.slice(0, 8)}]`);
  dispatchTerminalEvent(jobId, () => broadcastSse(job, { type: 'canceled', reason: 'Canceled' }), emitSettlement);
}

// Shared "this job died" finalizer for the media-generation backends (imageGen/{agy,codex,grok,fal}.js, videoGen/{grok,fal,reactor}.js): idempotency guard, clear the active-slot map,
// stamp `job.status = 'error'`, drop from `activeJobs`, log, broadcast an SSE error frame, emit `failed`, and `closeJobAfterDelay` (#6830: private copies had drifted).
//
// `activeSlots` is the per-jobId "who owns this render" map (`activeProcs` for CLI-spawn backends, `activeRequests` for REST-poll ones). The finalizer takes `slotOwner` per call:
// pass the current owner to clear the slot only when it still belongs to THIS job (a late finalize from a cancelled run must not wipe a newer job's slot), or `null` for a backend
// whose slot map has no owner identity (deletes unconditionally).
//
// `failedPayload(jobId, reason)` builds the `events.emit('failed', …)` body; it defaults to the video shape (`{ generationId, error }`), and image backends add `mode`
// (read by `imageGenQuota.js`). The canceled path settles the same queue subscriber with a distinct SSE terminal.
export const createJobFailureFinalizer = ({
  jobs, activeJobs, activeSlots, label, events,
  failedPayload = (jobId, reason) => ({ generationId: jobId, error: reason }),
}) => {
  const clearActive = (jobId, slotOwner) => {
    if (slotOwner == null || activeSlots.get(jobId) === slotOwner) activeSlots.delete(jobId);
    activeJobs.delete(jobId);
  };
  const finalize = (job, jobId, slotOwner, reason, { force = false, code } = {}) => {
    // Idempotent except under `force` — spawn failures fire 'error' AND a
    // follow-up 'close', so both paths reach this finalizer, and a caller
    // whose success path can throw AFTER stamping 'complete' passes `force`
    // to still deliver a terminal 'failed' for that window.
    if (!force && (job.status === 'error' || job.status === 'complete' || job.status === 'canceled')) return;
    clearActive(jobId, slotOwner);
    job.status = 'error';
    // Provider errors can echo private prompts and input URLs. Keep the details
    // on the job channel; operational logs need only the backend and job id.
    console.error(`❌ ${label} failed [${jobId.slice(0, 8)}]`);
    const details = code ? { code } : {};
    dispatchTerminalEvent(
      jobId,
      () => broadcastSse(job, { type: 'error', error: reason, ...details }),
      () => events.emit('failed', { ...failedPayload(jobId, reason, slotOwner), ...details }),
    );
    closeJobAfterDelay(jobs, jobId);
  };
  finalize.canceled = (job, jobId, slotOwner = null) => {
    if (job.status === 'canceled') return;
    clearActive(jobId, slotOwner);
    dispatchCanceledJob(job, jobId, label, () => events.emit('failed', failedPayload(jobId, 'Canceled', slotOwner)));
    closeJobAfterDelay(jobs, jobId);
  };
  return finalize;
};

// ---------------------------------------------------------------------------
// createSseRunner: shared batch-runner lifecycle for the pipeline runners (manuscript completeness, editorial analysis, editorial checks): a `runs` Map keyed by seriesId,
// `scheduleCleanup` lingering a finished run for terminal-frame replay (identity-guarded so a restart isn't clobbered), `attachClient`/`cancel`/`isActive`, and a `start` that
// guards a duplicate in-flight run, mints a runId + AbortController, and drives the work in a fire-and-forget IIFE whose catch/finally emit `error` and schedule cleanup.
// ---------------------------------------------------------------------------
//
// The caller supplies only `work({ runId, signal, record, broadcast })`, which owns its `start`/`complete`/`canceled` frames and seeding; the factory owns the `error` frame, `finished`
// flag and cleanup. A caller whose error frame carries extra fields (or a status side-effect) keeps its own try/catch inside `work`; the factory's catch is the safety net.
// `logLabel` is interpolated into the failure log (`❌ <logLabel> failed — …`).
//
// `start(key, work, { sig, meta })` optionally coalesces by signature: with `sig`, a second kickoff coalesces only if signatures match; a DIFFERENT one returns
// `{ alreadyRunning: true, conflict: true, ...meta }` (the live run's `meta`, e.g. `{ op }`) so the caller won't bind onto unrelated work. Without `sig`, any in-flight run coalesces.
// `work` may stamp `record.phase` so `listActive` can report it to a client attaching mid-run.
// Returns `{ runs, isActive, attachClient, listActive, cancel, start }`; `runs` is exposed so a module can re-export it as `__testing.runs`.
export function createSseRunner({ logLabel = 'sse run' } = {}) {
  // runs: Map<key, { runId, clients[], lastPayload, cancelRequested, finished, cleanupTimer, startedAt, abort, sig, meta }>
  // A finished run lingers in the map for SSE_CLEANUP_DELAY_MS so late-attaching
  // clients can replay its terminal frame — but `finished` lets `isActive` and
  // the restart guard treat it as done, so an immediate re-run isn't swallowed.
  const runs = new Map();

  // Hold a finished run open briefly for terminal-frame replay, then evict it —
  // but only if THIS record is still the one mapped, so a restart that replaced
  // it within the window isn't clobbered by the prior run's timer.
  const scheduleCleanup = (key, record) => {
    record.cleanupTimer = setTimeout(() => {
      if (runs.get(key) !== record) return;
      for (const c of record.clients) c.end();
      runs.delete(key);
    }, SSE_CLEANUP_DELAY_MS);
  };

  const isActive = (key) => {
    const run = runs.get(key);
    return !!run && !run.finished;
  };

  const attachClient = (key, res) => attachSseClient(runs, key, res);

  // Bounded read-only view of the runs still in flight whose key starts with
  // `prefix` — a discovery surface for a client that lost its run slot (reload,
  // second tab). Exposes only identity + the caller's own `meta` + the latest
  // phase label, never the signature, clients, or abort controller, and a
  // finished run lingering in its replay window is NOT listed (it is not running).
  const listActive = (prefix = '') => {
    const out = [];
    for (const [key, run] of runs) {
      if (run.finished || !String(key).startsWith(prefix)) continue;
      out.push({ key, runId: run.runId, startedAt: run.startedAt, phase: run.phase ?? null, meta: { ...(run.meta || {}) } });
    }
    return out;
  };

  const cancel = (key) => {
    const run = runs.get(key);
    if (!run) return false;
    run.cancelRequested = true;
    run.abort?.abort();
    return true;
  };

  // Kick off a run for `key`. Re-calling while a run is in flight resolves to the
  // existing runId (no second coordinator) — unless `sig` is passed and differs
  // from the in-flight run's, in which case it reports a `conflict` instead of
  // coalescing (see the factory doc above). `work` runs inside the IIFE below.
  const start = (key, work, { sig = null, meta = null } = {}) => {
    const existing = runs.get(key);
    if (existing && !existing.finished) {
      // A different signature means different work — refuse to coalesce so the
      // caller doesn't bind onto an unrelated in-flight run; surface the live
      // run's meta (e.g. its `op`) for the conflict report.
      if (sig !== null && existing.sig !== sig) {
        return { runId: existing.runId, alreadyRunning: true, conflict: true, ...(existing.meta || {}) };
      }
      return { runId: existing.runId, alreadyRunning: true };
    }
    if (existing) {
      // A finished run still in its replay window — cancel its pending eviction
      // and drop its replay clients so this fresh run fully replaces it.
      if (existing.cleanupTimer) clearTimeout(existing.cleanupTimer);
      for (const c of existing.clients) c.end();
    }
    const runId = randomUUID();
    const abort = new AbortController();
    const record = {
      runId,
      clients: [],
      lastPayload: null,
      cancelRequested: false,
      finished: false,
      cleanupTimer: null,
      startedAt: new Date().toISOString(),
      abort,
      sig,
      meta,
    };
    runs.set(key, record);

    const broadcast = (payload) => {
      const run = runs.get(key);
      if (!run) return;
      broadcastSse(run, payload);
    };

    // Fire-and-forget coordinator. The try/catch is the permitted boundary use:
    // an unhandled rejection here would crash the process on Node ≥15.
    (async () => {
      try {
        await work({ runId, signal: abort.signal, record, broadcast });
      } catch (err) {
        const message = (err?.message || String(err)).slice(0, 1000);
        console.error(`❌ ${logLabel} failed — series=${String(key).slice(0, 12)} ${message}`);
        broadcast({ type: 'error', runId, error: message, failedAt: new Date().toISOString() });
      } finally {
        record.finished = true;
        scheduleCleanup(key, record);
      }
    })();

    return { runId, alreadyRunning: false };
  };

  return { runs, isActive, attachClient, listActive, cancel, start };
}
