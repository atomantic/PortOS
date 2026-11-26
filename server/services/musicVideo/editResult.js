/**
 * The reply a Music Video board edit sends instead of the whole project (#16247):
 * what changed between the record as `GET /:id` presented it before and after.
 *
 * `edit` fields: `updatedAt` (saved revision); `baseUpdatedAt` (revision the diff
 * was taken from; a tab on any other revision reloads instead of applying);
 * `sceneIds` (board shot order, a missing shot is gone); `scenes` (presented shots
 * that changed or are new, incl. neighbours whose time or take staleness moved);
 * `project` (other changed top-level presented fields); `removed` (fields no
 * longer present). Client side: server/lib/musicVideo/musicVideoEditResult.js.
 */

import { presentProjectRecord, readPresentationInputs } from './projectPresentation.js';

// Reference equality first: avoid serializing large fields (review history).
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

function diffPresentedProjects(before, after) {
  const earlier = new Map((before?.scenes || []).map((scene) => [scene.sceneId, scene]));
  const scenes = (after.scenes || []).filter((scene) => !same(earlier.get(scene.sceneId), scene));
  const project = {};
  for (const key of Object.keys(after)) if (key !== 'scenes' && !same(before?.[key], after[key])) project[key] = after[key];
  const removed = Object.keys(before || {}).filter((key) => key !== 'scenes' && !Object.hasOwn(after, key));
  return { updatedAt: after.updatedAt ?? null, baseUpdatedAt: before?.updatedAt ?? null, sceneIds: (after.scenes || []).map((scene) => scene.sceneId), scenes, project, removed };
}

// `before` -> `after` are stored records with their catalog check-in resolved
// (`mutateProjectRecord` with `{ edit }`); machine-local reads come once from `after`.
// `beforeBoardUndo` carries the undo summary that was visible before this edit changed the stack.
export async function presentEditResult({ before, after, beforeBoardUndo }) {
  const inputs = await readPresentationInputs(after);
  const beforeInputs = beforeBoardUndo === undefined ? inputs : { ...inputs, boardUndo: beforeBoardUndo };
  return diffPresentedProjects(presentProjectRecord(before, beforeInputs), presentProjectRecord(after, inputs));
}
