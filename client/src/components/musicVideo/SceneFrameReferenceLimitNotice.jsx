import {
  MUSIC_VIDEO_MAX_REFERENCE_CHOICES, musicVideoConditioningReferences, musicVideoFrameReferenceFiles,
  musicVideoLimitReferenceFiles, musicVideoReferenceCapacity, musicVideoStyleImages,
} from '../../../../server/lib/musicVideoConditioning.js';

/** A conditional preview: the server still resolves the actual renderer at submission. */
export default function SceneFrameReferenceLimitNotice({ project, scene, castMedia, greybox, sourceImageId = null }) {
  const auto = !Array.isArray(scene.frameReferenceIds);
  const choices = musicVideoConditioningReferences(project, scene, castMedia, greybox, { limit: MUSIC_VIDEO_MAX_REFERENCE_CHOICES + 1 });
  const requested = musicVideoFrameReferenceFiles(sourceImageId,
    musicVideoConditioningReferences(project, scene, castMedia, greybox), MUSIC_VIDEO_MAX_REFERENCE_CHOICES, { reservePanel: auto });
  const greyboxIndex = greybox?.reference ? requested.indexOf(greybox.reference.imageId) : -1;
  const capacity = musicVideoReferenceCapacity('codex');
  const retained = musicVideoLimitReferenceFiles(requested, capacity, {
    panelImageId: auto ? scene.panelArt : null,
    protectedCount: Math.max(sourceImageId && requested.length ? 1 : 0, greyboxIndex + 1),
  });
  // Compare occurrences, not just filenames: different selected chips can
  // legitimately point at the same image. Every chip matching the source is
  // covered by the single leading frame, which the renderer does not repeat.
  const remaining = [...retained];
  const omitted = choices.filter((ref) => {
    if (sourceImageId && ref.imageId === sourceImageId && retained.includes(sourceImageId)) return false;
    const index = remaining.indexOf(ref.imageId);
    if (index < 0) return true;
    remaining.splice(index, 1);
    return false;
  });
  const styleInputs = musicVideoStyleImages(project, retained, capacity);
  const known = new Set([...retained, ...styleInputs, ...omitted.map((ref) => ref.imageId)]);
  const omittedStyles = (project.styleReferences || []).filter((ref) => {
    if (!ref?.imageId || known.has(ref.imageId)) return false;
    known.add(ref.imageId);
    return true;
  });
  const labels = [...omitted.map((ref) => ref.label || ref.role || ref.imageId),
    ...omittedStyles.map((ref) => `mood-board image ${ref.imageId}`)];
  if (!labels.length) return null;
  return (
    <p role="status" className="text-xs text-port-warning">
      If this frame uses Codex, its {capacity}-image limit leaves out: {labels.join(', ')}.
    </p>
  );
}
