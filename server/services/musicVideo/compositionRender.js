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

import { join } from 'path';
import { mkdir, rm, writeFile } from 'fs/promises';
import { spawn } from '../../lib/childProcess.js';
import { PATHS } from '../../lib/fileUtils.js';
import { findFfmpeg } from '../../lib/ffmpeg.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { buildTypographyDocument, overlayWindows } from './composition.js';

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
      const { data } = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
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

/**
 * Render the overlay clips for `cues` (already filtered by renderableCues) on a
 * `width`×`height`, `fps` frame. Resolves `[{ path, startSec, durationSec }]` in
 * time order. `onProgress(0..1)` reports captured frames; `signal` cancels.
 */
export async function renderTypographyOverlays({ jobId, cues, style, width, height, fps, durationSec, signal, onProgress }) {
  // Snap each window outward to the output frame grid so every overlay frame
  // lands exactly on a footage frame, and never past the video's last frame.
  const lastFrame = Math.round(durationSec * fps);
  const windows = overlayWindows(cues)
    .map((w) => {
      const first = Math.floor(w.startSec * fps + 1e-6);
      return { startSec: first / fps, frames: Math.min(lastFrame, Math.ceil(w.endSec * fps - 1e-6)) - first };
    })
    .filter((w) => w.frames > 0);
  if (windows.length === 0) return [];
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg not found on PATH');
  const root = scratchPath(jobId);
  await mkdir(join(root, 'doc'), { recursive: true });
  await writeFile(join(root, 'doc', 'index.html'), buildTypographyDocument({ cues, style, width, height, durationSec, fps }));
  signal?.throwIfAborted();
  // Lazy: the composition browser drags in browserService, which only a
  // composed render needs — not every suite that reaches render.js.
  const { openComposition } = await import('../htmlComposition/browser.js');
  const page = await openComposition(`${COMPOSITION_SCRATCH_DIR}/${jobId}/doc`, { signal });
  try {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    // A transparent default background is what gives the PNG captures alpha.
    await page.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await page.evaluate(`globalThis.portosComposition.layout({ width: ${width}, height: ${height} })`);
    const total = windows.reduce((sum, w) => sum + w.frames, 0);
    let done = 0;
    const overlays = [];
    for (const [index, w] of windows.entries()) {
      const outputPath = join(root, `overlay-${index}.mov`);
      await captureWindow(page, ffmpeg, { startSec: w.startSec, frames: w.frames, fps, outputPath, signal,
        onFrame: () => { done += 1; onProgress?.(done / total); } });
      overlays.push({ path: outputPath, startSec: w.startSec, durationSec: w.frames / fps });
    }
    await page.close({ verify: true });
    return overlays;
  } finally {
    await page.close();
  }
}
