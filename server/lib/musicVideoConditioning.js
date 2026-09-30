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
