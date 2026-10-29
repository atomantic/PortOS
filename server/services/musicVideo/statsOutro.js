/**
 * Music Video — the ending after the song (lib/musicVideoEnding.js: the
 * cutting room floor, then the film credits, each optional): the floor's tally
 * read from the project's records, and the final-render pass that appends the
 * ending after the song.
 *
 * The pass captures the ending page (the same painters the animatic draws with)
 * through the shared composition encoder, then joins it to the finished cut
 * with silence under it. In a footage render it runs before the film look pass,
 * so the look grades the outro with the rest of the film; a seeked render draws
 * its look in the page, so there the outro page draws it too (`withFilmLook`).
 */

import { copyFile, link, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATHS } from '../../lib/paths.js';
import { ServerError } from '../../lib/errorHandler.js';
import { filmLookRuntimeSource, isFilmLookNeutral, normalizeFilmLook } from '../../lib/filmLook.js';
import { STATS_OUTRO_FONTS, musicVideoOutroStats } from '../../lib/musicVideoStatsOutro.js';
import { CREDITS_OUTRO_FONTS } from '../../lib/musicVideoCreditsOutro.js';
import { endingPageSource, endingParts } from '../../lib/musicVideoEnding.js';

export const STATS_OUTRO_SCRATCH_DIR = 'music-video-stats-outro';

/** Boot sweep: no render survives a restart, so every staged outro page is stale. */
export const sweepStatsOutroScratch = async () => rm(join(PATHS.data, STATS_OUTRO_SCRATCH_DIR), { recursive: true, force: true });

const FONT_DIR = new URL('./documentTemplates/shared/fonts/', import.meta.url);
const TITLE_FONT_DIR = new URL('./titleCardFonts/', import.meta.url);
// Every face file the ending page declares, by file name: where it is bundled.
const ENDING_FONT_FILES = Object.freeze({
  [STATS_OUTRO_FONTS.head.file]: FONT_DIR,
  [STATS_OUTRO_FONTS.body.file]: FONT_DIR,
  [CREDITS_OUTRO_FONTS.title.file]: TITLE_FONT_DIR,
  [CREDITS_OUTRO_FONTS.body.file]: FONT_DIR,
});

/** The tally for a floor that is not shown: nothing to count, nothing on the floor. */
const NO_STATS = Object.freeze({ floorImages: Object.freeze([]) });

/**
 * The tally for `project`: its shots' takes and selections plus every still
 * and clip in its media collection and every clip stamped with it in the
 * video history. Read-only.
 */
export async function getMusicVideoOutroStats(project) {
  const [{ getCollection, musicVideoCollectionId }, { loadHistory }] = await Promise.all([
    import('../mediaCollections.js'), import('../videoGen/history.js'),
  ]);
  const collection = await getCollection(musicVideoCollectionId(project.id)).catch(() => null);
  const stamped = (await loadHistory().catch(() => []))
    .filter((entry) => entry?.id && entry.musicVideo?.projectId === project.id)
    .map((entry) => ({ kind: 'video', ref: entry.id }));
  return musicVideoOutroStats(project, { collectionItems: [...(collection?.items || []), ...stamped] });
}

/** The ending page: a full-frame canvas, its faces, and the script that draws it per seek. Pure. */
function endingPage({ width, height }) {
  const face = ({ family, file }, weight) => `@font-face { font-family: "${family}"; src: url(fonts/${file}) format("woff2"); font-weight: ${weight}; }`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Ending</title>
<style>${face(STATS_OUTRO_FONTS.head, '100 900')}
${face(STATS_OUTRO_FONTS.body, '100 900')}
${face(CREDITS_OUTRO_FONTS.title, CREDITS_OUTRO_FONTS.title.weight)}
${face(CREDITS_OUTRO_FONTS.body, CREDITS_OUTRO_FONTS.body.weight)}
html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#000}canvas{display:block;width:${width}px;height:${height}px}</style>
</head><body><canvas id="outro"></canvas><script src="app.js"></script></body></html>\n`;
}

/**
 * Capture the project's ending alone, silent, into `outputPath` on a
 * `width`×`height` frame at `fps`. Resolves its seconds (0 when nothing is
 * on; nothing is written). `stats` (getMusicVideoOutroStats) may be passed in
 * when the caller already read it. Rejects on failure or when `signal` aborts.
 */
export async function renderStatsOutroClip({ project, outputPath, width, height, fps, jobId, signal, onProgress, withFilmLook = false, stats: knownStats = null }) {
  const parts = endingParts(project);
  if (!parts.length) return 0;
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(jobId)) throw new Error('Invalid outro job id');
  const { openComposition } = await import('../htmlComposition/browser.js');
  const { encodeComposition } = await import('../htmlComposition/encode.js');
  const { ensureImageThumbnail } = await import('../../lib/imageThumbnail.js');
  const durationSec = parts.reduce((sum, part) => sum + part.durationSec, 0);
  const floorOn = parts.some((part) => part.kind === 'floor');
  const stats = !floorOn ? NO_STATS : knownStats || await getMusicVideoOutroStats(project);
  const directory = `${STATS_OUTRO_SCRATCH_DIR}/${jobId}`;
  const scratch = join(PATHS.data, directory);
  let page;
  try {
    await rm(scratch, { recursive: true, force: true });
    await mkdir(join(scratch, 'media'), { recursive: true });
    await mkdir(join(scratch, 'fonts'), { recursive: true });
    for (const [file, dir] of Object.entries(ENDING_FONT_FILES)) await copyFile(fileURLToPath(new URL(file, dir)), join(scratch, 'fonts', file));
    // The floor's stills ride as their small gallery thumbnails; one that is gone leaves a film offcut in its place.
    const imageSrcs = [];
    for (const [i, imageId] of stats.floorImages.entries()) {
      // A gallery PNG has a small WebP beside it; any other still rides as itself, as the animatic shows it.
      const png = /\.png$/i.test(imageId);
      const thumb = imageId.replace(/\.png$/i, '.webp');
      const ok = png ? await ensureImageThumbnail(thumb).catch(() => false) : /^[^/\\]+\.(jpe?g|webp)$/i.test(imageId);
      const source = !ok ? null : png ? join(PATHS.imageThumbnails, thumb) : join(PATHS.images, imageId);
      const name = `floor-${i}${png ? '.webp' : imageId.slice(imageId.lastIndexOf('.')).toLowerCase()}`;
      const target = join(scratch, 'media', name);
      const staged = source && await link(source, target).then(() => true, () => copyFile(source, target).then(() => true, () => false));
      imageSrcs.push(staged ? `media/${name}` : '');
    }
    await writeFile(join(scratch, 'index.html'), endingPage({ width, height }));
    await writeFile(join(scratch, 'app.js'), endingPageSource({ stats, parts, imageSrcs, width, height, fps, durationSec }));
    signal?.throwIfAborted();
    // A render whose film look is drawn in its page (the seeked modes) has no later
    // pass to grade the outro, so the outro page draws the look itself.
    const look = withFilmLook ? normalizeFilmLook(project?.filmLook) : null;
    const initScripts = look && !isFilmLookNeutral(look) ? [filmLookRuntimeSource(look)] : [];
    page = await openComposition(directory, { signal, ownedBrowser: true, initScripts });
    await encodeComposition(page, { width, height, fps, durationSec }, outputPath, { signal, onProgress });
    page.check();
    await page.close({ verify: true });
    page = null;
    return durationSec;
  } finally {
    if (page) await page.close().catch(() => {});
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Append the project's ending to the finished render at `path`, in place.
 * Resolves the seconds it added (0 when nothing is on; the file is then
 * untouched). Rejects on failure or when `signal` aborts, leaving `path` as
 * it was.
 */
export async function appendStatsOutro({ project, path, jobId, signal, onProgress, withFilmLook = false }) {
  if (!endingParts(project).length) return 0;
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(jobId)) throw new Error('Invalid outro job id');
  const { findFfmpeg, runFfmpegProcess, probeVideoGeometry } = await import('../../lib/ffmpeg.js');
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new ServerError('ffmpeg not found on PATH', { status: 500, code: 'FFMPEG_MISSING' });
  const geometry = await probeVideoGeometry(path);
  if (!geometry) throw new ServerError('The rendered video could not be measured for its outro', { status: 500, code: 'STATS_OUTRO_PROBE' });
  const { width, height, fps } = geometry;
  const clip = `${path}.outro.mp4`;
  const joined = `${path}.outro-joined.mp4`;
  try {
    const durationSec = await renderStatsOutroClip({ project, outputPath: clip, width, height, fps, jobId, signal, withFilmLook,
      onProgress: (fraction) => onProgress?.(fraction * 0.6) });
    signal?.throwIfAborted();
    // Join the cut and the outro, with silence under the outro. Both pictures
    // are brought to the cut's frame, rate and pixel format first.
    const norm = `scale=${width}:${height},setsar=1,fps=${fps},format=yuv420p`;
    const audio = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
    const join2 = await runFfmpegProcess({
      bin: ffmpeg, signal,
      args: ['-hide_banner', '-loglevel', 'error', '-i', path, '-i', clip,
        '-f', 'lavfi', '-t', String(durationSec), '-i', 'anullsrc=r=48000:cl=stereo',
        '-filter_complex', `[0:v]${norm}[a0];[1:v]${norm}[b0];[0:a]${audio}[a1];[2:a]${audio}[b1];[a0][a1][b0][b1]concat=n=2:v=1:a=1[v][a]`,
        '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-y', joined],
    });
    if (!join2.ok) {
      signal?.throwIfAborted();
      throw new ServerError(`Outro join failed: ${join2.reason}`, { status: 500, code: 'STATS_OUTRO_JOIN' });
    }
    await rename(joined, path);
    onProgress?.(1);
    console.log(`🎞️ Music-video outro [${jobId.slice(0, 8)}]: ${durationSec}s ending after the song`);
    return durationSec;
  } finally {
    await rm(clip, { force: true }).catch(() => {});
    await rm(joined, { force: true }).catch(() => {});
  }
}
