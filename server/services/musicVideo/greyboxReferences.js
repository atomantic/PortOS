import { musicVideoGreyboxReference } from '../../lib/musicVideoGreybox.js';
import { ServerError } from '../../lib/errorHandler.js';
import { resolveImageInputPath } from '../../lib/pathSafety.js';

/** Read the live catalog and capture bytes immediately before generation. No provider work. */
export async function loadMusicVideoGreybox(project, scene, deps = {}) {
  if (!scene?.setReference?.greyboxShotId) return null;
  const subject = project?.concept?.subjects?.find((s) => s.id === scene.setReference.subjectId && s.kind === 'place');
  const places = {};
  if (subject?.ingredientId) {
    const catalog = deps.catalog || await import('../catalogDB.js');
    const [ingredient, media] = await Promise.all([catalog.getIngredient(subject.ingredientId), catalog.listMediaForIngredient(subject.ingredientId)]);
    places[subject.ingredientId] = { ingredient, media };
  }
  const result = musicVideoGreyboxReference(project, scene, places);
  const path = result?.reference && (deps.resolveImage || resolveImageInputPath)(result.reference.imageId);
  if (result?.error || !path) {
    throw new ServerError(result?.error || 'Greybox reference: the capture file is missing. Capture the saved camera again or clear the selection.', {
      status: 422, code: 'MUSIC_VIDEO_GREYBOX_UNAVAILABLE', context: { sceneId: scene.sceneId },
    });
  }
  return { ...result, path };
}

/** Add the selected layout before other plates; unsupported video backends refuse the input. */
export async function withMusicVideoGreyboxInput(body, project) {
  if (!body.musicVideo?.sceneId) return body;
  const scene = project?.scenes?.find((s) => s.sceneId === body.musicVideo.sceneId);
  const greybox = await loadMusicVideoGreybox(project, scene);
  return greybox ? { ...body, referenceImageFiles: [...new Set([greybox.reference.imageId, ...(body.referenceImageFiles || [])])] } : body;
}
