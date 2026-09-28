/**
 * Frame-exact MP4 export for a generated Code Animation (#9078).
 *
 * Real-time recording (MediaRecorder in the user's tab) drops frames whenever
 * renderFrame(t) takes longer than 1/fps. This export instead hands the stored
 * HTML to the HTML-composition renderer, which seeks every frame's time in the
 * managed browser, screenshots it, and encodes H.264/BT.709 through the media
 * queue — so a slow frame costs wall time, never a frame.
 *
 * The bridge is a shim injected before the page's own scripts: it defines
 * `portosComposition` from ANIMATION_META + renderFrame, stops the page's own
 * requestAnimationFrame clock, and hides everything but the film canvas.
 */

import { join } from 'path';
import { mkdir, rm } from 'fs/promises';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/paths.js';
import { atomicWrite } from '../../lib/fileUtils.js';
import { getCodeAnimationJobRecord, isCodeAnimationJobId, readCodeAnimationHtml } from './jobStore.js';
import { CODE_ANIMATION_SONG_GLOBAL } from './prompt.js';

// The frames the composition renderer accepts (htmlCompositionContractSchema).
export const EXPORT_FRAME_SIZES = Object.freeze(['1920x1080', '1080x1920', '1080x1080', '1280x720']);
// The composition renderer's duration cap; longer films export their first 120s.
export const EXPORT_MAX_DURATION_SEC = 120;
export const EXPORT_DIRECTORY_ROOT = 'code-animation-exports';

const scriptLiteral = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

/**
 * The shim script, run before any page script. `song` is the measured beat
 * grid of the attached Music-library track (or null), exposed as
 * window.ANIMATION_SONG (CODE_ANIMATION_SONG_GLOBAL) so audio-reactive films can stay a function of t.
 */
export function buildExportShim({ maxDurationSec = EXPORT_MAX_DURATION_SEC, song = null } = {}) {
  return `(() => {
  const nativeRaf = window.requestAnimationFrame.bind(window);
  ${song ? `window[${scriptLiteral(CODE_ANIMATION_SONG_GLOBAL)}] = ${scriptLiteral(song)};` : ''}
  // The renderer owns the clock: the page's own rAF loop never runs.
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
  let film = null;
  const hideAllButFilm = () => {
    const canvases = [...document.querySelectorAll('canvas')];
    film = canvases.sort((a, b) => (b.width * b.height) - (a.width * a.height))[0] || null;
    if (!film) return;
    film.setAttribute('data-portos-film', '');
    const style = document.createElement('style');
    style.textContent = 'html,body{background:#000!important;margin:0!important;overflow:hidden!important}'
      + 'body *{visibility:hidden!important}'
      + 'canvas[data-portos-film]{visibility:visible!important;position:fixed!important;left:0!important;top:0!important;'
      + 'width:100vw!important;height:100vh!important;transform:none!important;margin:0!important;z-index:2147483647!important}';
    document.head.appendChild(style);
  };
  addEventListener('load', hideAllButFilm, { once: true });
  Object.defineProperty(globalThis, 'portosComposition', { configurable: false, get() {
    if (typeof window.renderFrame !== 'function') {
      throw new Error('This animation does not define window.renderFrame(t), so it cannot export frame-exact — use Record (real-time) instead');
    }
    const meta = window.ANIMATION_META || {};
    if (!film) throw new Error('This animation has no <canvas> to export');
    return {
      durationSec: Math.min(Number(meta.duration), ${Number(maxDurationSec)}),
      fps: Number(meta.fps),
      width: Number(meta.width),
      height: Number(meta.height),
      // Each seek resolves after the next paint so the screenshot holds frame t.
      seek: async (t) => { await window.renderFrame(t); await new Promise((resolve) => nativeRaf(() => resolve())); },
    };
  } });
})();`;
}

/** The stored HTML with the shim inserted as the first script of the document. */
export function injectExportShim(html, shim) {
  const tag = `<script>${shim}</script>`;
  const head = html.match(/<head[^>]*>/i);
  if (!head) return `${tag}${html}`;
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}${tag}${html.slice(at)}`;
}

// Only a Music-library track can be muxed; `/data/music/<file>` is the URL the
// job stored for it.
function musicTrackOf(job) {
  const match = /^\/data\/music\/([^/]+)$/.exec(job.audioUrl || '');
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Validate a completed job, stage its HTML + shim under data/, and enqueue the
 * composition render. Returns the queued media job plus any export notes.
 */
export async function startCodeAnimationExport(id, deps = {}) {
  const {
    enqueueJob = (await import('../mediaJobQueue/index.js')).enqueueJob,
    beatGrid = async (track) => {
      const [{ resolveMusicTrackPath }, { getBeatGrid }] = await Promise.all([import('../pipeline/audioMux.js'), import('../../lib/beatGrid.js')]);
      const path = await resolveMusicTrackPath(track);
      if (!path) throw new ServerError('The animation\'s soundtrack is missing from the Music library', { status: 400, code: 'AUDIO_NOT_FOUND' });
      return getBeatGrid(path).catch(() => null);
    },
  } = deps;
  const job = isCodeAnimationJobId(id) ? await getCodeAnimationJobRecord(id) : null;
  if (!job) throw new ServerError('Code Animation job not found', { status: 404, code: 'NOT_FOUND' });
  if (job.status !== 'completed') throw new ServerError('Only a completed animation can be exported', { status: 409, code: 'NOT_COMPLETED' });
  const { width, height, durationSeconds } = job.frame || {};
  if (!EXPORT_FRAME_SIZES.includes(`${width}x${height}`)) {
    throw new ServerError(`Frame-exact export supports ${EXPORT_FRAME_SIZES.join(', ')}; this animation is ${width}x${height} — use Record (real-time) instead`, { status: 400, code: 'EXPORT_SIZE_UNSUPPORTED' });
  }
  const html = await readCodeAnimationHtml(id);
  const musicTrack = musicTrackOf(job);
  const notes = [];
  if (job.audioUrl && !musicTrack) notes.push('Uploaded audio is not muxed; the export is silent. Attach a Music-library track to include it.');
  if (durationSeconds > EXPORT_MAX_DURATION_SEC) notes.push(`The export is capped at ${EXPORT_MAX_DURATION_SEC}s; this animation runs ${durationSeconds}s.`);
  const song = musicTrack ? await beatGrid(musicTrack) : null;
  const directory = `${EXPORT_DIRECTORY_ROOT}/${id}`;
  const dir = join(PATHS.data, directory);
  // Re-stage from scratch so a stale asset from an earlier export never rides along.
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await atomicWrite(join(dir, 'index.html'), injectExportShim(html, buildExportShim({ song })));
  const queued = await enqueueJob({ kind: 'html-composition', params: { directory, ...(musicTrack ? { musicTrack } : {}) } });
  console.log(`🎬 Code animation ${id.slice(0, 8)} frame-exact export queued as ${queued.jobId}`);
  return { ...queued, notes };
}
