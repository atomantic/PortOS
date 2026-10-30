/**
 * Make storyboard from this video: a board built from a music video's current
 * shots, then linked to the project (`project.storyboardId`). One beat per run
 * of shots in the same song section; one panel per shot, carrying its action,
 * sung line, camera move, length, cast and selected still. The shots are not
 * changed. The board draws in the production sketch style. Runs only on the
 * user's tap; no model call.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { localImageFilename } from '../../lib/localImageFilename.js';
import { STORYBOARD_ASPECT_RATIOS, STORYBOARD_LIMITS as L } from '../../lib/storyboardVocabulary.js';
import { trimTo } from '../../lib/textUtils.js';
import { createStoryboard, getStoryboard } from './index.js';

// Planner section labels read "Section 3 · 2/4"; the beat takes the section part.
const sectionTitle = (label) => trimTo(String(label || '').split(' · ')[0], L.beatTitle);

function panelFromScene(scene) {
  const seconds = Number.isFinite(scene.startSec) && Number.isFinite(scene.endSec) && scene.endSec > scene.startSec
    ? scene.endSec - scene.startSec : null;
  const image = localImageFilename(scene.referenceImageId);
  const castId = trimTo(scene.characterVariant?.ingredientId, L.refId);
  return {
    action: trimTo(scene.visualIntent || scene.framePrompt || scene.prompt, L.panelText),
    dialogue: trimTo(scene.lyricText, L.panelText),
    camera: trimTo(scene.camera?.move, L.camera),
    seconds,
    castIds: castId ? [castId] : [],
    takes: image ? [{ source: 'gallery', image }] : [],
  };
}

function beatsFromScenes(scenes) {
  const beats = [];
  for (const scene of [...scenes].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    const key = scene.sectionIndex ?? null;
    const last = beats.at(-1);
    if (!last || last.key !== key) beats.push({ key, title: sectionTitle(scene.sectionLabel), panels: [] });
    beats.at(-1).panels.push(panelFromScene(scene));
  }
  return beats.map(({ key: _key, ...beat }) => beat);
}

export async function makeStoryboardFromMusicVideo(projectId) {
  const { getProject, updateProject } = await import('../musicVideo/projects.js');
  const project = await getProject(projectId);
  if (!project) throw new ServerError('Music video not found', { status: 404, code: 'NOT_FOUND' });
  if (project.storyboardId) {
    const linked = await getStoryboard(project.storyboardId).catch(() => null);
    if (linked) throw new ServerError(`This video is already linked to "${linked.name}"; unlink it first.`, { status: 409, code: 'STORYBOARD_LINKED' });
  }
  const scenes = Array.isArray(project.scenes) ? project.scenes : [];
  if (!scenes.length) throw new ServerError('This video has no shots yet; plan the shots first.', { status: 400, code: 'NO_SHOTS' });
  const aspect = project.treatment?.brief?.aspectRatio;
  const board = await createStoryboard({
    name: trimTo(project.name, L.name) || 'Untitled storyboard',
    aspectRatio: STORYBOARD_ASPECT_RATIOS.includes(aspect) ? aspect : '16:9',
    artStyle: 'production-sketch',
    moodBoardId: project.visualSpec?.moodBoardId || null,
  }, { beats: beatsFromScenes(scenes) });
  const linked = await updateProject(projectId, { storyboardId: board.id });
  console.log(`🎬 Storyboard ${board.id} made from music video ${projectId} (${scenes.length} shot(s))`);
  return { board, project: linked };
}
