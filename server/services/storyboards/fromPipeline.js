/**
 * Series Pipeline and storyboards. "Open in storyboard editor" on an issue's
 * storyboards stage builds a board from its scenes: one beat per scene, one
 * panel per shot (its description, shot type, length and start frame), or one
 * panel for a scene with no shots (its description and sketch). The board
 * keeps the issue as its `source` and each panel its scene and shot, so panel
 * art made with recipes goes back to the shot with "Use as shot art". The
 * stage is not changed until then. Runs only on the user's tap; no model call.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { STORYBOARD_LIMITS as L, STORYBOARD_PANEL_FRAMINGS } from '../../lib/storyboardVocabulary.js';
import { trimTo } from '../../lib/textUtils.js';
import { createStoryboard, listStoryboards } from './index.js';

const FRAMINGS = new Set(STORYBOARD_PANEL_FRAMINGS);
const SKETCH_KEY = /^sketch:[A-Za-z0-9-]{1,80}$/;

const panelFromShot = (scene, shot) => ({
  action: trimTo(shot.description, L.panelText),
  framing: FRAMINGS.has(shot.shotType) ? shot.shotType : null,
  seconds: Number.isFinite(shot.durationSeconds) && shot.durationSeconds > 0 ? shot.durationSeconds : null,
  takes: typeof shot.startFrameFilename === 'string' && shot.startFrameFilename ? [{ source: 'gallery', image: shot.startFrameFilename }] : [],
  sourceSceneId: scene.id,
  sourceShotId: shot.id,
});

const panelFromScene = (scene) => ({
  action: trimTo(scene.description || scene.prompt || scene.summary || scene.action, L.panelText),
  takes: SKETCH_KEY.test(scene.sketchKey || '') ? [{ source: 'sketch', sketchKey: scene.sketchKey }] : [],
  sourceSceneId: scene.id,
});

function beatsFromScenes(scenes) {
  return scenes.map((scene, index) => {
    const shots = (Array.isArray(scene.shots) ? scene.shots : []).filter((shot) => shot?.id);
    return {
      title: trimTo(scene.slugline || scene.heading, L.beatTitle) || `Scene ${index + 1}`,
      what: trimTo(scene.summary || scene.description, L.beatText),
      panels: shots.length ? shots.map((shot) => panelFromShot(scene, shot)) : [panelFromScene(scene)],
    };
  });
}

/**
 * The board linked to this issue's storyboards stage, made from its scenes
 * when there is none yet (`created` says which).
 */
export async function openStoryboardForPipelineIssue(issueId) {
  const { getIssue } = await import('../pipeline/issues.js');
  const issue = await getIssue(issueId);
  const linked = (await listStoryboards()).find((b) => b.source?.kind === 'pipeline' && b.source.issueId === issue.id);
  if (linked) return { boardId: linked.id, created: false };
  const scenes = (issue.stages?.storyboards?.scenes || []).filter((scene) => scene?.id);
  if (!scenes.length) {
    throw new ServerError('This issue has no storyboard scenes yet; add or extract scenes first.', { status: 400, code: 'NO_SCENES' });
  }
  const board = await createStoryboard({
    name: trimTo(issue.title, L.name) || 'Untitled storyboard',
  }, { beats: beatsFromScenes(scenes), source: { kind: 'pipeline', issueId: issue.id } });
  console.log(`🎬 Storyboard ${board.id} made from pipeline issue ${issue.id} (${scenes.length} scene(s))`);
  return { boardId: board.id, created: true };
}

/** Use as shot art: the image becomes the shot's start frame. Refused while the stage is locked. */
export async function attachPanelArtToPipelineShot(source, panel, image) {
  if (!panel.sourceShotId) {
    throw new ServerError('This panel is a whole scene; only a panel made from a shot can send its art back.', { status: 400, code: 'NO_SOURCE' });
  }
  const { assertStageUnlocked, updateStageWithLatest } = await import('../pipeline/issues.js');
  let found = false;
  await updateStageWithLatest(source.issueId, 'storyboards', (stage) => {
    assertStageUnlocked({ stages: { storyboards: stage } }, 'storyboards');
    const scenes = Array.isArray(stage?.scenes) ? stage.scenes : [];
    const nextScenes = scenes.map((scene) => {
      if (scene?.id !== panel.sourceSceneId || !Array.isArray(scene.shots)) return scene;
      return {
        ...scene,
        shots: scene.shots.map((shot) => {
          if (shot?.id !== panel.sourceShotId) return shot;
          found = true;
          // Clearing the job id keeps an older render still in the queue from replacing this pick.
          return { ...shot, startFrameFilename: image, startFrameJobId: null };
        }),
      };
    });
    return found ? { scenes: nextScenes } : {};
  });
  if (!found) throw new ServerError('Pipeline shot not found', { status: 404, code: 'NOT_FOUND' });
  return { issueId: source.issueId, sceneId: panel.sourceSceneId, shotId: panel.sourceShotId };
}
