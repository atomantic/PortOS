import { stat } from 'node:fs/promises';
import { probeVideoGeometry } from '../../lib/ffmpeg.js';
import { ServerError } from '../../lib/errorHandler.js';

/** Refuse unreadable/unsupported clips before upload or a paid task, including queue replay. */
export async function validateRunwayVideoInput(path, model, { character = false } = {}) {
  const fail = (message) => { throw new ServerError(message, { status: 400, code: 'RUNWAY_VIDEO_INPUT' }); };
  const file = await stat(path);
  if (file.size < 512 || file.size > 200 * 1024 * 1024) fail('Runway videos must be between 512 bytes and 200 MB.');
  const geometry = await probeVideoGeometry(path);
  if (!geometry) fail('Could not read the video stream. Choose a valid video file; ffprobe must be available.');
  const min = character ? 0 : model.minSec;
  if (geometry.durationSec <= 0 || (!character && (geometry.durationSec < min || geometry.durationSec > model.maxSec))) fail(`${model.label} requires a video between ${model.minSec} and ${model.maxSec} seconds.`);
  if (model.id === 'aleph2' && geometry.fps > 30) fail('Aleph 2 input video must be 30 FPS or lower.');
  return geometry;
}
