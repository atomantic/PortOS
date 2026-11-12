/** Music Video owns persistence, song context, Board integration and socket routing. */
import { join } from 'node:path';
import { PATHS } from '../../../lib/paths.js';
import { normalizeBlenderRecord } from '../../../lib/musicVideoBlender.js';
const requireProject = async (id) => (await import('../requireProject.js')).requireProject(id);
const mutateProjectRecord = async (...args) => (await import('../projects.js')).mutateProjectRecord(...args);
import { musicVideoEvents } from '../events.js';
import { getBlenderSong } from './song.js';
import { mirrorBlenderScenes, scenesConflict, unmirroredScenes } from './sceneMirror.js';
import { blenderRefusal } from '../../film/workspace.js';

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
      return { durationSec: project.audioAnalysis?.durationSec, fps: normalizeBlenderRecord(project.blender).settings.fps };
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
