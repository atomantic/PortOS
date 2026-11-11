/**
 * Writes to a project's install-local `blender` field: render settings and the
 * director's per-shot notes. The field never crosses the peer wire and is not
 * accepted by the project PATCH; every write goes through `mutateProjectRecord`
 * so it merges against the freshest record. It stays small on purpose: render
 * progress, the render index, cuts and job history live on disk or in memory.
 */
import { blenderOptionValueProblem, normalizeBlenderRecord } from '../../../lib/musicVideoBlender.js';
import { mutateProjectRecord } from '../projects.js';
import { musicVideoEvents } from '../events.js';
import { assertBlenderShotId, blenderRefusal } from './workspace.js';
import { readBlenderManifest } from './manifest.js';

/** Tell open Blender film panels that this project's state changed outside a job. */
export const announceBlenderState = (projectId) => musicVideoEvents.emit('blender', { projectId, kind: 'state' });

const withBlender = (project, change) => {
  const blender = normalizeBlenderRecord(project.blender);
  return { ...project, blender: { ...blender, ...change(blender) }, updatedAt: new Date().toISOString() };
};

/**
 * Check a film-option save against what the synced film declares. A key the
 * film does not declare or a value its option does not accept is refused
 * whole (400), never coerced; `null` clears a saved value.
 */
async function assertBlenderOptionValues(projectId, values) {
  const manifest = await readBlenderManifest(projectId);
  if (!manifest) throw blenderRefusal('Sync shots from scripts first: a film declares its options there', 'MUSIC_VIDEO_BLENDER_NOT_SYNCED', 409);
  const declared = new Map(manifest.options.map((option) => [option.key, option]));
  const errors = Object.entries(values).flatMap(([key, value]) => {
    const option = declared.get(key);
    if (!option) return [`"${key}" is not an option of this film`];
    const problem = value === null ? null : blenderOptionValueProblem(option, value);
    return problem ? [`"${key}" ${problem}`] : [];
  });
  if (errors.length) {
    throw blenderRefusal(`That film option was refused: ${errors[0]}${errors.length > 1 ? ` (and ${errors.length - 1} more)` : ''}`, 'MUSIC_VIDEO_BLENDER_OPTION_INVALID', 400, { errors });
  }
}

/** Merge a partial settings save over the stored settings; `options` merges key by key. */
export async function saveBlenderSettings(projectId, { options = null, ...fields }) {
  if (options) await assertBlenderOptionValues(projectId, options);
  const { project } = await mutateProjectRecord(projectId, (current) => ({
    project: withBlender(current, (blender) => {
      const merged = { ...blender.settings.options, ...options };
      return { settings: { ...blender.settings, ...fields, options: Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== null)) } };
    }),
  }));
  announceBlenderState(projectId);
  return project;
}

/** Save the director's note or review status on one manifest shot. */
export async function saveBlenderShotNote(projectId, shotId, { text, status }) {
  assertBlenderShotId(shotId);
  const manifest = await readBlenderManifest(projectId);
  if (!manifest?.shots.some((shot) => shot.id === shotId)) {
    throw blenderRefusal('That shot is not in the synced film; sync shots from scripts first', 'NOT_FOUND', 404);
  }
  const { project } = await mutateProjectRecord(projectId, (current) => ({
    project: withBlender(current, (blender) => {
      const prior = blender.notes[shotId] || {};
      return { notes: { ...blender.notes, [shotId]: {
        text: text ?? prior.text ?? '', status: status ?? prior.status ?? 'todo', updatedAt: new Date().toISOString(),
      } } };
    }),
  }));
  announceBlenderState(projectId);
  return project;
}
