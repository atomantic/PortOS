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
import { normalizePreMusic } from '../../../lib/musicVideoColdOpen.js';
import { addScenes, applySceneUpdate, removeScene } from '../projectsLogic.js';
import { carryShotLocks } from '../productionReview.js';
import { blenderRefusal } from '../../film/workspace.js';
import { blenderLeadShots } from './manifest.js';

const clip = (text, max) => (typeof text === 'string' && text.trim() ? text.trim().slice(0, max) : null);

/** What a Board scene shows for `shot`. A lead-in has no song span: the Board stores it as a cold open of the shot's length. */
function blenderSceneFields(shot, scene) {
  const lead = shot.start < 0;
  return {
    label: clip(shot.label, 120) || shot.id,
    startSec: lead ? null : shot.start,
    endSec: lead ? null : shot.end,
    visualIntent: clip(shot.action, 2000) || clip(shot.summary, 2000),
    prompt: clip(shot.summary, 8000) || '',
    framePrompt: clip(shot.staging, 8000),
    visualLayer: 'code',
    beatAligned: true,
    ...(lead ? { preMusic: normalizePreMusic({ ...(scene?.preMusic || {}), durationSec: Number((shot.end - shot.start).toFixed(6)) }) } : {}),
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
    const sceneId = mapped.get(shot.id);
    const scene = sceneId ? next.scenes.find((candidate) => candidate.sceneId === sceneId) : null;
    const fields = blenderSceneFields(shot, scene);
    if (!sceneId) {
      const lyricText = shot.start < 0 ? null
        : ((next.lyricCues || []).some((cue) => typeof cue?.startSec === 'number') ? sungLyricTextWithin(next.lyricCues, shot.start, shot.end) : null);
      const added = addScenes(next, [{ ...fields, lyricText }]);
      next = carryShotLocks(next, added.project);
      sceneMap[shot.id] = added.scenes[0].sceneId;
      continue;
    }
    // Only what changed is patched, so a sync that changes nothing leaves the approvals alone.
    // preMusic is compared normalized: a shallow compare would rewrite the cold open on every sync.
    const patch = {};
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'preMusic') {
        if (JSON.stringify(normalizePreMusic(scene.preMusic)) !== JSON.stringify(value)) patch.preMusic = value;
        continue;
      }
      if ((scene[key] ?? null) !== (value ?? null)) patch[key] = value;
    }
    if (shot.start < 0) {
      if (scene.lyricText) patch.lyricText = null;
    } else if (scene.preMusic) patch.preMusic = null;
    if (Object.keys(patch).length) next = applySceneUpdate(next, sceneId, patch).project;
    sceneMap[shot.id] = sceneId;
  }
  // Lead-in scenes have no song time, so they sort ahead of the song. With no lead-in this is song order.
  const leadOrder = new Map(blenderLeadShots(shots).map((shot, index) => [sceneMap[shot.id], index]));
  const ordered = [...next.scenes].sort((a, b) => {
    const ai = leadOrder.get(a.sceneId);
    const bi = leadOrder.get(b.sceneId);
    if (ai != null || bi != null) return (ai ?? Infinity) - (bi ?? Infinity);
    return (a.startSec ?? Infinity) - (b.startSec ?? Infinity);
  });
  if (ordered.some((scene, index) => scene !== next.scenes[index] || scene.order !== index)) {
    next = { ...next, scenes: ordered.map((scene, index) => (scene.order === index ? scene : { ...scene, order: index })) };
  }
  return { project: next, sceneMap };
}
