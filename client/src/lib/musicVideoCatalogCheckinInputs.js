/**
 * A string that changes exactly when the catalog check-in or a shot reference warning can change, so the page re-reads Cast & Sets only then.
 *
 * Mirrors what `GET /:id/cast-and-sets` reads from the stored project (server/services/musicVideo/catalogCheckin.js,
 * shotReferenceCheck.js and the scene readers in server/lib/musicVideo/musicVideoConditioning.js). The catalog records
 * themselves are not here: catalog socket events refresh the read. A field the check might read belongs in
 * this signature; leaving one out leaves a warning stale after the edit that should have changed it, while an
 * extra one only costs a read. Deliberately left out: Done (`shotSheet.checked`), take status and notes, film
 * look, render settings and timing, except where timing reorders the shot numbers the warnings name.
 */
import { shotNumbers } from '../../../server/lib/musicVideo/musicVideoColdOpen.js';

// Scene fields the check reads as they are.
const SCENE_FIELDS = [
  'sceneId', 'label', 'description', 'framePrompt', 'prompt', 'visualIntent', 'endFramePrompt', 'endFrameOff',
  'sectionIndex', 'setReference', 'characterVariant', 'frameReferenceIds', 'clipReferenceIds', 'omittedCatalogSubjectIds',
  'researchReferences', 'panelArt', 'panelId', 'cameoId', 'cameoVariantId',
];
const FRAME_TAKE_KINDS = new Set(['image', 'endImage']);

function sceneInputs(scene, hasProps) {
  const { checked: _done, ...sheet } = scene?.shotSheet || {};
  const inputs = Object.fromEntries(SCENE_FIELDS.map((field) => [field, scene?.[field] ?? null]));
  // Automatic clip picks leave out a reference that is the start frame; that only reaches a warning through
  // the prop check, which runs when the frame picks are explicit (shotReferenceCheck.js).
  const startFrameRead = hasProps && Array.isArray(scene?.frameReferenceIds) && !Array.isArray(scene?.clipReferenceIds);
  return {
    ...inputs,
    shotSheet: scene?.shotSheet ? sheet : null,
    frameClause: scene?.direction?.frameClause ?? null,
    motionClause: scene?.direction?.motionClause ?? null,
    ...(startFrameRead ? { referenceImageId: scene?.referenceImageId ?? null } : {}),
  };
}

/**
 * Every still a shot uses or has rendered, project-wide: a plate made from one of them is reported as
 * shot-derived. Choosing, rejecting or restoring a take only moves the selection inside this set.
 */
function shotFrameIds(scenes) {
  const ids = new Set();
  for (const scene of scenes) {
    for (const id of [scene?.referenceImageId, scene?.endImageId, ...(scene?.photoSequence?.imageIds || [])]) if (id) ids.add(id);
    for (const take of Array.isArray(scene?.takes) ? scene.takes : []) if (FRAME_TAKE_KINDS.has(take?.kind) && take.assetId) ids.add(take.assetId);
  }
  return [...ids].sort();
}

/** The inputs of a project's Cast & Sets read, as one comparable string. */
export function musicVideoCatalogCheckinInputs(project) {
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  const { catalogCheckin: _resolved, ...castAndSets } = project?.castAndSets || {};
  const hasProps = (project?.concept?.subjects || []).some((subject) => subject?.kind === 'object');
  return JSON.stringify({
    id: project?.id ?? null,
    // The resolved check-in is this read's own answer, so it is left out.
    castAndSets,
    concept: project?.concept ?? null,
    references: project?.visualSpec?.references ?? null,
    cameos: project?.cameos ?? null,
    media: [project?.mediaMode ?? null, project?.automation?.tools ?? null, project?.tools ?? null],
    song: [project?.trackId ?? null, project?.uploadedAudioFilename ?? null],
    scenes: scenes.map((scene) => sceneInputs(scene, hasProps)),
    numbers: [...shotNumbers(project)],
    frames: shotFrameIds(scenes),
  });
}
