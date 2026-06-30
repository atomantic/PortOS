/**
 * createMediaJobImageHook — shared tag-dispatch scaffold for the media-job
 * scene-asset completion hooks (#1791, generalized to video in #1760 Phase 1).
 *
 * Four completion hooks (writers-room #1363, catalog #1359, music-video scene
 * image #1760 Phase 1b, music-video scene video #1760 Phase 1) each subscribe to
 * `mediaJobEvents 'completed'` and do the same shape of work: ignore jobs of the
 * wrong `kind`, decode a destination tag off `job.params`, validate its fields,
 * attach the rendered asset (an image filename or a video history id) onto a
 * record (serialized per-key so two renders for the same record can't clobber
 * each other), and — for the scene-frame hooks — drop an out-of-order older
 * render so it can't overwrite a newer one. This factory owns that copy-pasted
 * skeleton so each hook becomes a small config; a new "attach a render to record
 * X" feature is a new config object, not another hand-wired listener. The job
 * `kind` and the attached-value extraction are config knobs (`kind`,
 * `extractResult`) so the scaffold covers both image and video jobs.
 *
 * The shared skeleton this owns:
 *   - the idempotent init (a stray double-init must not double-register the
 *     listener and double-file every render);
 *   - the sync listener → async IIFE → top-level catch pattern (EventEmitter
 *     does not await async listeners or catch their rejections, so a throw would
 *     surface as a process-killing unhandled rejection on Node ≥15);
 *   - the `job.kind !== 'image'` / missing-tag / missing-filename guards;
 *   - per-`serializeKey` serialization via the shared `createKeyCachedQueue`;
 *   - the opt-in newest-render-wins guard keyed on `sceneKey` (drop a render
 *     whose `job.queuedAt` is older than the newest already applied to that
 *     scene slot — read+written inside the serialize section so it never races);
 *   - best-effort error logging (a bookkeeping miss is logged, never thrown);
 *   - `__testing.reset()` (off the listener, clear the queue + guard).
 *
 * What each hook supplies via config:
 *   - `label`        — used in the failure / crash log lines.
 *   - `initLog`      — the full emoji-prefixed init console line.
 *   - `tagKey`       — the `job.params` key carrying the destination tag.
 *   - `identify(tag, job)` — validate the tag and return an identity object, or
 *                      null to ignore the job. Whatever it returns is the `ctx`
 *                      the callbacks below receive (plus `job`, `tag`, `filename`).
 *   - `serializeKey(ctx)`  — the per-record write-serialization key.
 *   - `sceneKey(ctx)`      — OPTIONAL; when present, enables the newest-wins
 *                      guard keyed on the returned scene-slot string.
 *   - `attach(ctx)`  — async; perform the durable attach, return its result
 *                      (or a falsy value to signal "nothing emitted").
 *   - `onAttached(ctx, result)` — emit the domain event + success log. Only
 *                      called when `attach` resolved to a non-null result that
 *                      was not dropped by the guard.
 *
 * The canceled→client-spinner bridge that #1791 also adds is intentionally NOT
 * here: every client spinner correlates by media-job id (`generationId`), not by
 * the per-domain scene identity, so it lives once at the socket layer
 * (`image-gen:canceled` / `video-gen:canceled` in socket.js) rather than as a
 * per-hook event. See that bridge for the rationale.
 */

import { mediaJobEvents } from './mediaJobQueue/index.js';
import { createKeyCachedQueue } from '../lib/createKeyCachedQueue.js';
import { createNewestWinsGuard } from '../lib/createNewestWinsGuard.js';

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
    // Optional: ctx → a short per-record routing string appended to the failure
    // log (e.g. `workId/sceneId`), so a "render didn't attach" line is traceable
    // to a specific record the way each hand-written hook's log used to be.
    describe = null,
    // The media-job kind this hook attaches. Defaults to 'image' (the three
    // scene-image hooks); the music-video i2v hook (#1760) passes 'video' to
    // ride this same scaffold for a different job kind.
    kind = 'image',
    // Pull the fields to merge into `ctx` off a completed job, or return null to
    // ignore it. The default surfaces the rendered image filename as
    // `ctx.filename` (string-required) — the shape the three image hooks consume.
    // The video hook overrides it to surface `ctx.videoHistoryId` (the clip's
    // history id) instead, so each hook's attach/onAttached reads its own field.
    extractResult = (job) => {
      const f = job.result?.filename;
      return (f && typeof f === 'string') ? { filename: f } : null;
    },
  } = config;

  const serialize = createKeyCachedQueue();
  const guard = createNewestWinsGuard();

  let completedHandler = null;

  // Decode the job into the hook's identity context, or null to ignore it, so
  // the kind/tag/result guards live in one place (the result fields are pulled
  // by the configurable `extractResult`).
  function decode(job) {
    if (!job || job.kind !== kind) return null;
    const tag = job.params?.[tagKey];
    if (!tag) return null;
    const identity = identify(tag, job);
    if (!identity) return null;
    const fields = extractResult(job);
    if (!fields) return null;
    // Normalize queuedAt once here so the guard below AND any consumer's attach
    // (e.g. catalog's portrait guard) read the same `ctx.queuedAt` instead of
    // re-deriving it.
    const queuedAt = typeof job.queuedAt === 'string' ? job.queuedAt : null;
    return { ...identity, job, tag, ...fields, queuedAt };
  }

  function init() {
    // Idempotent: a stray double-init (test reload, future refactor) would
    // otherwise register two listeners and double-file every completed image.
    if (completedHandler) return;

    completedHandler = (job) => {
      void (async () => {
        const ctx = decode(job);
        if (!ctx) return;
        const sKey = sceneKey ? sceneKey(ctx) : null;

        const result = await serialize(serializeKey(ctx), async () => {
          // Newest-render-wins: drop an out-of-order older render so it can't
          // clobber a newer frame on the same scene slot (returns null, the same
          // "nothing applied" signal as a declined/failed attach). Checked +
          // recorded inside the serialize section so the read/write never races.
          if (sKey && guard.isStale(sKey, ctx.queuedAt)) return null;
          const r = await attach(ctx);
          // Only record the slot's newest queuedAt once the attach actually
          // applied — a failed attach (null) must not advance the guard, or a
          // later legitimate render would be wrongly dropped as stale.
          if (sKey && r != null) guard.mark(sKey, ctx.queuedAt);
          return r;
        }).catch((err) => {
          const where = describe ? ` → ${describe(ctx)}` : '';
          // `ctx.filename` is the image lanes' attached value; the video lane has
          // no filename (it attaches a history id), so fall back to the routing
          // string from `describe` for a still-traceable line.
          console.log(`⚠️ ${label} hook failed for ${ctx.filename || 'render'}${where}: ${err?.message || String(err)}`);
          return null;
        });

        if (result != null) onAttached(ctx, result);
      })().catch((err) => {
        // Last-resort net for synchronous throws (unexpected job shape, etc).
        console.log(`⚠️ ${label} hook crashed: ${err?.message || err}`);
      });
    };

    mediaJobEvents.on('completed', completedHandler);
    console.log(initLog);
  }

  // Test-only reset so suites that re-init can do so cleanly. Removes the
  // previously registered listener so re-init doesn't leak handlers.
  const __testing = {
    reset: () => {
      if (completedHandler) {
        mediaJobEvents.off('completed', completedHandler);
        completedHandler = null;
      }
      serialize.clear();
      guard.clear();
    },
  };

  return { init, __testing };
}
