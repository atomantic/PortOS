/**
 * Music Video — typography overlay capture (#8984, part of #8966).
 *
 * Renders a composed project's timed text cues into transparent overlay clips
 * that render.js lays over the concatenated footage. The page is the sandboxed
 * HTML composition from composition.js, opened in an owned headless browser
 * (htmlComposition/browser.js: frozen assets, no network, CSP sandbox). A
 * headed managed browser would hide the target, and a hidden target never
 * paints: the title card's font load and the page's animation frames then
 * wait until the browser gives up. Only the time ranges that carry text are
 * captured — one clip per `overlayWindows` range, each encoded with an alpha
 * channel (QuickTime RLE) — so a mostly-instrumental song costs a handful of
 * frames, not the whole song.
 *
 * All output lives in one per-job scratch directory under data/ (the
 * composition browser only opens directories inside data); the caller removes
 * it once the final render finishes, and boot recovery sweeps any a crash left.
 */

import { dirname, join } from 'path';
import { copyFile, mkdir, rm, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { spawn } from '../../lib/childProcess.js';
import { PATHS } from '../../lib/fileUtils.js';
import { findFfmpeg } from '../../lib/ffmpeg.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { buildTypographyDocument, LYRIC_FONT_FILE, TITLE_CARD_MONO_FONT_FILE, overlayWindows } from './composition.js';

const sharedFont = (file) => fileURLToPath(new URL(`./documentTemplates/shared/fonts/${file}`, import.meta.url));
const LYRIC_FONT_SOURCE = sharedFont(LYRIC_FONT_FILE);

export const COMPOSITION_SCRATCH_DIR = 'music-video-compositions';

// One seek, screenshot, or encode step. A healthy frame is far under this.
// A page that never paints used to sit until the browser's own resource
// timeout (minutes), after which the encoder was killed and the shot still
// looked unrendered. PORTOS_MUSIC_VIDEO_OVERLAY_FRAME_TIMEOUT_MS overrides it.
const DEFAULT_OVERLAY_FRAME_TIMEOUT_MS = 20_000;

function overlayFrameTimeoutMs(override = process.env.PORTOS_MUSIC_VIDEO_OVERLAY_FRAME_TIMEOUT_MS) {
  const forced = Number(override);
  return Number.isFinite(forced) && forced > 0 ? forced : DEFAULT_OVERLAY_FRAME_TIMEOUT_MS;
}

const scratchPath = (jobId) => join(PATHS.data, COMPOSITION_SCRATCH_DIR, jobId);

const overlayOutputTail = (stderr) => stderr.replace(/\s+/g, ' ').trim() || '(none)';

// Bounds one capture step. On expiry, abort the overlay's own signal (not the
// caller's: a shot or excerpt treats its signal aborting as a cancel) and fail
// the step with OVERLAY_TIMEOUT so the shot is recorded failed.
async function runOverlayStep(work, { ms, sceneId, tail, abort }) {
  let timer;
  let settled = false;
  // Resolve, don't reject: the in-flight step can lose the race and still
  // reject, and a rejected timer no one is awaiting would be unhandled.
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      settled = true;
      const error = new Error(`Music-video overlay timed out after ${ms}ms for scene ${sceneId || 'unknown'}; last output: ${overlayOutputTail(tail())}`);
      error.code = 'OVERLAY_TIMEOUT';
      console.error(`❌ ${error.message}`);
      abort?.(error);
      resolve({ ok: false, error });
    }, ms);
    timer.unref?.();
  });
  // The loser must not surface later as an unhandled rejection: aborting the
  // page rejects the in-flight browser command after this race has moved on.
  const guarded = Promise.resolve().then(work).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  try {
    const winner = await Promise.race([guarded, timeout]);
    if (!winner.ok) throw winner.error;
    return winner.value;
  } finally {
    if (!settled) clearTimeout(timer);
  }
}

/** Remove one job's scratch directory (best-effort). */
export const removeCompositionScratch = async (jobId) => rm(scratchPath(jobId), { recursive: true, force: true });

/** Boot sweep: no render survives a restart, so every scratch directory is stale. */
export const sweepCompositionScratch = async () => rm(join(PATHS.data, COMPOSITION_SCRATCH_DIR), { recursive: true, force: true });

// Capture frames [0, frames) of one window, seeking the page to the window's
// absolute song time for each, into an alpha-preserving QuickTime RLE clip.
async function captureWindow(page, ffmpeg, { startSec, frames, fps, outputPath, signal, abort, sceneId, onFrame }) {
  if (!Number.isInteger(frames) || frames <= 0 || !Number.isFinite(startSec) || !Number.isFinite(fps) || fps <= 0) {
    throw new Error(`Music-video overlay has no frames to capture for scene ${sceneId || 'unknown'}`);
  }
  const proc = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps),
    '-vcodec', 'png', '-i', 'pipe:0', '-c:v', 'qtrle', '-pix_fmt', 'argb', '-frames:v', String(frames), '-y', outputPath],
  safeChildProcessOptions({ stdio: ['pipe', 'ignore', 'pipe'] }));
  let stderr = '';
  let exited = false;
  proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-2000); });
  const finished = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.stdin.on('error', reject);
    proc.once('close', (code) => { exited = true; code === 0 ? resolve() : reject(new Error(`overlay encode failed (${code}): ${stderr}`)); });
  });
  finished.catch(() => {});
  const step = (work) => runOverlayStep(work, { ms: overlayFrameTimeoutMs(), sceneId, tail: () => stderr, abort });
  try {
    for (let n = 0; n < frames; n++) {
      page.check();
      await step(() => page.evaluate(`globalThis.portosComposition.seek(${startSec + n / fps})`));
      page.check();
      const shot = await step(() => page.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, fromSurface: true, captureBeyondViewport: false }));
      signal?.throwIfAborted();
      await step(() => Promise.race([
        new Promise((resolve, reject) => proc.stdin.write(Buffer.from(shot.data, 'base64'), (error) => (error ? reject(error) : resolve()))),
        finished.then(() => { throw new Error('ffmpeg exited before the overlay was complete'); }),
      ]));
      onFrame?.();
    }
    proc.stdin.end();
    await step(() => finished);
  } finally {
    if (!exited) {
      killWithEscalation(proc, { label: 'music-video overlay', stillRunning: () => !exited, delayMs: 1000 });
      await new Promise((resolve) => proc.once('close', resolve));
    }
  }
}

export function musicVideoSongDocument(project) {
  const analysis = project?.audioAnalysis && typeof project.audioAnalysis === 'object' && !Array.isArray(project.audioAnalysis)
    ? project.audioAnalysis : {};
  let words = null;
  if (Array.isArray(project?.lyricCues)) {
    const collected = [];
    for (const cue of project.lyricCues) {
      if (!Array.isArray(cue?.words)) continue;
      words = collected;
      for (const word of cue.words) {
        if (!word || typeof word !== 'object') continue;
        collected.push({
          w: typeof word.w === 'string' ? word.w : '',
          startSec: Number.isFinite(word.startSec) ? word.startSec : null,
          endSec: Number.isFinite(word.endSec) ? word.endSec : null,
          conf: word.conf === 'matched' || word.conf === 'interpolated' ? word.conf : null,
        });
      }
    }
  }
  const features = analysis.features;
  return {
    beats: Array.isArray(analysis.beats) ? analysis.beats : [],
    downbeats: Array.isArray(analysis.downbeats) ? analysis.downbeats : [],
    sections: Array.isArray(analysis.sections) ? analysis.sections : [],
    features: features !== null && typeof features === 'object' && !Array.isArray(features) ? features : null,
    words,
  };
}

/**
 * Render one code-composition music video (or an excerpt of it) through the
 * HTML composition owner. `startSec` is the master's in-point (#8986); the
 * page's own duration is the rendered length. Song data is staged as song.json
 * before the composition snapshot freezes.
 */
export async function renderSongComposition({ project, directory, jobId, audioPath, startSec = 0 }) {
  const { renderComposition } = await import('../htmlComposition/index.js');
  return renderComposition({
    jobId,
    directory,
    owner: 'music-video',
    audio: { path: audioPath, startSec },
    maxDurationSec: Number(project?.audioAnalysis?.durationSec),
    song: musicVideoSongDocument(project),
  });
}

/**
 * Stage the storyboard animatic's lyric overlay page (documentTemplates/lyricOverlay,
 * with the shared lyricType.js and its faces) in `dir`, drawing `project`'s lyrics
 * at the render's frame, so a composed render's words match the animatic's.
 */
async function stageLyricOverlay(dir, project, { width, height, fps, durationSec }) {
  const [{ readLyricOverlayDocumentFiles }, { lyricOverlayDocumentData }] = await Promise.all([
    import('./compositionDocument.js'), import('./lyricPlaythrough.js'),
  ]);
  for (const [rel, file] of await readLyricOverlayDocumentFiles()) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await copyFile(file.abs, join(dir, rel));
  }
  const data = lyricOverlayDocumentData(project, { width, height, fps, durationSec });
  await writeFile(join(dir, 'portos-mv.js'), `window.PORTOS_MV = ${JSON.stringify(data).replace(/</g, '\\u003c')};\n`);
}

/**
 * The frame windows the overlay capture draws, per page (`doc` for the timed
 * text cues, `lyrics` for the sung lyrics), in the order renderTypographyOverlays
 * emits its clips. Each window is snapped outward to the output frame grid and
 * never runs past the video's last frame; `window` (`{ startFrame, endFrame }`,
 * a per-shot segment) clips every one to that span. Pure.
 */
export function typographyOverlayWindows({ cues, lyricWindows = [], fps, durationSec, window = null }) {
  const lastFrame = Math.round(durationSec * fps);
  const lo = window ? Math.max(0, window.startFrame) : 0;
  const hi = window ? Math.min(lastFrame, window.endFrame) : lastFrame;
  const onGrid = (spans) => spans
    .map((w) => {
      const first = Math.max(lo, Math.floor(w.startSec * fps + 1e-6));
      return { startSec: first / fps, frames: Math.min(hi, Math.ceil(w.endSec * fps - 1e-6)) - first };
    })
    .filter((w) => Number.isFinite(w.startSec) && Number.isInteger(w.frames) && w.frames > 0);
  return [
    { name: 'doc', windows: onGrid(overlayWindows(cues)) },
    { name: 'lyrics', windows: onGrid(lyricWindows) },
  ].filter((p) => p.windows.length > 0);
}

/**
 * Render the overlay clips on a `width`×`height`, `fps` frame: the timed text
 * `cues` (already filtered by renderableCues) on the typography page, and, when
 * `lyrics` is `{ project, windows }` (composedLyricWindows), the sung lyrics in
 * the shared lyric type over those windows. Resolves `[{ path, startSec,
 * durationSec }]`, typography clips first, each set in time order.
 * `window` limits the capture to one segment's frames (typographyOverlayWindows).
 * `sceneId` is logged when a frame exceeds the capture timeout. `onProgress(0..1)`
 * reports captured frames; `signal` cancels. A timeout aborts only the capture,
 * so the caller can tell a hang from a cancel.
 */
export async function renderTypographyOverlays({ jobId, cues, style, width, height, fps, durationSec, lyrics = null, window = null, sceneId = null, signal, onProgress }) {
  const pages = typographyOverlayWindows({ cues, lyricWindows: lyrics?.windows || [], fps, durationSec, window }).map(({ name, windows }) => ({
    name, windows,
    stage: name === 'doc'
      ? async (dir) => {
        await writeFile(join(dir, 'index.html'), buildTypographyDocument({ cues, style, width, height, durationSec, fps }));
        if (cues.some((c) => c.card || c.titleCard)) await copyFile(LYRIC_FONT_SOURCE, join(dir, LYRIC_FONT_FILE));
        if (cues.some((c) => c.titleCard?.font === 'mono')) await copyFile(sharedFont(TITLE_CARD_MONO_FONT_FILE), join(dir, TITLE_CARD_MONO_FONT_FILE));
      }
      : (dir) => stageLyricOverlay(dir, lyrics.project, { width, height, fps, durationSec }),
  }));
  if (pages.length === 0) return [];
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg not found on PATH');
  const root = scratchPath(jobId);
  // The caller's signal abort is a cancel. This one is also aborted when a
  // frame times out, and that reason is not a cancel.
  const overlayAbort = new AbortController();
  const abortOverlay = (reason) => { if (!overlayAbort.signal.aborted) overlayAbort.abort(reason); };
  const onCallerAbort = () => abortOverlay(signal.reason);
  if (signal?.aborted) abortOverlay(signal.reason);
  else signal?.addEventListener('abort', onCallerAbort, { once: true });
  const overlaySignal = overlayAbort.signal;
  try {
    // Lazy: the composition browser drags in browserService, which only a
    // composed render needs — not every suite that reaches render.js.
    const { openComposition } = await import('../htmlComposition/browser.js');
    const total = pages.reduce((sum, p) => sum + p.windows.reduce((n, w) => n + w.frames, 0), 0);
    let done = 0;
    const overlays = [];
    const capturedScene = sceneId || jobId;
    for (const { name, windows, stage } of pages) {
      await mkdir(join(root, name), { recursive: true });
      await stage(join(root, name));
      overlaySignal.throwIfAborted();
      // Owned headless browser: its target is foreground, so fonts, animation
      // frames, and surface screenshots run. No tab is shown.
      const page = await openComposition(`${COMPOSITION_SCRATCH_DIR}/${jobId}/${name}`, { signal: overlaySignal, ownedBrowser: true });
      try {
        await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        // A transparent default background is what gives the PNG captures alpha.
        await page.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
        await page.evaluate(`globalThis.portosComposition.layout({ width: ${width}, height: ${height} })`);
        for (const [index, w] of windows.entries()) {
          const outputPath = join(root, `${name}-overlay-${index}.mov`);
          await captureWindow(page, ffmpeg, { startSec: w.startSec, frames: w.frames, fps, outputPath, signal: overlaySignal, abort: abortOverlay, sceneId: capturedScene,
            onFrame: () => { done += 1; onProgress?.(done / total); } });
          overlays.push({ path: outputPath, startSec: w.startSec, durationSec: w.frames / fps });
        }
        await page.close({ verify: true });
      } finally {
        await page.close();
      }
    }
    return overlays;
  } finally {
    signal?.removeEventListener('abort', onCallerAbort);
  }
}
