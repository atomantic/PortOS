/**
 * Off-main-thread synthesis for the drawn-waveform preview (#8470).
 * `createSketchSynthesizer()` → `{ synthesize(sketch, columns), dispose() }`:
 * `synthesize` resolves `{ channels, peaks }` from a module Web Worker
 * (`waveSketchSynthWorker.js`), with the channel buffers transferred rather
 * than copied.
 *
 * Latest request wins: starting a new render while one is in flight
 * terminates that worker (a render can't be interrupted any other way) and
 * resolves the superseded promise to `null`, so a quick run of track or
 * painting changes never queues seconds of dead synthesis. Where workers are
 * unavailable, or the worker fails to load, it renders on the main thread
 * instead, on a later task so the caller's UI can paint first.
 */

import { renderSketchPreview } from './waveSketchSynthWorker.js';

const spawnWorker = () => (typeof Worker === 'function'
  ? new Worker(new URL('./waveSketchSynthWorker.js', import.meta.url), { type: 'module' })
  : null);

const renderLater = (sketch, columns) => new Promise((resolve, reject) => {
  setTimeout(() => {
    try { resolve(renderSketchPreview(sketch, columns)); } catch (err) { reject(err); }
  }, 0);
});

export function createSketchSynthesizer({ createWorker = spawnWorker } = {}) {
  let worker = null;
  let workerFailed = false;
  let nextId = 0;
  let pending = null; // { id, sketch, columns, resolve, reject }

  const teardown = () => {
    worker?.terminate();
    worker = null;
  };

  const settleStale = () => {
    if (!pending) return;
    pending.resolve(null);
    pending = null;
    // The worker is still grinding on the stale render; drop it.
    teardown();
  };

  const fallBack = () => {
    workerFailed = true;
    teardown();
    if (!pending) return;
    const { sketch, columns, resolve, reject } = pending;
    pending = null;
    renderLater(sketch, columns).then(resolve, reject);
  };

  const ensureWorker = () => {
    if (worker || workerFailed) return worker;
    try {
      worker = createWorker();
    } catch (err) {
      console.warn(`〰️ Waveform preview worker unavailable, rendering on the main thread: ${err.message}`);
      worker = null;
    }
    if (!worker) { workerFailed = true; return null; }
    worker.onmessage = ({ data }) => {
      if (!pending || data?.id !== pending.id) return;
      const { resolve, reject } = pending;
      pending = null;
      if (data.error) reject(new Error(data.error));
      else resolve({ channels: data.channels, peaks: data.peaks });
    };
    worker.onerror = (event) => {
      event?.preventDefault?.();
      console.warn(`〰️ Waveform preview worker failed, rendering on the main thread: ${event?.message || 'load error'}`);
      fallBack();
    };
    return worker;
  };

  const synthesize = (sketch, columns) => {
    settleStale();
    const active = ensureWorker();
    if (!active) return renderLater(sketch, columns);
    nextId += 1;
    const id = nextId;
    return new Promise((resolve, reject) => {
      pending = { id, sketch, columns, resolve, reject };
      active.postMessage({ id, sketch, columns });
    });
  };

  const dispose = () => {
    settleStale();
    teardown();
  };

  return { synthesize, dispose };
}
