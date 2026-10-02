/**
 * A Music Video project's source audio: resolve it to an absolute path under
 * data/music/ and run the offline beat/tempo/section analysis on it. Shared by
 * the `/analyze` routes and the autonomous run so both read the same file the
 * same way.
 */
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/fileUtils.js';
import { safeUnder } from '../../lib/ffmpeg.js';
import { getTrack } from '../tracks/index.js';
import { getProject, setProjectAnalysis } from './projects.js';
import { analyzeAudioFile } from './audioAnalysis.js';
import { relabelAnalysisSections } from './lyricMarkers.js';

/**
 * Resolve a project's source audio to an absolute path under data/music/. The
 * filename comes from the linked track or the uploaded-audio field; both are
 * validated as safe basenames so a tampered record can't escape the directory.
 */
export async function resolveProjectAudioPath(project) {
  let filename = null;
  if (project.trackId) {
    const track = await getTrack(project.trackId);
    if (!track) throw new ServerError('Linked track not found', { status: 404, code: 'NOT_FOUND' });
    filename = track.audioFilename;
  } else if (project.uploadedAudioFilename) {
    filename = project.uploadedAudioFilename;
  }
  if (!filename) {
    throw new ServerError('Project has no audio to analyze — set a track or upload audio first', { status: 400, code: 'NO_AUDIO' });
  }
  const safe = safeUnder(PATHS.music, filename);
  if (!safe) throw new ServerError('Invalid audio filename', { status: 400, code: 'VALIDATION_ERROR' });
  return safe;
}

/**
 * Analyze the project's audio and cache the result on it. Timed lyrics with
 * sheet headers name the fresh sections too (a no-op until the lines are
 * aligned). Resolves to the updated project.
 */
export async function analyzeProjectSong(projectId) {
  const project = await getProject(projectId);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const analysis = await analyzeAudioFile(await resolveProjectAudioPath(project));
  if (!analysis) {
    throw new ServerError('Could not analyze audio (decode failed or ffmpeg unavailable)', { status: 422, code: 'ANALYZE_FAILED' });
  }
  return setProjectAnalysis(project.id, relabelAnalysisSections(analysis, project.lyricCues, project.lyricMarkers), project);
}
