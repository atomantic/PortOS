/**
 * `applyMusicVideoEdit(project, edit, { keep })` folds a Music Video board edit's reply (`edit`) into the open project, or returns null when it cannot.
 *
 * The server answers a board edit with what changed between the record `GET /:id` presented before
 * the edit and the one it presents now (services/musicVideo/editResult.js): `updatedAt`,
 * `sceneIds` (the shot order), the changed `scenes` presented, the other changed top-level `project`
 * fields (readiness, approvals, final staleness) and the `removed` ones. Applied to the record it
 * was taken from, it gives exactly what a reload would show. The client and the server's reload-parity tests import this pure leaf.
 *
 * A diff is only safe against that record. Null means "reload instead": the reply is older than what
 * the page shows (a later change already landed), it was taken from a revision other than the one
 * the page shows (`baseUpdatedAt`: a change the page has not fully applied came between), it is
 * malformed, or it names a shot the page does not have and did not send. `keep` maps a sceneId to
 * the fields typed locally and not yet saved, which stay as typed, as they do across a reload.
 */

/** The ordering guard on its own: an edit is not applied over a newer record. */
const editIsCurrent = (project, edit) => !project?.updatedAt || !edit?.updatedAt || edit.updatedAt >= project.updatedAt;

export function applyMusicVideoEdit(project, edit, { keep = null } = {}) {
  if (!project || !edit || !Array.isArray(edit.sceneIds) || !Array.isArray(edit.scenes)) return null;
  if (!editIsCurrent(project, edit)) return null;
  if (edit.baseUpdatedAt && project.updatedAt && edit.baseUpdatedAt !== project.updatedAt) return null;
  const local = new Map((project.scenes || []).map((scene) => [scene.sceneId, scene]));
  const changed = new Map(edit.scenes.map((scene) => [scene.sceneId, scene]));
  const scenes = [];
  for (const sceneId of edit.sceneIds) {
    const saved = changed.get(sceneId);
    const mine = local.get(sceneId);
    if (!saved) {
      if (!mine) return null;
      scenes.push(mine);
      continue;
    }
    const typed = mine && keep?.get(sceneId);
    if (!typed?.size) { scenes.push(saved); continue; }
    const merged = { ...saved };
    for (const field of typed) merged[field] = mine[field];
    scenes.push(merged);
  }
  const next = { ...project, ...(edit.project || {}), scenes, ...(edit.updatedAt ? { updatedAt: edit.updatedAt } : {}) };
  for (const key of edit.removed || []) delete next[key];
  return next;
}
