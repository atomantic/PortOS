/**
 * The one resolver for a Music Video project's source audio path under
 * data/music/. A leaf so analysis, alignment, stems and federation read the
 * master without importing the render pipeline (#17578).
 */
import { existsSync } from 'fs';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/fileUtils.js';
import { safeUnder } from '../../lib/ffmpeg.js';
import { getTrack } from '../tracks/index.js';

const NO_AUDIO_MESSAGE = 'Project has no audio — set a track or upload audio first';

/**
 * Resolve the project's linked track or uploaded file to an absolute path
 * under data/music/; both names must be safe basenames so a tampered record
 * can't escape the directory.
 *
 * `requireExists` (the default) also verifies the file is on disk and reports
 * an unsafe name the same way, 404 AUDIO_MISSING. Without it an unsafe name is
 * a 400 VALIDATION_ERROR and the caller owns the existence check.
 */
export async function resolveMasterAudioPath(project, { requireExists = true, noAudioMessage = NO_AUDIO_MESSAGE } = {}) {
  let filename = null;
  if (project.trackId) {
    const track = await getTrack(project.trackId);
    if (!track) throw new ServerError('Linked track not found', { status: 404, code: 'NOT_FOUND' });
    filename = track.audioFilename;
  } else if (project.uploadedAudioFilename) {
    filename = project.uploadedAudioFilename;
  }
  if (!filename) throw new ServerError(noAudioMessage, { status: 400, code: 'NO_AUDIO' });
  const safe = safeUnder(PATHS.music, filename);
  if (requireExists) {
    if (!safe || !existsSync(safe)) throw new ServerError('Project audio file is missing', { status: 404, code: 'AUDIO_MISSING' });
  } else if (!safe) {
    throw new ServerError('Invalid audio filename', { status: 400, code: 'VALIDATION_ERROR' });
  }
  return safe;
}
