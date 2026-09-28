/**
 * Frame-accurate encode of a code-rendered music video (#9076).
 *
 * The page seeks in the composition browser — the same path as an HTML
 * composition — then the master song is muxed for the exact frame count with
 * no tail fade and no footage model. song.json is written next to index.html
 * and inlined into the page (the preview sandbox cannot fetch).
 */

import { rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { buildCodeDocument } from './codeComposition.js';
import { buildCodeTimeline, buildSongDocument, codeFrameSize, paletteFromProject, quantizeSongDuration } from './codeTimeline.js';

// The composition browser and ffmpeg mux are loaded only when a render runs,
// so unit tests of the footage renderer can keep a partial ffmpeg mock.
const AAC_MUX_ARGS = Object.freeze(['-c:a', 'aac', '-b:a', '192k']);

export function _muxExactArgs(videoPath, audioPath, outputPath, durationSec, audioStartSec = 0) {
  const args = ['-hide_banner', '-loglevel', 'error', '-i', videoPath];
  if (audioStartSec > 0) args.push('-ss', String(audioStartSec));
  args.push(
    '-i', audioPath,
    '-map', '0:v:0', '-map', '1:a:0',
    '-t', String(durationSec),
    '-c:v', 'copy',
    '-af', `atrim=duration=${durationSec},apad=whole_dur=${durationSec},asetpts=PTS-STARTPTS`,
    ...AAC_MUX_ARGS,
    '-movflags', '+faststart',
    '-y', outputPath,
  );
  return args;
}

/**
 * The document, song, and frame size for a full song or an excerpt window.
 * No provider call and no footage. Throws NO_TIMELINE / INVALID_EXCERPT_RANGE.
 */
export function prepareCodeRender(project, { windowStart = null, windowEnd = null } = {}) {
  const timeline = buildCodeTimeline(project);
  if (!(timeline.durationSec > 0) || timeline.sections.length === 0) {
    throw new ServerError('Code-rendered video needs a song duration — analyze the track or time a scene or lyric line', { status: 422, code: 'NO_TIMELINE' });
  }
  const song = buildSongDocument(project, timeline);
  const palette = paletteFromProject(project);
  const sources = Object.fromEntries((project.composition?.codeVideo?.sections || [])
    .filter((section) => section && typeof section.id === 'string' && typeof section.source === 'string')
    .map((section) => [section.id, section.source]));
  const size = codeFrameSize(project.treatment?.brief?.aspectRatio);
  let start = 0;
  let durationSec = song.durationSec;
  if (windowStart != null || windowEnd != null) {
    if (!(windowStart >= 0) || !(windowEnd > windowStart) || windowStart >= song.durationSec - 1e-6) {
      throw new ServerError('The excerpt range must fall within the song', {
        status: 422, code: 'INVALID_EXCERPT_RANGE', context: { totalDuration: song.durationSec },
      });
    }
    const span = Math.min(windowEnd, song.durationSec) - windowStart;
    start = windowStart;
    durationSec = quantizeSongDuration(span, song.fps).durationSec;
  }
  const doc = buildCodeDocument({
    song, palette, sources, ...size, fps: song.fps, windowStart: start, windowDuration: durationSec,
  });
  const sectionTimes = song.sections
    .map((section) => section.startSec - start)
    .filter((time) => time >= -1e-6 && time < durationSec - 1e-3)
    .map((time) => Math.max(0, Math.round(time * 1000) / 1000));
  return { ...doc, timeline, palette, sectionTimes, footageGeneration: false };
}

export async function encodeCodeComposition({
  html, song, width, height, fps, durationSec, audioPath, outputPath, directory, signal, onProgress, audioStartSec = 0,
}) {
  const { findFfmpeg, runFfmpegProcess } = await import('../../lib/ffmpeg.js');
  const { openComposition } = await import('../htmlComposition/browser.js');
  const { encodeComposition } = await import('../htmlComposition/encode.js');
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new ServerError('ffmpeg not found on PATH', { status: 500, code: 'FFMPEG_MISSING' });
  const root = join(PATHS.data, directory);
  await ensureDir(root);
  await writeFile(join(root, 'index.html'), html);
  await writeFile(join(root, 'song.json'), JSON.stringify(song));
  const silent = `${outputPath}.silent.mp4`;
  let page;
  try {
    page = await openComposition(directory, { signal });
    await encodeComposition(page, { durationSec, fps, width, height }, silent, {
      signal, onProgress: (fraction) => onProgress?.(fraction * 0.9),
    });
    signal?.throwIfAborted();
    const mux = await runFfmpegProcess({
      bin: ffmpeg, signal, args: _muxExactArgs(silent, audioPath, outputPath, durationSec, audioStartSec),
    });
    if (!mux.ok) {
      if (signal?.aborted || /cancelled/.test(mux.reason || '')) {
        const canceled = new Error('Render cancelled');
        canceled.code = 'CANCELED';
        throw canceled;
      }
      throw new Error(mux.reason || 'audio mux failed');
    }
    onProgress?.(1);
  } finally {
    if (page) await page.close().catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await rm(silent, { force: true }).catch(() => {});
  }
}

/** Contact sheet at section boundaries. A failure is the caller's to soften. */
export async function writeCodeProofSheet(videoPath, sheetPath, times, geometry) {
  const usable = (Array.isArray(times) ? times : []).filter((time) => time >= 0);
  if (!usable.length) return null;
  const { encodeFileContactSheetAtTimes } = await import('../htmlComposition/encode.js');
  await encodeFileContactSheetAtTimes(videoPath, sheetPath, usable, geometry);
  return sheetPath;
}
