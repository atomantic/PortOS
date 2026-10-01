import { isEditCapableMode, maxInputImages } from './imageGenCapabilities.js';
import { RUNNER_FAMILIES } from './runners.js';

/** Browser-safe reference selection shared by the board and production lanes. */
export const MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES = 4;

export function musicVideoConditioningReferences(project, scene) {
  const references = project?.visualSpec?.references || [];
  const stage = project?.castAndSets;
  if (stage?.status === 'approved' && Number.isInteger(scene?.sectionIndex)) {
    const setId = stage.direction?.songMap?.find((entry) => entry.section === scene.sectionIndex)?.setId;
    const character = references.find((ref) => ref?.id === 'mvr-cs-character' && ref.imageId);
    const plate = setId && references.find((ref) => ref?.id === `mvr-cs-set-${setId}` && ref.imageId);
    // Check-in plates beyond the project-wide cap are still available for their
    // own scenes. Their condition flag reflects that cap, not scene relevance.
    if (character && plate) return [character, plate];
  }
  // Legacy projects and incomplete check-ins retain the authored reference set.
  return references.filter((ref) => ref?.condition && ref.imageId)
    .slice(0, MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES);
}

/** Style images fill spare slots after identities; never displace a character or set. */
export function musicVideoStyleReferenceCapacity(mode, localModel) {
  if (!isEditCapableMode(mode)) return 0;
  if (mode === 'local') {
    if (localModel?.pipelineClass === 'QwenImage21Pipeline') return 10;
    return localModel?.runner === RUNNER_FAMILIES.FLUX2 ? 4 : 0;
  }
  return Math.min(4, maxInputImages(mode) ?? 4);
}

export const musicVideoStyleBasis = (project) => JSON.stringify(project?.styleReferences || []);

export function musicVideoStylePrompt(project, referenceCount = 0) {
  const refs = project?.styleReferences || [];
  if (!refs.length) return '';
  const treatment = project?.treatment;
  const look = treatment?.styleReferencesBasis === musicVideoStyleBasis(project) && treatment?.styleLook
    ? treatment.styleLook : refs.map((r) => r.caption?.trim()).filter(Boolean).join('; ').slice(0, 1000);
  return `${referenceCount ? `The last ${referenceCount} reference images supply style, after the identity references. ` : ''}Moodboard style only (palette, lighting, lens language and grain; never copy its subjects, locations or poses)${look ? `: ${look}` : ''}`;
}

export function musicVideoStyleImages(project, identityImages, capacity) {
  const seen = new Set(identityImages);
  const available = Math.max(0, capacity - identityImages.length);
  return (project?.styleReferences || []).filter((ref) => {
    if (!ref?.imageId || seen.has(ref.imageId)) return false;
    seen.add(ref.imageId);
    return true;
  }).slice(0, available).map((r) => r.imageId);
}
