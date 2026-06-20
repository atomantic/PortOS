import { useState, useRef, useCallback } from 'react';
import { generateImage } from '../services/api';
import { pipelineImageCfgToRenderOpts } from '../lib/pipelineImageDefaults';

// Stable key for single-target callers (the base-style probe) so `jobId` and
// the dedupe set don't need a caller-supplied key.
const SINGLE_KEY = '__single__';

/**
 * Drive the queue-one-render / wait-for-completion lifecycle shared by the
 * single-image render slots (the Story Builder characters step, the universe
 * base-style probe). It owns the small, error-prone boilerplate both sites
 * re-implement:
 *
 *   1. build render opts from the resolved `imageCfg`,
 *   2. call `buildPrompt()` to get `{ prompt, negativePrompt }` (or `null` to
 *      abort without rendering — the caller already toasted why),
 *   3. POST `generateImage`, surfacing the queued `jobId` so an `EntryThumbSlot`
 *      / `MediaJobThumb` can show the diffusion spinner,
 *   4. on completion, run a once-per-`(key, filename)` multi-fire guard (the
 *      thumb's onFilename effect can fire more than once under StrictMode) and
 *      hand the filename to `onComplete` for persistence.
 *
 * Completion subscription itself lives in the thumb component, so this hook only
 * tracks the `jobId` head and the dedupe set — it never opens its own SSE.
 *
 * `onComplete(filename, key)` is invoked exactly once per completed filename; it
 * owns persisting the ref (and may be async). `buildPrompt(key)` receives the
 * same key passed to `render`, so multi-target callers (one render per
 * character) can compose a subject-specific prompt.
 *
 * @param {Object}   opts
 * @param {Function} opts.buildPrompt — `(key) => ({ prompt, negativePrompt }) | null`
 * @param {Function} opts.onComplete  — `(filename, key) => void | Promise<void>`
 * @param {Function} [opts.onError]   — `(err) => void` for a failed queue POST.
 *   Defaults to a no-op; the POST is sent `{ silent: true }` so the caller owns UI.
 * @param {string}   [opts.scopeId]   — namespaces the single-target key per scope.
 *   Single-target callers that show one of several entities in the same mounted
 *   hook (the universe base-style probe, one universe at a time) pass the entity
 *   id here so the default `jobId`/completion are read relative to the displayed
 *   entity as `<scopeId>:__single__` — switching scope and back resumes a still
 *   in-flight (or already-finished) job instead of abandoning it on a remount.
 *   Omit it for a truly single render. Multi-target callers (explicit keys) are
 *   unaffected.
 * @returns {{ jobId, renderingJobs, render, handleComplete }}
 *   - `jobId` — the single in-flight job's id (or null). Convenience for
 *     single-target callers; multi-target callers read `renderingJobs[key]`.
 *   - `renderingJobs` — `{ [key]: jobId }` for callers rendering several subjects.
 *   - `render(imageCfg, key, extraParams)` — queue a render; returns the queued
 *     jobId or null. `extraParams` is merged into the generate payload (e.g. a
 *     `universeRun` collection target the server routes the finished render to).
 *   - `handleComplete(filename, key)` — clear the job + run the guarded onComplete.
 */
export default function useSingleImageRender({ buildPrompt, onComplete, onError, scopeId } = {}) {
  // Keyed by an arbitrary caller key (a character id, or a stable sentinel for
  // single-target callers). Single-target callers also read `jobId`.
  const [renderingJobs, setRenderingJobs] = useState({});
  // Each (key, filename) persist runs at most once — the thumb's onFilename
  // effect can re-fire under StrictMode + unstable per-render onComplete arrows.
  const processedRef = useRef(new Set());

  // The default key for single-target callers. With `scopeId` it is namespaced
  // per scope so a single mounted hook can track one in-flight render per
  // displayed entity (no remount to reset state). Recomputed each render so
  // `jobId` re-reads the displayed scope; held in a ref so the `render` /
  // `handleComplete` callbacks stay identity-stable.
  const effectiveSingleKey = scopeId == null || scopeId === '' ? SINGLE_KEY : `${scopeId}:${SINGLE_KEY}`;
  const singleKeyRef = useRef(effectiveSingleKey);
  singleKeyRef.current = effectiveSingleKey;

  const buildPromptRef = useRef(buildPrompt);
  buildPromptRef.current = buildPrompt;
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const render = useCallback(async (imageCfg, key = singleKeyRef.current, extraParams = undefined) => {
    const built = buildPromptRef.current?.(key);
    if (!built) return null; // caller aborted (already toasted why)
    const baseOpts = pipelineImageCfgToRenderOpts(imageCfg);
    // `extraParams` lets a caller attach extra fields to the generate payload
    // (e.g. the base-style probe's `universeRun` collection target) so the
    // server can route the finished render — the front-end does no
    // post-generation bookkeeping of its own.
    const queued = await generateImage(
      { ...baseOpts, prompt: built.prompt, negativePrompt: built.negativePrompt || undefined, ...(extraParams || {}) },
      { silent: true },
    ).catch((err) => { onErrorRef.current?.(err); return null; });
    if (!queued?.jobId) return null;
    setRenderingJobs((prev) => ({ ...prev, [key]: queued.jobId }));
    return queued.jobId;
  }, []);

  const handleComplete = useCallback(async (filename, key = singleKeyRef.current) => {
    setRenderingJobs((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    if (!filename) return;
    const guardKey = `${key}:${filename}`;
    if (processedRef.current.has(guardKey)) return; // multi-fire guard
    processedRef.current.add(guardKey);
    await onCompleteRef.current?.(filename, key);
  }, []);

  return { jobId: renderingJobs[effectiveSingleKey] || null, renderingJobs, render, handleComplete };
}
