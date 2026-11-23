/**
 * A Music Video project's source audio: resolve it to an absolute path under
 * data/music/ and run the offline beat/tempo/section analysis on it. Shared by
 * the `/analyze` routes and the autonomous run so both read the same file the
 * same way.
 */
import { ServerError } from '../../lib/errorHandler.js';
import { resolveMasterAudioPath } from './masterAudioPath.js';
import { setProjectAnalysis, setProjectSections } from './projects.js';
import { requireProject } from './requireProject.js';
import { analyzeAudioFile } from './audioAnalysis.js';
import { relabelAnalysisSections } from '../../lib/lyricMarkers.js';
import { sectionsFromLyricSpans } from '../../lib/musicVideo/musicVideoSections.js';

/**
 * Resolve a project's source audio to an absolute path under data/music/
 * without requiring it on disk: the analyzer reports an unreadable file itself.
 */
export const resolveProjectAudioPath = (project) => resolveMasterAudioPath(project, {
  requireExists: false,
  noAudioMessage: 'Project has no audio to analyze — set a track or upload audio first',
});

/**
 * Analyze the project's audio and cache the result on it. Timed lyrics with
 * sheet headers name the fresh sections too (a no-op until the lines are
 * aligned). Resolves to the updated project.
 */
export async function analyzeProjectSong(projectId) {
  const project = await requireProject(projectId);
  const analysis = await analyzeAudioFile(await resolveProjectAudioPath(project));
  if (!analysis) {
    throw new ServerError('Could not analyze audio (decode failed or ffmpeg unavailable)', { status: 422, code: 'ANALYZE_FAILED' });
  }
  return setProjectAnalysis(project.id, relabelAnalysisSections(analysis, project.lyricCues, project.lyricMarkers), project);
}

/** Re-cut the song map at the aligned lyric sheet's section boundaries. */
export async function setSectionsFromLyrics(projectId) {
  const project = await requireProject(projectId);
  if (!project.audioAnalysis) throw new ServerError('Analyze the song first', { status: 422, code: 'NOT_ANALYZED' });
  const sections = sectionsFromLyricSpans(project.lyricCues, project.lyricMarkers, project.audioAnalysis.durationSec);
  if (sections.length === 0) {
    throw new ServerError('No timed lyric sections — import lyrics with [Chorus]-style headers and align them first', { status: 422, code: 'NO_LYRIC_SECTIONS' });
  }
  return setProjectSections(project.id, sections);
}
