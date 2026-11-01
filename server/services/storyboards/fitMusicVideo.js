/**
 * Fit to song: writes a music video's shots from its linked storyboard, each
 * beat placed on the analyzed song and each panel a shot that keeps the
 * panel's id (lib/storyboardFit.js, the same fit the Plan step previews).
 * Beats marked before the song become the shots before it (the cold open).
 * Replaces the shots; a shot matched by panel or span keeps its frames and clips
 * (replaceScenes). Runs only on
 * the user's tap; no model call.
 *
 * After the fit, a shot whose panel was edited shows it (storyboardShotPanel)
 * and waits: Update copies the panel's action to the shot's intent and its art
 * to the shot's frame reference. Use as panel art sends the shot's still back to its panel as the
 * selected take.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { localImageFilename } from '../../lib/localImageFilename.js';
import { sungLyricTextWithin } from '../../lib/musicVideoLyricAnchors.js';
import { fitStoryboardToSong, songSectionBeats, storyboardFitSong, storyboardPanelArt, storyboardPanelRev, storyboardShotPanel } from '../../lib/storyboardFit.js';
import { addPanelTake, getStoryboard, mutateStoryboard, selectPanelTake } from './index.js';

export async function fitMusicVideoToStoryboard(projectId, { boardUpdatedAt, starts = {} } = {}) {
  const [{ getProject, mutateProjectRecord }, { replaceScenes }] = await Promise.all([
    import('../musicVideo/projects.js'), import('../musicVideo/projectsLogic.js'),
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
    const fit = fitStoryboardToSong(board, song, { starts });
    const timedLyrics = song.lyricCues.length > 0;
    const inputs = fit.shots.map(({ beatId: _beatId, ...shot }) => ({
      ...shot,
      loop: false,
      lyricText: timedLyrics && !shot.preMusic ? sungLyricTextWithin(current.lyricCues, shot.startSec, shot.endSec) : null,
    }));
    return { ...replaceScenes(current, inputs, { matchPanel: true }), fit };
  });
  console.log(`🎬 Fit storyboard ${board.id} to music video ${projectId}: ${outcome.scenes.length} shot(s), replaced ${outcome.replaced}`);
  return { project: outcome.project, shots: outcome.scenes.length, replaced: outcome.replaced };
}

/** A fitted shot, its project and its panel on the linked board; 409 when the panel is gone. */
async function shotAndPanel(projectId, sceneId) {
  const { getProject } = await import('../musicVideo/projects.js');
  const project = await getProject(projectId);
  if (!project) throw new ServerError('Music video not found', { status: 404, code: 'NOT_FOUND' });
  const scene = (project.scenes || []).find((s) => s.sceneId === sceneId);
  if (!scene) throw new ServerError('Scene not found', { status: 404, code: 'NOT_FOUND' });
  if (!scene.panelId) throw new ServerError('This shot was not fitted from a storyboard panel.', { status: 409, code: 'NO_PANEL' });
  const board = project.storyboardId ? await getStoryboard(project.storyboardId).catch(() => null) : null;
  const found = board && storyboardShotPanel(board, scene);
  if (!found || found.state === 'missing') {
    throw new ServerError("This shot's storyboard panel is gone; unlink it from the panel.", { status: 409, code: 'PANEL_MISSING' });
  }
  return { project, scene, board, panel: found.panel };
}

/** Update: the shot takes its panel's action as its intent and its art as its frame reference. */
export async function updateShotFromPanel(projectId, sceneId) {
  const { panel } = await shotAndPanel(projectId, sceneId);
  const { updateScene } = await import('../musicVideo/projects.js');
  const scene = await updateScene(projectId, sceneId, {
    visualIntent: panel.action.trim() || null, panelRev: storyboardPanelRev(panel), panelArt: storyboardPanelArt(panel),
  });
  return { scene };
}

/** Use as panel art: the shot's still becomes its panel's selected take (reselected when already there). */
export async function sendShotStillToPanel(projectId, sceneId) {
  const { scene, board, panel } = await shotAndPanel(projectId, sceneId);
  const image = localImageFilename(scene.referenceImageId);
  if (!image) throw new ServerError('This shot has no still in the gallery yet.', { status: 409, code: 'NO_STILL' });
  const existing = panel.takes.find((take) => take.source === 'gallery' && take.image === image);
  const next = existing ? await selectPanelTake(board.id, panel.id, existing.id)
    : (await addPanelTake(board.id, panel.id, { source: 'gallery', image })).board;
  // The panel's art is now this still, so the shot's reference follows and it does not read as changed.
  const { updateScene } = await import('../musicVideo/projects.js');
  const updated = await updateScene(projectId, sceneId, { panelArt: image });
  console.log(`🎬 Shot ${sceneId} still → storyboard ${board.id} panel ${panel.id}`);
  return { board: next, scene: updated };
}

/**
 * Group by song sections: the linked board's beats become the song's sections
 * (songSectionBeats). Panels and their art are unchanged; only which beat holds
 * them, and the beats' names, change. Runs only on the user's tap.
 */
export async function groupStoryboardBySong(projectId) {
  const { getProject } = await import('../musicVideo/projects.js');
  const project = await getProject(projectId);
  if (!project) throw new ServerError('Music video not found', { status: 404, code: 'NOT_FOUND' });
  if (!project.storyboardId) throw new ServerError('Link a storyboard first.', { status: 409, code: 'STORYBOARD_NOT_LINKED' });
  const { board } = await mutateStoryboard(project.storyboardId, (draft) => {
    const beats = songSectionBeats(draft, project);
    if (!beats) throw new ServerError('Analyze the song first; its sections name the beats.', { status: 409, code: 'SONG_NOT_ANALYZED' });
    draft.beats = beats;
  });
  console.log(`🎬 Storyboard ${board.id} grouped by song sections of ${projectId}: ${board.beats.length} beat(s)`);
  return board;
}
