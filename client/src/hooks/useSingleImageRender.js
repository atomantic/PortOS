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
 * @returns {{ jobId, renderingJobs, render, handleComplete }}
 *   - `jobId` — the single in-flight job's id (or null). Convenience for
 *     single-target callers; multi-target callers read `renderingJobs[key]`.
 *   - `renderingJobs` — `{ [key]: jobId }` for callers rendering several subjects.
 *   - `render(imageCfg, key)` — queue a render; returns the queued jobId or null.
 *   - `handleComplete(filename, key)` — clear the job + run the guarded onComplete.
 */
export default function useSingleImageRender({ buildPrompt, onComplete, onError } = {}) {
  // Keyed by an arbitrary caller key (a character id, or a stable sentinel for
  // single-target callers). Single-target callers also read `jobId`.
  const [renderingJobs, setRenderingJobs] = useState({});
  // Each (key, filename) persist runs at most once — the thumb's onFilename
  // effect can re-fire under StrictMode + unstable per-render onComplete arrows.
  const processedRef = useRef(new Set());

  const buildPromptRef = useRef(buildPrompt);
  buildPromptRef.current = buildPrompt;
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const render = useCallback(async (imageCfg, key = SINGLE_KEY) => {
    const built = buildPromptRef.current?.(key);
    if (!built) return null; // caller aborted (already toasted why)
    const baseOpts = pipelineImageCfgToRenderOpts(imageCfg);
    const queued = await generateImage(
      { ...baseOpts, prompt: built.prompt, negativePrompt: built.negativePrompt || undefined },
      { silent: true },
    ).catch((err) => { onErrorRef.current?.(err); return null; });
    if (!queued?.jobId) return null;
    setRenderingJobs((prev) => ({ ...prev, [key]: queued.jobId }));
    return queued.jobId;
  }, []);

  const handleComplete = useCallback(async (filename, key = SINGLE_KEY) => {
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

  return { jobId: renderingJobs[SINGLE_KEY] || null, renderingJobs, render, handleComplete };
}
