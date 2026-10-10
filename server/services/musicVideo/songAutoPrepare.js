/**
 * Music Video — get a newly attached song ready without a click.
 *
 * Creating a project with a track (an imported Suno song, the default case),
 * attaching or changing its track, and importing its lyrics are the director's
 * own actions; what follows from them is mechanical. This runs the offline
 * beat/tempo/section analysis when the song has none, then starts word
 * alignment (forced alignment against the isolated vocal, separating it first
 * when there is no stem yet) when the lyric lines have never been aligned.
 *
 * Analysis is a local DSP pass of a few seconds and resolves inline; alignment
 * is a job, so its id comes back for the page to follow. Nothing here calls an
 * AI provider. A song whose lines already carry word times, an instrumental,
 * and a project an autonomous run is driving are left alone.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { isNonBlankStr } from '../../lib/textUtils.js';
import { getProject } from './projects.js';
import { analyzeProjectSong } from './projectAudio.js';
import { startLyricAlign } from './lyricAlignJob.js';

const hasAudio = (project) => Boolean(project?.trackId || project?.uploadedAudioFilename);
const autonomousRunActive = (project) => {
  const run = project?.autonomousRun;
  return Boolean(run) && !['completed', 'canceled', 'failed'].includes(run.status);
};

/** Whether the project's lyric lines are waiting for their first word alignment. */
function needsAutoAlignment(project) {
  if (project?.productionReview?.draft?.lyricsMode === 'instrumental') return false;
  const cues = (project?.lyricCues || []).filter((cue) => isNonBlankStr(cue?.text));
  return cues.length > 0 && !cues.some((cue) => Array.isArray(cue.words) && cue.words.length > 0);
}

/**
 * Analyze and align what is missing. Resolves `{ project, analyzed, alignJobId }`:
 * the current project, whether analysis ran, and the alignment job to follow
 * (null when none was needed).
 */
export async function autoPrepareSong(projectId, { analyze = analyzeProjectSong, align = startLyricAlign } = {}) {
  let project = await getProject(projectId);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  if (!hasAudio(project) || autonomousRunActive(project)) return { project, analyzed: false, alignJobId: null };
  let analyzed = false;
  if (!project.audioAnalysis) {
    project = await analyze(project.id);
    analyzed = true;
  }
  let alignJobId = null;
  if (needsAutoAlignment(project)) {
    ({ jobId: alignJobId } = await align(project.id, { separateVocals: true }));
    console.log(`🎤 Started automatic lyric alignment for ${project.id}`);
  }
  return { project, analyzed, alignJobId };
}
