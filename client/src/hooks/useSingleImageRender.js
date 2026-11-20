/**
 * Queue-one-image-render hook: builds options, POSTs generation, tracks the jobId and runs a
 * once-per-key completion guard before `onComplete`.
 *
 * Drives the queue-one-render / wait-for-completion jobId lifecycle for single-image render slots (`EntryThumbSlot`/`MediaJobThumb`: style probe, characters step). Completion SSE stays in the thumb.
 */

import { useState, useRef, useCallback } from 'react';
import { generateImage } from '../services/apiSystem.js';
import { pipelineImageCfgToRenderOpts } from '../lib/pipelineImageDefaults';

// Stable key for single-target callers (the base-style probe) so `jobId` and
// the dedupe set don't need a caller-supplied key.
const SINGLE_KEY = '__single__';

/**
 * Drive the queue-one-render / wait-for-completion lifecycle shared by the single-image render slots (Story Builder characters step, universe base-style probe): build render opts from the resolved
 * `imageCfg`, call `buildPrompt()` for `{ prompt, negativePrompt }` (or `null` to abort; the caller already toasted why), POST `generateImage` surfacing the queued `jobId`, and on completion run a
 * once-per-`(key, filename)` guard (the thumb's onFilename effect can fire more than once under StrictMode) before handing the filename to `onComplete`. The completion subscription lives in the thumb;
 * this hook never opens its own SSE.
 *
 * `onComplete(filename, key)` runs exactly once per completed filename and owns persisting the ref (may be async). `buildPrompt(key)` gets the key passed to `render`, so multi-target callers can compose per-subject prompts.
 * @param {Object}   opts
 * @param {Function} opts.buildPrompt — `(key) => ({ prompt, negativePrompt }) | null`
 * @param {Function} opts.onComplete  — `(filename, key) => void | Promise<void>`
 * @param {Function} [opts.onError]   — `(err) => void` for a failed queue POST.
 *   Defaults to a no-op; the POST is sent `{ silent: true }` so the caller owns UI.
 * @param {string}   [opts.scopeId]   — namespaces the single-target key per scope.
 *   Single-target callers showing one of several entities in the same mounted hook (the universe base-style probe) pass the entity id so `jobId`/completion are read as `<scopeId>:__single__`:
 *   switching scope and back resumes an in-flight (or finished) job. Omit for a truly single render; explicit-key callers are unaffected.
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

  // The default key for single-target callers, namespaced by `scopeId` so one mounted hook tracks one in-flight render per displayed entity. Recomputed each render so `jobId` re-reads the scope;
  // held in a ref so `render`/`handleComplete` stay identity-stable.
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
    const baseOpts = pipelineImageCfgToRenderOpts(imageCfg, extraParams);
    // `extraParams` attaches extra fields to the generate payload (e.g. `universeRun`) so the server routes the finished render; the front-end does no post-generation bookkeeping.
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
