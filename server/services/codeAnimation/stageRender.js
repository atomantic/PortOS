/**
 * Real-browser and media-queue adapters for the Code Animation production
 * stages (#9389). Both run the staged, write-once copy of a revision inside the
 * HTML-composition renderer's sandbox (no network, disposable context); neither
 * calls a provider.
 */
import { createHash } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { openComposition } from '../htmlComposition/browser.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const SAMPLE_SCALE = 0.25;

// Down-sample the film canvas to 16x9 and report luma statistics. WebGL and
// other non-2d canvases cannot be read back reliably after the paint, so they
// report null (unverified) instead of a false "blank".
const MEASURE = `(() => {
  const film = [...document.querySelectorAll('canvas')].sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
  if (!film) return null;
  try {
    if (!film.getContext('2d')) return null;
    const probe = document.createElement('canvas');
    probe.width = 16; probe.height = 9;
    const context = probe.getContext('2d', { willReadFrequently: true });
    context.drawImage(film, 0, 0, 16, 9);
    const data = context.getImageData(0, 0, 16, 9).data;
    let sum = 0; let squares = 0;
    for (let i = 0; i < data.length; i += 4) {
      const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      sum += luma; squares += luma * luma;
    }
    const mean = sum / 144;
    return { mean, deviation: Math.sqrt(Math.max(0, squares / 144 - mean * mean)) };
  } catch { return null; }
})()`;

/**
 * Seek the staged film to each of `times` and measure it. `captureTimes` also
 * return a full-size PNG. Every sample's `renderHash` is taken from the same
 * down-scaled screenshot, so adjacent samples are comparable.
 */
export async function sampleFilm(directory, { times, captureTimes = [], signal }) {
  const page = await openComposition(directory, { signal });
  const samples = [];
  const frames = [];
  let contract;
  try {
    contract = await page.evaluate(`(() => {
      const c = globalThis.portosComposition;
      if (!c || typeof c.seek !== 'function') throw new Error('portosComposition.seek is required');
      return { durationSec: c.durationSec, fps: c.fps, width: c.width, height: c.height };
    })()`);
    const { width, height } = contract;
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    page.check();
    const capture = new Set(captureTimes);
    for (const t of [...new Set([...times, ...captureTimes])].sort((a, b) => a - b)) {
      page.check();
      try {
        await page.evaluate(`globalThis.portosComposition.seek(${t})`);
      } catch (error) {
        throw new ServerError(`The film failed at ${t}s: ${error.message}`, { status: 422, code: 'CODE_ANIMATION_FILM_FAILED' });
      }
      page.check();
      const small = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false,
        clip: { x: 0, y: 0, width, height, scale: SAMPLE_SCALE } });
      const measured = await page.evaluate(MEASURE);
      if (times.includes(t)) samples.push({ t, renderHash: sha256(Buffer.from(small.data, 'base64')), mean: measured?.mean ?? null, deviation: measured?.deviation ?? null });
      if (capture.has(t)) {
        const full = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
        frames.push({ t, bytes: Buffer.from(full.data, 'base64') });
      }
      page.check();
    }
    await page.close({ verify: true });
  } catch (error) {
    await page.close();
    throw error;
  }
  return { contract, samples, frames };
}

/**
 * Queue the final render on the shared media queue and wait for it. The queue
 * owns the work, so abort (cancel, time budget) cancels the queued/running job.
 */
export async function renderViaMediaQueue({ directory, signal }) {
  const { enqueueJob, cancelJob, mediaJobEvents } = await import('../mediaJobQueue/index.js');
  return new Promise((resolve, reject) => {
    let jobId = null;
    const finish = (fn, value) => {
      for (const [state, listener] of listeners) mediaJobEvents.off(state, listener);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const mine = job => job?.kind === 'html-composition' && job.params?.directory === directory;
    const listeners = ['completed', 'failed', 'canceled'].map(state => [state, job => {
      if (!mine(job)) return;
      if (state === 'completed') finish(resolve, { jobId: job.id, ...(job.result || {}) });
      else finish(reject, new ServerError(job.error || `The render ${state}`, { status: 502, code: 'CODE_ANIMATION_RENDER_FAILED' }));
    }]);
    const onAbort = () => {
      const reason = signal.reason;
      const cancel = jobId ? cancelJob(jobId).catch(() => {}) : Promise.resolve();
      cancel.finally(() => finish(reject, reason));
    };
    for (const [state, listener] of listeners) mediaJobEvents.on(state, listener);
    signal?.addEventListener('abort', onAbort, { once: true });
    enqueueJob({ kind: 'html-composition', params: { directory } }).then(
      queued => { jobId = queued.jobId; if (signal?.aborted) onAbort(); },
      error => finish(reject, error),
    );
  });
}
