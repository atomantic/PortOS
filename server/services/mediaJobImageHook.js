/**
 * createMediaJobImageHook: shared tag-dispatch scaffold for media-job scene-asset
 * completion hooks (#1791, generalized to video in #1760 Phase 1). Each hook subscribes to
 * `mediaJobEvents 'completed'`, ignores jobs of the wrong `kind`, decodes and validates a
 * destination tag off `job.params`, and attaches the rendered asset (image filename or video
 * history id) to a record, serialized per key. A new "attach a render to record X" feature
 * is a new config object, not another listener.
 *
 * The scaffold owns:
 *   - idempotent init (no double-registered listener);
 *   - sync listener -> async IIFE -> top-level catch (EventEmitter does not catch async
 *     rejections, which are process-killing on Node >=15);
 *   - kind / missing-tag / missing-filename guards;
 *   - per-`serializeKey` serialization via `createKeyCachedQueue`;
 *   - opt-in newest-render-wins guard keyed on `sceneKey` (drops a render whose
 *     `job.queuedAt` is older than the newest applied to that slot);
 *   - best-effort error logging (logged, never thrown);
 *   - `__testing.reset()` and `__testing.settled()` (resolves once every accepted completion
 *     finished, so a test proves "nothing was written" without a sleep, #12047).
 *
 * Config:
 *   - `label`, `initLog`: failure/crash log label and the emoji-prefixed init line.
 *   - `tagKey`: the `job.params` key carrying the destination tag.
 *   - `identify(tag, job)`: validate and return the `ctx` identity (plus `job`, `tag`,
 *     `filename`) passed to the callbacks, or null to ignore the job.
 *   - `serializeKey(ctx)`: per-record write-serialization key.
 *   - `sceneKey(ctx)`: OPTIONAL; enables the newest-wins guard.
 *   - `attach(ctx)`: async durable attach; a falsy result means "nothing emitted".
 *   - `onAttached(ctx, result)`: emit the domain event + success log, only when `attach`
 *     returned a result the guard did not drop.
 *   - `onTerminal(ctx, status, job)`: OPTIONAL; also subscribes to `failed` / `canceled` for
 *     tagged jobs that ended without a result. A rejection is logged, never thrown.
 *
 * The canceled-to-client-spinner bridge (#1791) is NOT here: spinners correlate by media-job
 * id, so it lives once at the socket layer (`image-gen:canceled` / `video-gen:canceled`).
 */

import { mediaJobEvents } from './mediaJobQueue/index.js';
import { withBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { createKeyCachedQueue } from '../lib/createKeyCachedQueue.js';
import { createNewestWinsGuard } from '../lib/createNewestWinsGuard.js';

// The render filename is `${jobId}.<ext>`; prefer the job id, else strip the extension.
export const deriveRenderJobId = (job, filename) =>
  (typeof job?.id === 'string' && job.id ? job.id : String(filename).replace(/\.[a-z0-9]+$/i, ''));

export function createMediaJobImageHook(config) {
  const {
    label,
    initLog,
    tagKey,
    identify,
    serializeKey,
    sceneKey = null,
    attach,
    onAttached,
    onTerminal = null,
    // Optional: ctx -> short routing string (e.g. `workId/sceneId`) appended to the failure log.
    describe = null,
    // The media-job kind this hook attaches; defaults to 'image', the i2v hook (#1760) passes 'video'.
    kind = 'image',
    // Pull the fields to merge into `ctx` off a completed job, or null to ignore it. The
    // default surfaces `ctx.filename` (image hooks); the video hook surfaces `ctx.videoHistoryId`.
    extractResult = (job) => {
      const f = job.result?.filename;
      return (f && typeof f === 'string') ? { filename: f } : null;
    },
  } = config;

  const serialize = createKeyCachedQueue();
  const guard = createNewestWinsGuard();

  let completedHandler = null;
  let terminalHandlers = null;
  // Every accepted completion's work, so tests can await the outcome; entries remove themselves.
  const inFlight = new Set();

  const kinds = Array.isArray(kind) ? kind : [kind];

  // The tag → identity half of `decode`, shared with the terminal path (a
  // failed job carries no result to extract).
  function identity(job) {
    if (!job || !kinds.includes(job.kind)) return null;
    const tag = job.params?.[tagKey];
    if (!tag) return null;
    const id = identify(tag, job);
    return id ? { ...id, job, tag } : null;
  }

  // Decode the job into the hook's identity context (or null to ignore), keeping the kind/tag/result guards in one place.
  function decode(job) {
    const ctx = identity(job);
    if (!ctx) return null;
    const fields = extractResult(job);
    if (!fields) return null;
    // Normalize queuedAt once so the guard and any consumer's attach read the same `ctx.queuedAt`.
    const queuedAt = typeof job.queuedAt === 'string' ? job.queuedAt : null;
    return { ...ctx, ...fields, queuedAt };
  }

  function init() {
    // Idempotent: a double-init would register two listeners and double-file every render.
    if (completedHandler) return;

    completedHandler = (job) => {
      // Admitted synchronously (before any await) so the attach — a durable
      // row write that points at the render's file — is never split by a backup cut.
      const work = withBackupAssetPublication(async () => {
        const ctx = decode(job);
        if (!ctx) return;
        const sKey = sceneKey ? sceneKey(ctx) : null;

        const result = await serialize(serializeKey(ctx), async () => {
          // Newest-render-wins: drop an out-of-order older render (null, same as a declined
          // attach); checked and recorded inside the serialize section so it never races.
          if (sKey && guard.isStale(sKey, ctx.queuedAt)) return null;
          const r = await attach(ctx);
          // Record the slot's newest queuedAt only once the attach applied: a failed attach must not advance the guard.
          if (sKey && r != null) guard.mark(sKey, ctx.queuedAt);
          return r;
        }).catch((err) => {
          const where = describe ? ` → ${describe(ctx)}` : '';
          // The video lane has no filename (it attaches a history id); fall back to `describe`.
          console.log(`⚠️ ${label} hook failed for ${ctx.filename || 'render'}${where}: ${err?.message || String(err)}`);
          return null;
        });

        if (result != null) onAttached(ctx, result);
      }).catch((err) => {
        // Last-resort net for synchronous throws (unexpected job shape, etc).
        console.log(`⚠️ ${label} hook crashed: ${err?.message || err}`);
      });
      inFlight.add(work);
      work.finally(() => inFlight.delete(work));
    };

    mediaJobEvents.on('completed', completedHandler);
    if (onTerminal) {
      const forStatus = (status) => (job) => {
        const ctx = identity(job);
        if (!ctx) return;
        // Outside the request lifecycle: a rejection here has no error middleware.
        Promise.resolve()
          .then(() => onTerminal(ctx, status, job))
          .catch((err) => console.log(`⚠️ ${label} ${status} bookkeeping failed${describe ? ` → ${describe(ctx)}` : ''}: ${err?.message || err}`));
      };
      terminalHandlers = { failed: forStatus('failed'), canceled: forStatus('canceled') };
      mediaJobEvents.on('failed', terminalHandlers.failed);
      mediaJobEvents.on('canceled', terminalHandlers.canceled);
    }
    console.log(initLog);
  }

  // Test-only reset; removes the registered listener so re-init does not leak handlers.
  const __testing = {
    reset: () => {
      if (completedHandler) {
        mediaJobEvents.off('completed', completedHandler);
        completedHandler = null;
      }
      if (terminalHandlers) {
        mediaJobEvents.off('failed', terminalHandlers.failed);
        mediaJobEvents.off('canceled', terminalHandlers.canceled);
        terminalHandlers = null;
      }
      serialize.clear();
      guard.clear();
    },
    // Loops: a completion emitted while an earlier one was in flight joins the set late.
    settled: async () => {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };

  return { init, __testing };
}
