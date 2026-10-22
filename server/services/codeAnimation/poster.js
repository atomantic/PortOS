/**
 * Gallery poster frames for completed Code Animation jobs. The generated page
 * runs in the OS-jailed composition browser (never the user's browser), its
 * animation loop is stopped, and the canvas is read after one deterministic
 * `renderFrame(t)` call — so the poster holds only film pixels, never the
 * page's own controls overlay.
 */
import { randomUUID } from 'crypto';
import { rm } from 'fs/promises';
import { emitCodeAnimationChanged } from '../socket.js';
import { getCodeAnimationJobRecord, isCodeAnimationJobId, readCodeAnimationHtml, saveCodeAnimationPoster } from './jobStore.js';

const POSTER_WIDTH = 640;
const POSTER_TIMEOUT_MS = 45_000;
// Far enough in to be past a fade from black, early enough to precede an ending fade.
const POSTER_POSITION = 0.3;
const VIEWPORT = { width: 1280, height: 720 };

// One capture at a time: each launches a jailed browser.
let tail = Promise.resolve();
const inFlight = new Map();
// Ids whose capture failed in this process, so a gallery reload does not relaunch them.
const failed = new Set();
let isolationUnavailable = false;

export const posterCaptureScript = (fallbackDuration) => `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = Date.now() + 8000;
  while (typeof window.renderFrame !== 'function' && Date.now() < until) await sleep(100);
  if (typeof window.renderFrame !== 'function') await sleep(1500);
  window.requestAnimationFrame = () => 0;
  await sleep(50);
  const canvas = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!canvas || !canvas.width || !canvas.height) return null;
  const duration = Number(window.ANIMATION_META && window.ANIMATION_META.duration) || ${Number(fallbackDuration) || 0};
  if (typeof window.renderFrame === 'function') window.renderFrame(duration * ${POSTER_POSITION});
  const width = Math.min(${POSTER_WIDTH}, canvas.width);
  const height = Math.max(1, Math.round(canvas.height * width / canvas.width));
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(canvas, 0, 0, width, height);
  return out.toDataURL('image/jpeg', 0.82).split(',')[1] || null;
})()`;

async function capture(id) {
  const job = await getCodeAnimationJobRecord(id);
  if (job?.status !== 'completed') return false;
  const html = await readCodeAnimationHtml(id);
  const [{ stageCodeAnimationPage }, { openComposition }, { PREVIEW_PAGE_CSP }] = await Promise.all([
    import('../generatedPreview/codeAnimationPage.js'),
    import('../htmlComposition/browser.js'),
    import('../../lib/generatedPreviewSandbox.js'),
  ]);
  const staged = await stageCodeAnimationPage(`poster-${randomUUID()}`, html);
  let page;
  try {
    page = await openComposition(staged.directory, {
      signal: AbortSignal.timeout(POSTER_TIMEOUT_MS),
      ownedBrowser: true,
      isolation: 'required',
      streamMedia: true,
      contentSecurityPolicy: PREVIEW_PAGE_CSP,
      // A page error is reported, not fatal: most films still draw a usable frame.
      previewBridge: true,
      refuseUnknown: 'empty',
      lockLoopback: true,
      onEvent: () => {},
    });
    await page.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
    const data = await page.evaluate(posterCaptureScript(job.frame?.durationSeconds), 'poster capture');
    if (typeof data !== 'string' || !data) return false;
    await saveCodeAnimationPoster(id, Buffer.from(data, 'base64'));
    return true;
  } finally {
    await page?.close().catch((error) => console.error(`❌ Code animation poster browser close failed: ${error.message}`));
    await rm(staged.scratchRoot, { recursive: true, force: true }).catch((error) => {
      console.error(`❌ Code animation poster scratch cleanup failed: ${error.message}`);
    });
  }
}

/** Resolves once a capture in flight (or queued) for `id` has finished writing. */
export function settleCodeAnimationPoster(id) {
  return inFlight.get(id) || Promise.resolve(false);
}

/**
 * Capture a completed job's poster. Resolves true when a poster was written;
 * never rejects, because the completion path runs it detached.
 */
export function captureCodeAnimationPoster(id) {
  if (!isCodeAnimationJobId(id) || isolationUnavailable || failed.has(id)) return Promise.resolve(false);
  if (inFlight.has(id)) return inFlight.get(id);
  const run = tail.then(() => capture(id)).then((written) => {
    if (written) {
      console.log(`🖼️ Code animation ${id.slice(0, 8)} poster captured`);
      emitCodeAnimationChanged(id, 'poster');
    } else {
      failed.add(id);
    }
    return written;
  }).catch((error) => {
    if (error?.code === 'PREVIEW_ISOLATION_UNAVAILABLE') isolationUnavailable = true;
    failed.add(id);
    console.error(`❌ Code animation ${id.slice(0, 8)} poster capture failed: ${error?.message || error}`);
    return false;
  }).finally(() => inFlight.delete(id));
  inFlight.set(id, run);
  tail = run;
  return run;
}
