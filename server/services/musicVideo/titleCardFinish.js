/** Draw the steady card after a composed cut's frame hold, on the unheld song clock. */
import { rename, rm } from 'node:fs/promises';
import { BT709_CONTAINER_ARGS, H264_ENCODE_ARGS, runFfmpegProcess } from '../../lib/ffmpeg.js';
import { ServerError } from '../../lib/errorHandler.js';
import { titleCardOverlayCues } from './composition.js';
import { removeCompositionScratch, renderTypographyOverlays } from './compositionRender.js';

/** Sparse alpha captures keep slide/fade at full frame rate; audio is copied untouched. */
export async function applyTitleCardFinish({ project, path, jobId, width, height, fps, songSec, leadSec = 0, ffmpeg, signal }) {
  const cues = titleCardOverlayCues(project, songSec);
  if (!cues.length) return false;
  const captureId = `steady-title-${jobId}`;
  const finished = `${path}.title.mp4`;
  try {
    const overlays = await renderTypographyOverlays({ jobId: captureId, cues, style: {}, width, height, fps, durationSec: songSec, signal });
    signal?.throwIfAborted();
    if (!overlays.length) return false;
    const inputs = ['-i', path];
    const filters = [];
    let picture = '0:v';
    for (const [index, overlay] of overlays.entries()) {
      inputs.push('-itsoffset', String(leadSec + overlay.startSec), '-i', overlay.path);
      const out = `title${index}`;
      filters.push(`[${index + 1}:v]scale=out_color_matrix=bt709:out_range=tv,format=yuva420p[card${index}]`);
      filters.push(`[${picture}][card${index}]overlay=eof_action=pass:format=yuv420[${out}]`);
      picture = out;
    }
    const result = await runFfmpegProcess({ bin: ffmpeg, signal, args: [
      '-hide_banner', '-loglevel', 'error', ...inputs, '-filter_complex', filters.join(';'),
      '-map', `[${picture}]`, '-map', '0:a?', '-r', String(fps),
      ...H264_ENCODE_ARGS, ...BT709_CONTAINER_ARGS, '-c:a', 'copy', '-movflags', '+faststart', '-y', finished,
    ] });
    signal?.throwIfAborted();
    if (!result.ok) throw new ServerError(`Title card finish failed: ${result.reason}`, { status: 500, code: 'TITLE_CARD_FINISH_ENCODE' });
    await rename(finished, path);
    return true;
  } finally {
    await rm(finished, { force: true }).catch(() => {});
    await removeCompositionScratch(captureId).catch(() => {});
  }
}
