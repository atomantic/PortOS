/** Poster edits and disposable sharing copies of local video history. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PATHS, unlinkGuarded } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { safeUnder, generateThumbnail, probeVideoDuration, probeVideoStreamInfo, findFfmpeg, runFfmpegProcess } from '../../lib/ffmpeg.js';
import { getHistoryItem, mutateVideoHistory } from './history.js';

function sourcePath(item) {
  const path = item && safeUnder(PATHS.videos, item.filename);
  if (!path) throw new ServerError('Video not found', { status: 404, code: 'NOT_FOUND' });
  return path;
}

export async function updateVideoPoster(id, atSec) {
  let result;
  let generated;
  let previous;
  try {
    await mutateVideoHistory(async history => {
      const item = history.find(item => item.id === id);
      const path = sourcePath(item);
      let posterSec;
      if (atSec !== null) {
        const [duration, stream] = await Promise.all([probeVideoDuration(path), probeVideoStreamInfo(path)]);
        if (!duration) throw new ServerError('Could not read video duration', { status: 422 });
        posterSec = Math.max(0, Math.min(atSec, duration - (stream.fps > 0 ? 1 / stream.fps : Math.min(duration, 0.001))));
      }
      // A new basename prevents browser caching and leaves the old poster intact on failure.
      generated = await generateThumbnail(path, `${id}-poster-${randomUUID()}`, { atSec: posterSec });
      if (!generated) throw new ServerError('Could not generate poster', { status: 422 });
      previous = item.thumbnail;
      item.thumbnail = generated;
      if (posterSec === undefined) delete item.posterSec;
      else item.posterSec = posterSec;
      result = { id, thumbnail: generated, posterSec: posterSec ?? null };
      return history;
    });
  } catch (error) {
    if (generated) await unlinkGuarded(join(PATHS.videoThumbnails, generated)).catch(() => {});
    throw error;
  }
  const old = previous && safeUnder(PATHS.videoThumbnails, previous);
  if (old) await unlinkGuarded(old).catch(() => {});
  return result;
}

export async function createSharingCopy(id, { signal } = {}) {
  const item = await getHistoryItem(id);
  const source = sourcePath(item);
  const poster = item.thumbnail && safeUnder(PATHS.videoThumbnails, item.thumbnail);
  if (!poster) throw new ServerError('Set a poster before downloading for sharing', { status: 422 });
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new ServerError('ffmpeg is unavailable', { status: 503 });
  const dir = await mkdtemp(join(tmpdir(), 'portos-share-'));
  const path = join(dir, 'sharing.mp4');
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    const result = await runFfmpegProcess({ bin: ffmpeg, signal, args: [
      '-i', source, '-i', poster,
      '-filter_complex', "[0:v:0][1:v:0]overlay=enable='eq(n,0)':eof_action=repeat[v]",
      '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-crf', '18',
      '-fps_mode', 'passthrough', '-c:a', 'copy', '-movflags', '+faststart', '-y', path,
    ] });
    if (!result.ok) throw new ServerError('Could not prepare sharing download', { status: 422 });
    return { path, filename: `sharing-${item.id}.mp4`, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
