/** Music Video owns persistence, song context, Board integration and socket routing. */
import { join } from 'node:path';
import { PATHS } from '../../../lib/paths.js';
import { blenderShotFrameRange, normalizeBlenderRecord } from '../../../lib/musicVideoBlender.js';
import { blenderCutEffects, plannedTransitions, sceneCutEffect } from '../../../lib/musicVideoCutEffects.js';
import { musicVideoEvents } from '../events.js';
import { getBlenderSong } from './song.js';
import { mirrorBlenderScenes, scenesConflict, unmirroredScenes } from './sceneMirror.js';
import { blenderRefusal } from '../../film/workspace.js';

// Resolve project storage only for record operations; path-only adapters stay cheap.
const requireProject = async (id) => (await import('../requireProject.js')).requireProject(id);
const mutateProjectRecord = async (...args) => (await import('../projects.js')).mutateProjectRecord(...args);

function musicVideoFilmCutEffects(project, manifest, record) {
  const shots = manifest?.shots;
  if (!Array.isArray(shots) || !shots.length) return [];
  const fps = record.settings.fps;
  const byId = new Map((project.scenes || []).filter((scene) => scene?.sceneId).map((scene) => [scene.sceneId, scene]));
  const planned = plannedTransitions(project.productionReview?.draft?.storyboard);
  const mapped = shots.map((shot) => {
    const sceneId = record.sceneMap?.[shot.id];
    const scene = (sceneId && byId.get(sceneId)) || byId.get(shot.id) || null;
    const cutEffect = scene ? sceneCutEffect(scene, planned.get(scene.sceneId)) : null;
    return { id: shot.id, ...blenderShotFrameRange(shot, fps), cutEffect };
  });
  return blenderCutEffects(mapped, { fps, beats: project.audioAnalysis?.beats || [] });
}

export function musicVideoFilmOwner(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
    throw blenderRefusal('Invalid project id', 'VALIDATION_ERROR');
  }
  return {
    kind: 'music-video', id,
    workspaceDir: join(PATHS.data, 'music-video', id, 'blender'),
    workspaceLabel: `data/music-video/${id}/blender`,
    async timeline() {
      const project = await requireProject(id);
      const record = normalizeBlenderRecord(project.blender);
      return {
        durationSec: project.audioAnalysis?.durationSec,
        fps: record.settings.fps,
        cutEffects: (manifest) => musicVideoFilmCutEffects(project, manifest, record),
      };
    },
    async song() {
      const project = await requireProject(id);
      return getBlenderSong(project, normalizeBlenderRecord(project.blender).settings);
    },
    async readRecord() { return (await requireProject(id)).blender; },
    async writeRecord(change) {
      const { project } = await mutateProjectRecord(id, (current) => {
        const record = normalizeBlenderRecord(current.blender);
        return { project: { ...current, blender: { ...record, ...change(record) }, updatedAt: new Date().toISOString() } };
      });
      return project.blender;
    },
    async beforeSync({ replaceScenes }) {
      const project = await requireProject(id);
      const strangers = unmirroredScenes(project);
      if (strangers.length && !replaceScenes) throw scenesConflict(strangers);
    },
    async onSynced(manifest, { replaceScenes, change }) {
      await mutateProjectRecord(id, (current) => {
        const mirrored = mirrorBlenderScenes(current, manifest.shots, { replaceScenes });
        const record = normalizeBlenderRecord(mirrored.project.blender);
        return { project: { ...mirrored.project, updatedAt: manifest.syncedAt,
          blender: { ...record, ...change(record), sceneMap: mirrored.sceneMap } } };
      });
    },
    emit(event) { musicVideoEvents.emit('blender', { projectId: id, ...event }); },
  };
}
