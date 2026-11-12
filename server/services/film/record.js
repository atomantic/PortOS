/** Settings and shot notes live in the owner record; writes merge atomically there. */
import { blenderOptionValueProblem, normalizeBlenderRecord } from '../../lib/musicVideoBlender.js';
import { assertBlenderShotId, blenderRefusal } from './workspace.js';
import { readBlenderManifest } from './manifest.js';

/** Tell open Blender film panels that this project's state changed outside a job. */
export const announceBlenderState = (owner) => owner.emit({ kind: 'state' });

/**
 * Check a film-option save against what the synced film declares. A key the
 * film does not declare or a value its option does not accept is refused
 * whole (400), never coerced; `null` clears a saved value.
 */
async function assertBlenderOptionValues(owner, values) {
  const manifest = await readBlenderManifest(owner);
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
export async function saveBlenderSettings(owner, { options = null, ...fields }) {
  if (options) await assertBlenderOptionValues(owner, options);
  const record = await owner.writeRecord((current) => {
    const blender = normalizeBlenderRecord(current);
    const merged = { ...blender.settings.options, ...options };
    return { settings: { ...blender.settings, ...fields, options: Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== null)) } };
  });
  announceBlenderState(owner);
  return record;
}

/** Save the director's note or review status on one manifest shot. */
export async function saveBlenderShotNote(owner, shotId, { text, status }) {
  assertBlenderShotId(shotId);
  const manifest = await readBlenderManifest(owner);
  if (!manifest?.shots.some((shot) => shot.id === shotId)) {
    throw blenderRefusal('That shot is not in the synced film; sync shots from scripts first', 'NOT_FOUND', 404);
  }
  const record = await owner.writeRecord((current) => {
    const blender = normalizeBlenderRecord(current);
    const prior = blender.notes[shotId] || {};
    return { notes: { ...blender.notes, [shotId]: {
      text: text ?? prior.text ?? '', status: status ?? prior.status ?? 'todo', updatedAt: new Date().toISOString(),
    } } };
  });
  announceBlenderState(owner);
  return record;
}
