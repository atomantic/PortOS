/**
 * The reply a Music Video board edit sends instead of the whole project (#16247): what changed
 * between the record as `GET /:id` presented it before the edit and as it presents it now.
 *
 * Shape (`edit` on every board edit reply):
 * - `updatedAt`: the saved record's revision.
 * - `baseUpdatedAt`: the revision the diff was taken from. A tab showing any other revision is
 *   missing a change the diff assumes (another writer, or a take decision patched in without its
 *   read-time effects), so it reloads instead of applying it.
 * - `sceneIds`: the board's shot order after the edit; a shot missing from it is gone.
 * - `scenes`: each shot, presented, whose presentation changed (its own fields, its takes'
 *   staleness) or that is new. A neighbour whose time moved or whose takes went stale is here too.
 * - `project`: every other top-level presented field that changed (readiness, final-video staleness,
 *   review state…), so the board never shows approval or readiness a reload would not.
 * - `removed`: top-level fields the presentation no longer carries.
 *
 * A diff is only correct against the record it was taken from, so the client applies it only when
 * it is not older than what it shows, and reloads otherwise (server/lib/musicVideoEditResult.js, re-exported to the client).
 */

import { presentProjectRecord, readPresentationInputs } from './projectPresentation.js';

// Reference equality first: unchanged fields usually keep their object across an edit, and the
// large ones (the review history) must not be serialized just to learn they did not change.
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** The edit result between two presented records of one project. */
function diffPresentedProjects(before, after) {
  const earlier = new Map((before?.scenes || []).map((scene) => [scene.sceneId, scene]));
  const scenes = (after.scenes || []).filter((scene) => !same(earlier.get(scene.sceneId), scene));
  const project = {};
  for (const key of Object.keys(after)) if (key !== 'scenes' && !same(before?.[key], after[key])) project[key] = after[key];
  const removed = Object.keys(before || {}).filter((key) => key !== 'scenes' && !Object.hasOwn(after, key));
  return { updatedAt: after.updatedAt ?? null, baseUpdatedAt: before?.updatedAt ?? null, sceneIds: (after.scenes || []).map((scene) => scene.sceneId), scenes, project, removed };
}

/**
 * The edit result for `before` → `after`, both stored records with their catalog check-in resolved
 * (projects.js `mutateProjectRecord` with `{ edit }` fills them). The machine-local reads are taken
 * once from `after`: shot edits do not change the film's renders or the song's audio.
 */
export async function presentEditResult({ before, after }) {
  const inputs = await readPresentationInputs(after);
  return diffPresentedProjects(presentProjectRecord(before, inputs), presentProjectRecord(after, inputs));
}
