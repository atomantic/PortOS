/**
 * Film-look finishing pass for footage renders.
 *
 * A composed or plain-cut music video is an ffmpeg encode, so the project's
 * film look (lib/filmLook.js) cannot be installed in a page the way a
 * composition-document render installs it (documentRenderInitScripts). This
 * pass gives those encoders the identical filter after the fact: the finished
 * MP4 plays full-frame in a one-video page in the composition browser, the
 * shared encoder seeks and captures it frame by frame (split across browsers
 * like a document render), and the render's own audio is copied back
 * untouched. Paid clips are never regenerated to change the feel, and the
 * grain, weave and flicker land on the same song frames the preview shows.
 * Chrome draws that filter on the CPU (seconds a frame), so the pass first
 * checks a frame of the WebGL2 port (lib/filmLookGpu.js) against it and uses
 * the GPU only when the two match and the GPU is faster.
 */

import { copyFile, link, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from '../../lib/paths.js';
import { ServerError } from '../../lib/errorHandler.js';
import { filmLookRuntimeSource, isFilmLookNeutral, normalizeFilmLook } from '../../lib/filmLook.js';
import { filmLookGpuRuntimeSource } from '../../lib/filmLookGpu.js';

export const FILM_LOOK_FINISH_SCRATCH_DIR = 'music-video-film-look';

/** Whether a footage render of `project` gets the finishing pass. */
export const filmLookFinishNeeded = (project) => !isFilmLookNeutral(project?.filmLook);

/**
 * The page the pass captures: the finished render full-frame, `seek(t)` on
 * song time (frame n of a window starting at `offsetSec` is drawn at song time
 * `offsetSec + n / fps`, which is render time `n / fps`). Pure.
 *
 * The look is drawn by the SVG filter the runtime init script installs, until
 * `__portosFilmLookFinish.useGpu(true)` hands it to the WebGL2 renderer
 * (lib/filmLookGpu.js): the SVG filter comes off, a canvas over the video
 * shows the same picture, and every seek redraws it for its song frame before
 * resolving.
 */
function filmLookFinishPage({ width, height, fps, durationSec, offsetSec = 0, look, src = 'media/source.mp4' }) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Film look</title>
<style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#000}video{display:block;width:${width}px;height:${height}px;object-fit:fill}#film{display:none;position:fixed;left:0;top:0;width:${width}px;height:${height}px;z-index:1}</style>
</head><body><video id="source" src="${src}" muted playsinline preload="auto"></video><canvas id="film" width="${width}" height="${height}"></canvas><script src="film-gpu.js"></script><script src="app.js"></script></body></html>\n`;
  // Seeks target the middle of a source frame so a frame boundary can never
  // round to the previous frame, and resolve on 'seeked' AND a presented frame
  // (a grace period stands in where the browser never presents), the way the
  // shipped document engine seeks its takes.
  const js = `(() => {
  const FPS = ${fps}, DURATION = ${durationSec}, OFFSET = ${offsetSec}, WIDTH = ${width}, HEIGHT = ${height};
  const FRAME_GRACE_MS = 1000;
  // A loaded host can take many seconds to decode the first frame; kept under
  // the browser's 30 s command deadline so the stall is named, then retried.
  const SEEK_TIMEOUT_MS = 25000;
  const video = document.getElementById('source');
  const loaded = new Promise((resolve, reject) => {
    if (video.readyState >= 2) { resolve(); return; }
    video.addEventListener('loadeddata', resolve, { once: true });
    video.addEventListener('error', () => reject(new Error('the render failed to load (' + (video.error && video.error.code || '?') + ')')), { once: true });
  });
  function seekVideo(target) {
    if (Math.abs(video.currentTime - target) < 1e-6 && video.readyState >= 2 && !video.seeking) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let seeked = false;
      let presented = typeof video.requestVideoFrameCallback !== 'function';
      let grace = null;
      let settled = false;
      const timer = setTimeout(() => { cleanup(); reject(new Error('render seek timed out @ ' + target.toFixed(3) + 's')); }, SEEK_TIMEOUT_MS);
      const finish = () => { if (seeked && presented) { cleanup(); resolve(); } };
      const onSeeked = () => {
        seeked = true;
        if (!presented) grace = setTimeout(() => { presented = true; finish(); }, FRAME_GRACE_MS);
        finish();
      };
      const fail = () => { cleanup(); reject(new Error('render seek failed (' + (video.error && video.error.code || '?') + ')')); };
      function cleanup() { settled = true; clearTimeout(timer); clearTimeout(grace); video.removeEventListener('seeked', onSeeked); video.removeEventListener('error', fail); }
      video.addEventListener('seeked', onSeeked);
      video.addEventListener('error', fail);
      const armPresented = () => video.requestVideoFrameCallback((_now, meta) => {
        if (Number.isFinite(meta && meta.mediaTime) && Math.abs(meta.mediaTime - target) > 1 / FPS) { if (!settled) armPresented(); return; }
        presented = true; finish();
      });
      if (!presented) armPresented();
      video.currentTime = target;
    });
  }
  // The GPU renderer, once switched on. The song frame is the one the SVG
  // runtime derives from the same seek: round(t × fps).
  const LOOK = ${JSON.stringify(look ?? null)};
  const canvas = document.getElementById('film');
  let gpu = null;
  const filmLook = () => globalThis.__portosFilmLook;
  globalThis.__portosFilmLookFinish = {
    gpuInfo() {
      const api = globalThis.__portosFilmLookGpu;
      return { available: Boolean(api && api.available()) };
    },
    useGpu(on) {
      if (on) {
        try {
          gpu = gpu || globalThis.__portosFilmLookGpu.create(canvas);
        } catch (error) {
          gpu = null;
          return { on: false, error: String(error && error.message || error).slice(0, 300) };
        }
        canvas.style.display = 'block';
        if (filmLook()) filmLook().apply(null);
        return { on: true, renderer: gpu.renderer };
      }
      canvas.style.display = 'none';
      if (gpu) { gpu.dispose(); gpu = null; }
      if (filmLook()) filmLook().apply(LOOK);
      return { on: false };
    },
  };
  globalThis.portosComposition = {
    durationSec: DURATION, fps: FPS, width: WIDTH, height: HEIGHT,
    async seek(t) {
      await loaded;
      const local = Math.max(0, t - OFFSET);
      const target = Math.min((Math.floor(local * FPS + 1e-6) + 0.5) / FPS, Math.max(0, video.duration - 1e-3));
      await seekVideo(target);
      if (gpu) gpu.render(video, LOOK, { frame: Math.max(0, Math.round((Number(t) || 0) * FPS)), width: WIDTH, height: HEIGHT });
    },
  };
})();
`;
  return { 'index.html': html, 'app.js': js, 'film-gpu.js': filmLookGpuRuntimeSource() };
}

// Full-resolution PSNR (dB) of two same-sized PNG frames, RGB only.
async function framePsnr(a, b) {
  const sharp = (await import('sharp')).default;
  const [x, y] = await Promise.all([a, b].map((png) => sharp(png).removeAlpha().raw().toBuffer()));
  if (x.length !== y.length) return 0;
  let sum = 0;
  for (let i = 0; i < x.length; i++) { const d = x[i] - y[i]; sum += d * d; }
  return sum === 0 ? 99 : 10 * Math.log10((255 * 255 * x.length) / sum);
}

// The GPU must draw the picture the SVG filter draws before a render trusts it.
const FILM_LOOK_GPU_MIN_PSNR = 40;
const CHECK_SCREENSHOT = Object.freeze({ format: 'png', optimizeForSpeed: true, fromSurface: true, captureBeyondViewport: false });

/**
 * Decide, on the opened page, whether this pass draws its look on the GPU: only
 * when WebGL2 is there, a frame drawn both ways matches within
 * FILM_LOOK_GPU_MIN_PSNR, and the GPU frame is the cheaper one (a host whose
 * WebGL is a software rasterizer can be slower than Chrome's own filter).
 * Leaves the page on the chosen path; any failure keeps the SVG filter.
 * Resolves `{ gpu, reason, psnr?, svgMs?, gpuMs?, renderer? }`.
 */
async function chooseFilmLookPath(page, { width, height, fps, frames, offsetSec = 0 }) {
  const svg = async () => page.evaluate('globalThis.__portosFilmLookFinish.useGpu(false)').catch(() => {});
  try {
    const info = await page.evaluate('globalThis.__portosFilmLookFinish.gpuInfo()');
    if (!info?.available) return { gpu: false, reason: 'WebGL2 is unavailable' };
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const frame = Math.floor(frames / 2);
    const at = (n) => offsetSec + n / fps;
    // The seek pays for the GPU draw and the capture for the SVG filter: time both.
    const timed = async (n) => {
      const started = performance.now();
      await page.evaluate(`globalThis.portosComposition.seek(${at(n)})`);
      const { data } = await page.send('Page.captureScreenshot', CHECK_SCREENSHOT);
      return { png: Buffer.from(data, 'base64'), ms: performance.now() - started };
    };
    const reference = await timed(frame);
    const switched = await page.evaluate('globalThis.__portosFilmLookFinish.useGpu(true)');
    if (!switched?.on) { await svg(); return { gpu: false, reason: `the GPU renderer failed to start (${switched?.error || 'unknown'})` }; }
    const drawn = await timed(frame);
    const psnr = await framePsnr(reference.png, drawn.png);
    // A second frame, past shader compilation, is what the render will pay.
    const next = await timed(Math.min(frames - 1, frame + 1));
    const result = { psnr: Math.round(psnr * 10) / 10, svgMs: Math.round(reference.ms), gpuMs: Math.round(next.ms), renderer: switched.renderer };
    if (psnr < FILM_LOOK_GPU_MIN_PSNR) { await svg(); return { gpu: false, reason: `the GPU frame differs from the SVG filter (${result.psnr} dB)`, ...result }; }
    if (next.ms >= reference.ms) { await svg(); return { gpu: false, reason: `the GPU frame is not faster (${result.gpuMs} ms vs ${result.svgMs} ms)`, ...result }; }
    return { gpu: true, reason: 'matches the SVG filter', ...result };
  } catch (error) {
    await svg();
    return { gpu: false, reason: `the GPU check failed (${String(error?.message || error).slice(0, 200)})` };
  }
}

/**
 * Re-encode the finished render at `path` through the project's film look, in
 * place. Resolves `true` when the pass ran, `false` when the look is neutral
 * (the file is untouched). `look` (a shot's own look) replaces the project's;
 * `workers` caps the browsers a short window splits across. `offsetSec` is the
 * song time of the render's first frame (an excerpt's window or a shot's start)
 * so the grain lands on song frames. The look is drawn on the GPU when
 * `chooseFilmLookPath` finds that safe and faster (`useGpu: false` forces the
 * SVG filter), else by Chrome's SVG filter as the preview draws it.
 * Rejects on failure or when `signal` aborts, leaving `path` as it was.
 */
export async function applyFilmLookFinish({ project, look: lookInput, path, jobId, signal, onProgress, offsetSec = 0, workers, useGpu, label = 'Music-video film look' }) {
  const look = normalizeFilmLook(lookInput === undefined ? project?.filmLook : lookInput);
  if (!look || isFilmLookNeutral(look)) return false;
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(jobId)) throw new Error('Invalid film look job id');
  const { findFfmpeg, runFfmpegProcess, probeVideoGeometry } = await import('../../lib/ffmpeg.js');
  const { openComposition } = await import('../htmlComposition/browser.js');
  const { encodeComposition, encodeCompositionSegments } = await import('../htmlComposition/encode.js');
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new ServerError('ffmpeg not found on PATH', { status: 500, code: 'FFMPEG_MISSING' });
  const geometry = await probeVideoGeometry(path);
  if (!geometry) throw new ServerError('The rendered video could not be measured for its film look pass', { status: 500, code: 'FILM_LOOK_FINISH_PROBE' });
  const { width, height, fps } = geometry;
  const frames = Math.max(1, geometry.numFrames || Math.round(geometry.durationSec * fps));
  const durationSec = frames / fps;
  const directory = `${FILM_LOOK_FINISH_SCRATCH_DIR}/${jobId}`;
  const scratch = join(PATHS.data, directory);
  const silent = `${path}.look.silent.mp4`;
  const finished = `${path}.look.mp4`;
  let page;
  try {
    await rm(scratch, { recursive: true, force: true });
    await mkdir(join(scratch, 'media'), { recursive: true });
    // The finished render is large: a hard link stages it without a copy on
    // the same volume (the browser refuses symlinks); a copy stands in elsewhere.
    const source = join(scratch, 'media', 'source.mp4');
    await link(path, source).catch(() => copyFile(path, source));
    for (const [name, body] of Object.entries(filmLookFinishPage({ width, height, fps, durationSec, offsetSec, look }))) {
      await writeFile(join(scratch, name), body);
    }
    signal?.throwIfAborted();
    const openSvgPage = (pageSignal) => openComposition(directory, { signal: pageSignal, streamMedia: true, ownedBrowser: true, initScripts: [filmLookRuntimeSource(look)] });
    page = await openSvgPage(signal);
    const h264 = await page.evaluate(`document.createElement('video').canPlayType('video/mp4; codecs="avc1.640028"')`);
    if (!h264) {
      throw new ServerError('The managed browser cannot decode H.264 video (a Chromium build without proprietary codecs) — point Settings › Browser at Google Chrome', {
        status: 422, code: 'COMPOSITION_BROWSER_CODEC',
      });
    }
    const drawPath = useGpu === false ? { gpu: false, reason: 'turned off' } : await chooseFilmLookPath(page, { width, height, fps, frames, offsetSec });
    signal?.throwIfAborted();
    // A check that broke its page (never expected) costs only a fresh page.
    try { page.check(); } catch {
      await page.close().catch(() => {});
      page = await openSvgPage(signal);
    }
    console.log(`🎞️ ${label} [${jobId.slice(0, 8)}]: ${drawPath.gpu ? 'GPU' : 'SVG'} film look — ${drawPath.reason}${drawPath.psnr == null ? '' : ` (check frame ${drawPath.psnr} dB, ${drawPath.gpuMs} ms GPU vs ${drawPath.svgMs} ms SVG${drawPath.renderer ? `, ${drawPath.renderer}` : ''})`}`);
    // Worker browsers take the same path; one whose GPU will not start keeps the SVG filter.
    const openPage = drawPath.gpu
      ? async (pageSignal) => {
        const opened = await openSvgPage(pageSignal);
        const switched = await opened.evaluate('globalThis.__portosFilmLookFinish.useGpu(true)').catch((error) => ({ on: false, error: error.message }));
        if (!switched?.on) console.warn(`⚠️ ${label} [${jobId.slice(0, 8)}]: a worker browser kept the SVG film look (${switched?.error || 'GPU unavailable'})`);
        return opened;
      }
      : openSvgPage;
    const encoded = await encodeCompositionSegments(page, { width, height, fps, durationSec }, silent, {
      openPage, encode: encodeComposition, signal, offsetSec, ...(workers ? { workers } : {}),
      onProgress: (fraction) => onProgress?.(fraction * 0.95),
      onRetry: ({ frame, attempt, segment, error }) => console.warn(`⚠️ ${label} [${jobId.slice(0, 8)}] ${segment == null ? '' : `worker ${segment + 1} `}restarting its browser at song frame ${frame} (retry ${attempt}): ${error.message}`),
    });
    // A replaced first page was already closed after its failure.
    if (!encoded?.pageReplaced) {
      page.check();
      await page.close({ verify: true });
    }
    page = null;
    signal?.throwIfAborted();
    // The pass changes pixels only: the render's audio (master, sound bed, an
    // excerpt's trim) is copied back untouched.
    const mux = await runFfmpegProcess({
      bin: ffmpeg, signal,
      args: ['-hide_banner', '-loglevel', 'error', '-i', silent, '-i', path, '-map', '0:v:0', '-map', '1:a?', '-c', 'copy', '-movflags', '+faststart', '-y', finished],
    });
    if (!mux.ok) {
      signal?.throwIfAborted();
      throw new ServerError(`Film look mux failed: ${mux.reason}`, { status: 500, code: 'FILM_LOOK_FINISH_MUX' });
    }
    await rename(finished, path);
    onProgress?.(1);
    console.log(`🎞️ ${label} [${jobId.slice(0, 8)}]: ${look.preset} over ${frames} frames at ${width}×${height}`);
    return true;
  } finally {
    if (page) await page.close().catch(() => {});
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    await rm(silent, { force: true }).catch(() => {});
    await rm(finished, { force: true }).catch(() => {});
  }
}
