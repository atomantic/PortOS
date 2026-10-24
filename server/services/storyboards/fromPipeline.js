/**
 * Series Pipeline and storyboards. "Open in storyboard editor" on an issue's
 * storyboards stage builds a board from its scenes: one beat per scene, one
 * panel per shot (its description, shot type, length and start frame), or one
 * panel for a scene with no shots (its description and sketch). The board
 * keeps the issue as its `source` and each panel its scene and shot.
 *
 * The board is a linked copy: the stage stays the source of truth (episode
 * video, audio and comic pages read its shots) and changes only on a tap.
 * "Use as shot art" sends a panel's image to its shot's start frame; Update
 * copies an edited panel's action, framing and length to its shot. A panel's
 * `sourceRev` marks what its shot last took, so an edit made on the stage
 * never reads as a storyboard change. Both refuse while the stage is locked.
 * No model call.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { STORYBOARD_LIMITS as L, STORYBOARD_PANEL_FRAMINGS } from '../../lib/storyboardVocabulary.js';
import { trimTo } from '../../lib/textUtils.js';
import { storyboardRev } from '../../lib/storyboardFit.js';
import { createStoryboard, getStoryboard, listStoryboards, mutateStoryboard } from './index.js';

const FRAMINGS = new Set(STORYBOARD_PANEL_FRAMINGS);
const SKETCH_KEY = /^sketch:[A-Za-z0-9-]{1,80}$/;

const SHOT_SECONDS_MAX = 30;

const panelRev = (panel) => storyboardRev([panel.action, panel.framing, panel.seconds]);

const panelFromShot = (scene, shot) => withRev({
  action: trimTo(shot.description, L.panelText),
  framing: FRAMINGS.has(shot.shotType) ? shot.shotType : null,
  seconds: Number.isFinite(shot.durationSeconds) && shot.durationSeconds > 0 ? shot.durationSeconds : null,
  takes: typeof shot.startFrameFilename === 'string' && shot.startFrameFilename ? [{ source: 'gallery', image: shot.startFrameFilename }] : [],
  sourceSceneId: scene.id,
  sourceShotId: shot.id,
});

function withRev(panel) {
  return { ...panel, sourceRev: panelRev(panel) };
}

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
async function linkedBoardId(issueId) {
  return (await listStoryboards()).find((b) => b.source?.kind === 'pipeline' && b.source.issueId === issueId)?.id ?? null;
}

export async function openStoryboardForPipelineIssue(issueId) {
  const { getIssue } = await import('../pipeline/issues.js');
  const issue = await getIssue(issueId);
  const linked = await linkedBoardId(issue.id);
  if (linked) return { boardId: linked, created: false };
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

/** The shot fields a panel's Update writes that differ from the shot now. */
function panelShotPatch(panel, shot) {
  const next = { shotType: panel.framing };
  // An empty action keeps the description; the stage drops a shot with none.
  if (panel.action) next.description = panel.action;
  if (panel.seconds) next.durationSeconds = Math.min(SHOT_SECONDS_MAX, Math.max(1, Math.round(panel.seconds)));
  const current = { ...shot, description: trimTo(shot.description, L.panelText) };
  return Object.fromEntries(Object.entries(next).filter(([key, value]) => (current[key] ?? null) !== value));
}

// A board made before `sourceRev` has no mark, so any difference counts.
const editedOnBoard = (panel) => !panel.sourceRev || panelRev(panel) !== panel.sourceRev;

function shotPanels(board) {
  return board.beats.flatMap((beat) => beat.panels).filter((panel) => panel.sourceSceneId && panel.sourceShotId);
}

const shotKey = (sceneId, shotId) => `${sceneId}\u0000${shotId}`;

/** Shots whose panel was edited on the linked board since the shot last took it. */
export async function pipelineStoryboardChanges(issueId) {
  const { getIssue } = await import('../pipeline/issues.js');
  const issue = await getIssue(issueId);
  const boardId = await linkedBoardId(issue.id);
  if (!boardId) return { boardId: null, locked: false, changed: [] };
  const board = await getStoryboard(boardId);
  const stage = issue.stages?.storyboards || {};
  const shots = new Map();
  for (const scene of stage.scenes || []) {
    for (const shot of Array.isArray(scene?.shots) ? scene.shots : []) shots.set(shotKey(scene.id, shot?.id), shot);
  }
  const changed = shotPanels(board).flatMap((panel) => {
    const shot = shots.get(shotKey(panel.sourceSceneId, panel.sourceShotId));
    const fields = shot && editedOnBoard(panel) ? Object.keys(panelShotPatch(panel, shot)) : [];
    return fields.length ? [{ sceneId: panel.sourceSceneId, shotId: panel.sourceShotId, panelId: panel.id, fields }] : [];
  });
  return { boardId, locked: stage.locked === true, changed };
}

/**
 * Update: each shot (or just `shotId`) whose panel was edited on the board
 * takes the panel's action, framing and length; the panels are then marked as
 * taken. Refused while the stage is locked. Answers with the saved issue and
 * the changes still waiting.
 */
export async function updatePipelineShotsFromBoard(issueId, { shotId = null } = {}) {
  const { getIssue, assertStageUnlocked, updateStageWithLatest } = await import('../pipeline/issues.js');
  const issue = await getIssue(issueId);
  const boardId = await linkedBoardId(issue.id);
  if (!boardId) throw new ServerError('Open this issue in the storyboard editor first.', { status: 409, code: 'NO_BOARD' });
  const board = await getStoryboard(boardId);
  const panels = new Map(shotPanels(board)
    .filter((panel) => (!shotId || panel.sourceShotId === shotId) && editedOnBoard(panel))
    .map((panel) => [shotKey(panel.sourceSceneId, panel.sourceShotId), panel]));
  let taken = new Map();
  const { issue: saved } = await updateStageWithLatest(issue.id, 'storyboards', (stage) => {
    assertStageUnlocked({ stages: { storyboards: stage } }, 'storyboards');
    taken = new Map();
    const scenes = (Array.isArray(stage?.scenes) ? stage.scenes : []).map((scene) => {
      if (!Array.isArray(scene?.shots)) return scene;
      return {
        ...scene,
        shots: scene.shots.map((shot) => {
          const panel = panels.get(shotKey(scene.id, shot?.id));
          const patch = panel ? panelShotPatch(panel, shot) : {};
          if (!Object.keys(patch).length) return shot;
          taken.set(panel.id, panelRev(panel));
          return { ...shot, ...patch };
        }),
      };
    });
    return taken.size ? { scenes } : {};
  });
  if (taken.size) {
    await mutateStoryboard(boardId, (draft) => {
      for (const panel of shotPanels(draft)) if (taken.has(panel.id)) panel.sourceRev = taken.get(panel.id);
    });
    console.log(`🎬 Pipeline issue ${issue.id}: ${taken.size} shot(s) updated from storyboard ${boardId}`);
  }
  return { updated: taken.size, issue: saved, ...(await pipelineStoryboardChanges(issue.id)) };
}
