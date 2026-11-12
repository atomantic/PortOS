/**
 * Mirrors a Blender film's shots onto the project's Board scenes, one scene
 * per shot, so the storyboard, the beat timeline, lyric anchors and the
 * production review read the film without knowing it is made in Blender.
 *
 * The scripts own the shot list; the Board follows it. A shot keeps its scene
 * (and that scene's id, approvals and effects) across syncs, a shot that
 * disappeared takes its scene with it, and a scene the film never made is a
 * conflict unless the sync is told to replace the Board. Every change goes
 * through the Board's own transforms, so ids, order and approval staleness
 * behave as they do for a director's edit. Pure.
 */
import { sungLyricTextWithin } from '../../../lib/musicVideoLyricAnchors.js';
import { normalizeBlenderRecord } from '../../../lib/musicVideoBlender.js';
import { addScenes, applySceneUpdate, removeScene } from '../projectsLogic.js';
import { carryShotLocks } from '../productionReview.js';
import { blenderRefusal } from './workspace.js';

const clip = (text, max) => (typeof text === 'string' && text.trim() ? text.trim().slice(0, max) : null);

/** What a Board scene shows for `shot`. */
function blenderSceneFields(shot) {
  return {
    label: clip(shot.label, 120) || shot.id,
    startSec: shot.start,
    endSec: shot.end,
    visualIntent: clip(shot.action, 2000) || clip(shot.summary, 2000),
    prompt: clip(shot.summary, 8000) || '',
    framePrompt: clip(shot.staging, 8000),
    visualLayer: 'code',
    beatAligned: true,
  };
}

/** The Board scenes no shot of the film is mapped to. */
export function unmirroredScenes(project) {
  const mapped = new Set(Object.values(normalizeBlenderRecord(project.blender).sceneMap));
  return (project.scenes || []).filter((scene) => !mapped.has(scene.sceneId));
}

export const scenesConflict = (scenes) => blenderRefusal(
  `The Board has ${scenes.length} ${scenes.length === 1 ? 'shot' : 'shots'} that did not come from the Blender film. Syncing replaces them with the film's shots; confirm to replace them.`,
  'MUSIC_VIDEO_BLENDER_SCENES_CONFLICT', 409,
  { scenes: scenes.slice(0, 50).map(({ sceneId, label }) => ({ sceneId, label: label || '' })), count: scenes.length },
);

/**
 * Apply `shots` to `project`'s Board. Returns `{ project, sceneMap }`; throws
 * 409 MUSIC_VIDEO_BLENDER_SCENES_CONFLICT when the Board holds scenes the film
 * did not make and `replaceScenes` is not set.
 */
export function mirrorBlenderScenes(project, shots, { replaceScenes = false } = {}) {
  const live = new Set((project.scenes || []).map((scene) => scene.sceneId));
  const prior = Object.entries(normalizeBlenderRecord(project.blender).sceneMap).filter(([, sceneId]) => live.has(sceneId));
  const strangers = unmirroredScenes(project);
  if (strangers.length && !replaceScenes) throw scenesConflict(strangers);
  const wanted = new Set(shots.map((shot) => shot.id));
  let next = project;
  for (const scene of strangers) next = removeScene(next, scene.sceneId);
  for (const [shotId, sceneId] of prior) if (!wanted.has(shotId)) next = removeScene(next, sceneId);
  const mapped = new Map(prior.filter(([shotId]) => wanted.has(shotId)));
  const sceneMap = {};
  for (const shot of shots) {
    const fields = blenderSceneFields(shot);
    const sceneId = mapped.get(shot.id);
    if (!sceneId) {
      const timed = (next.lyricCues || []).some((cue) => typeof cue?.startSec === 'number');
      const added = addScenes(next, [{ ...fields, lyricText: timed ? sungLyricTextWithin(next.lyricCues, shot.start, shot.end) : null }]);
      next = carryShotLocks(next, added.project);
      sceneMap[shot.id] = added.scenes[0].sceneId;
      continue;
    }
    // Only what changed is patched, so a sync that changes nothing leaves the approvals alone.
    const scene = next.scenes.find((candidate) => candidate.sceneId === sceneId);
    const patch = Object.fromEntries(Object.entries(fields).filter(([key, value]) => (scene[key] ?? null) !== (value ?? null)));
    if (Object.keys(patch).length) next = applySceneUpdate(next, sceneId, patch).project;
    sceneMap[shot.id] = sceneId;
  }
  // The Board runs in song order, each scene keeping its own time.
  const ordered = [...next.scenes].sort((a, b) => (a.startSec ?? Infinity) - (b.startSec ?? Infinity));
  if (ordered.some((scene, index) => scene !== next.scenes[index] || scene.order !== index)) {
    next = { ...next, scenes: ordered.map((scene, index) => (scene.order === index ? scene : { ...scene, order: index })) };
  }
  return { project: next, sceneMap };
}
