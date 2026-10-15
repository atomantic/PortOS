/**
 * Music Video — typography overlay capture (#8984, part of #8966).
 *
 * Renders a composed project's timed text cues into transparent overlay clips
 * that render.js lays over the concatenated footage. The page is the sandboxed
 * HTML composition from composition.js, opened through the shared composition
 * browser boundary (htmlComposition/browser.js: frozen assets, no network, CSP
 * sandbox). Only the time ranges that carry text are captured — one clip per
 * `overlayWindows` range, each encoded with an alpha channel (QuickTime RLE) —
 * so a mostly-instrumental song costs a handful of frames, not the whole song.
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
import { buildTypographyDocument, LYRIC_FONT_FILE, overlayWindows } from './composition.js';

const LYRIC_FONT_SOURCE = fileURLToPath(new URL(`./documentTemplates/shared/fonts/${LYRIC_FONT_FILE}`, import.meta.url));

export const COMPOSITION_SCRATCH_DIR = 'music-video-compositions';

const scratchPath = (jobId) => join(PATHS.data, COMPOSITION_SCRATCH_DIR, jobId);

/** Remove one job's scratch directory (best-effort). */
export const removeCompositionScratch = async (jobId) => rm(scratchPath(jobId), { recursive: true, force: true });

/** Boot sweep: no render survives a restart, so every scratch directory is stale. */
export const sweepCompositionScratch = async () => rm(join(PATHS.data, COMPOSITION_SCRATCH_DIR), { recursive: true, force: true });

// Capture frames [0, frames) of one window, seeking the page to the window's
// absolute song time for each, into an alpha-preserving QuickTime RLE clip.
async function captureWindow(page, ffmpeg, { startSec, frames, fps, outputPath, signal, onFrame }) {
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
  try {
    for (let n = 0; n < frames; n++) {
      page.check();
      await page.evaluate(`globalThis.portosComposition.seek(${startSec + n / fps})`);
      page.check();
      const { data } = await page.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, fromSurface: true, captureBeyondViewport: false });
      signal?.throwIfAborted();
      await Promise.race([
        new Promise((resolve, reject) => proc.stdin.write(Buffer.from(data, 'base64'), (error) => (error ? reject(error) : resolve()))),
        finished.then(() => { throw new Error('ffmpeg exited before the overlay was complete'); }),
      ]);
      onFrame?.();
    }
    proc.stdin.end();
    await finished;
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
    .filter((w) => w.frames > 0);
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
 * `onProgress(0..1)` reports captured frames; `signal` cancels.
 */
export async function renderTypographyOverlays({ jobId, cues, style, width, height, fps, durationSec, lyrics = null, window = null, signal, onProgress }) {
  const pages = typographyOverlayWindows({ cues, lyricWindows: lyrics?.windows || [], fps, durationSec, window }).map(({ name, windows }) => ({
    name, windows,
    stage: name === 'doc'
      ? async (dir) => {
        await writeFile(join(dir, 'index.html'), buildTypographyDocument({ cues, style, width, height, durationSec, fps }));
        if (cues.some((c) => c.card || c.titleCard)) await copyFile(LYRIC_FONT_SOURCE, join(dir, LYRIC_FONT_FILE));
      }
      : (dir) => stageLyricOverlay(dir, lyrics.project, { width, height, fps, durationSec }),
  }));
  if (pages.length === 0) return [];
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg not found on PATH');
  const root = scratchPath(jobId);
  // Lazy: the composition browser drags in browserService, which only a
  // composed render needs — not every suite that reaches render.js.
  const { openComposition } = await import('../htmlComposition/browser.js');
  const total = pages.reduce((sum, p) => sum + p.windows.reduce((n, w) => n + w.frames, 0), 0);
  let done = 0;
  const overlays = [];
  for (const { name, windows, stage } of pages) {
    await mkdir(join(root, name), { recursive: true });
    await stage(join(root, name));
    signal?.throwIfAborted();
    const page = await openComposition(`${COMPOSITION_SCRATCH_DIR}/${jobId}/${name}`, { signal });
    try {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      // A transparent default background is what gives the PNG captures alpha.
      await page.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
      await page.evaluate(`globalThis.portosComposition.layout({ width: ${width}, height: ${height} })`);
      for (const [index, w] of windows.entries()) {
        const outputPath = join(root, `${name}-overlay-${index}.mov`);
        await captureWindow(page, ffmpeg, { startSec: w.startSec, frames: w.frames, fps, outputPath, signal,
          onFrame: () => { done += 1; onProgress?.(done / total); } });
        overlays.push({ path: outputPath, startSec: w.startSec, durationSec: w.frames / fps });
      }
      await page.close({ verify: true });
    } finally {
      await page.close();
    }
  }
  return overlays;
}
