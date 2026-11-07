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
  const resolve = deps.resolveImage || resolveImageInputPath;
  const path = result?.reference && resolve(result.reference.imageId);
  const blockingPath = result?.blocking && resolve(result.blocking.imageId);
  const missing = !path ? 'Greybox reference: the capture file is missing. Capture the saved camera again or clear the selection.'
    : result.blocking && !blockingPath ? 'Greybox reference: the figure blocking capture is missing. Capture the saved camera again or turn off figure blocking.' : null;
  if (result?.error || missing) {
    throw new ServerError(result?.error || missing, {
      status: 422, code: 'MUSIC_VIDEO_GREYBOX_UNAVAILABLE', context: { sceneId: scene.sceneId },
    });
  }
  return { ...result, path, ...(blockingPath ? { blockingPath } : {}) };
}

/**
 * A clip animating its start frame never takes the plate: the frame already holds the
 * set, and a clip sends only that frame and the references picked for it. A clip with
 * no start frame gets the selected layout before other plates; unsupported video
 * backends refuse it.
 */
export async function withMusicVideoGreyboxInput(body, project) {
  if (!body.musicVideo?.sceneId || body.sourceImageFile) return body;
  const scene = project?.scenes?.find((s) => s.sceneId === body.musicVideo.sceneId);
  const greybox = await loadMusicVideoGreybox(project, scene);
  return greybox ? { ...body, referenceImageFiles: [...new Set([greybox.reference.imageId, ...(body.referenceImageFiles || [])])] } : body;
}
