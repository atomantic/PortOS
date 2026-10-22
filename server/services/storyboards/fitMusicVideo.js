/**
 * Fit to song: writes a music video's shots from its linked storyboard, each
 * beat placed on the analyzed song and each panel a shot that keeps the
 * panel's id (lib/storyboardFit.js, the same fit the Plan step previews).
 * Replaces the shots, so it refuses while any shot is locked; a shot whose
 * span is unchanged keeps its frames and clips (replaceScenes). Runs only on
 * the user's tap; no model call.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { sungLyricTextWithin } from '../../lib/musicVideoLyricAnchors.js';
import { fitStoryboardToSong, storyboardFitSong } from '../../lib/storyboardFit.js';
import { getStoryboard } from './index.js';

export async function fitMusicVideoToStoryboard(projectId, { boardUpdatedAt, starts = {} } = {}) {
  const [{ getProject, mutateProjectRecord }, { replaceScenes }, { shotLocks }] = await Promise.all([
    import('../musicVideo/projects.js'), import('../musicVideo/projectsLogic.js'), import('../musicVideo/productionReview.js'),
  ]);
  const linked = await getProject(projectId);
  if (!linked) throw new ServerError('Music video not found', { status: 404, code: 'NOT_FOUND' });
  if (!linked.storyboardId) throw new ServerError('Link a storyboard first.', { status: 409, code: 'STORYBOARD_NOT_LINKED' });
  const board = await getStoryboard(linked.storyboardId);
  if (board.updatedAt !== boardUpdatedAt) {
    throw new ServerError('The storyboard changed since this fit was shown. Check the fit again.', { status: 409, code: 'STORYBOARD_CHANGED' });
  }
  if (!board.beats.length) throw new ServerError('The storyboard has no beats yet.', { status: 400, code: 'STORYBOARD_EMPTY' });

  const outcome = await mutateProjectRecord(projectId, (current) => {
    if (current.storyboardId !== board.id) {
      throw new ServerError('This video was linked to another storyboard meanwhile. Check the fit again.', { status: 409, code: 'STORYBOARD_CHANGED' });
    }
    const song = storyboardFitSong(current);
    if (!song) throw new ServerError('Analyze the song first; the fit places beats on its sections.', { status: 409, code: 'SONG_NOT_ANALYZED' });
    const locked = Object.values(shotLocks(current) || {}).filter((lock) => lock !== 'open').length;
    if (locked) {
      throw new ServerError(`${locked} shot${locked === 1 ? ' is' : 's are'} locked. Fit to song replaces every shot and never moves a locked one; unlock them first.`,
        { status: 409, code: 'SHOTS_LOCKED' });
    }
    const fit = fitStoryboardToSong(board, song, { starts });
    const timedLyrics = song.lyricCues.length > 0;
    const inputs = fit.shots.map(({ beatId: _beatId, ...shot }) => ({
      ...shot,
      loop: false,
      lyricText: timedLyrics ? sungLyricTextWithin(current.lyricCues, shot.startSec, shot.endSec) : null,
    }));
    return { ...replaceScenes(current, inputs), fit };
  });
  console.log(`🎬 Fit storyboard ${board.id} to music video ${projectId}: ${outcome.scenes.length} shot(s), replaced ${outcome.replaced}`);
  return { project: outcome.project, shots: outcome.scenes.length, replaced: outcome.replaced };
}
