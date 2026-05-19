/**
 * Shared completion waiter for `imageGenEvents` — used wherever a route or
 * voice tool awaits a single image-gen job by `generationId`. Two contracts
 * the helper enforces: (1) listeners attach BEFORE `generateImage` returns
 * so a fast job can't emit `completed` first, and (2) listeners detach on
 * completion / failure / timeout so the global emitter doesn't accumulate
 * leaks. Always call `cleanup()` on the synchronous error path — `register`
 * may never run.
 *
 * Routes route both the timeout AND the failed-event payload through
 * caller-supplied factories so the rejection lands as a `ServerError` with
 * the right status/code; the voice tool keeps the raw `{ error }` envelope.
 *
 * Scoped to the `imageGenEvents` bus. The `mediaJobQueue` / `mediaJobEvents`
 * pattern in `universeCharacterSheet.js` uses a custom dispatcher to bound
 * listeners + a two-stage timeout — distinct enough that it stays separate.
 */
import { imageGenEvents } from './imageGenEvents.js';

export function createImageGenWaiter({
  timeoutMs = 5 * 60 * 1000,
  onTimeout = () => ({ error: 'image generation timed out' }),
  // Mapper applied to the raw `failed` event before the promise rejects.
  // Defaults to the event verbatim (legacy voice-tool shape); routes pass
  // a `(ev) => new ServerError(...)` for a typed rejection.
  onFailed = (ev) => ev,
} = {}) {
  // Sentinel — strict equality against a fresh symbol never matches anything
  // else, so a `completed` event with `generationId: null` (or omitted) that
  // fires BEFORE `register()` runs can't accidentally resolve the waiter.
  let registeredId = Symbol('unregistered');
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {});

  let onCompletedEvent;
  let onFailedEvent;
  let timer;
  const cleanup = () => {
    clearTimeout(timer);
    imageGenEvents.off('completed', onCompletedEvent);
    imageGenEvents.off('failed', onFailedEvent);
  };

  onCompletedEvent = (ev) => { if (ev?.generationId === registeredId) { cleanup(); resolve(ev); } };
  onFailedEvent = (ev) => { if (ev?.generationId === registeredId) { cleanup(); reject(onFailed(ev)); } };
  timer = setTimeout(() => { cleanup(); reject(onTimeout()); }, timeoutMs);

  imageGenEvents.on('completed', onCompletedEvent);
  imageGenEvents.on('failed', onFailedEvent);

  return {
    register: (id) => { registeredId = id; },
    promise,
    cleanup,
  };
}
