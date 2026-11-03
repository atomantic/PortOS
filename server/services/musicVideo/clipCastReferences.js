/**
 * The character sheets a Music Video shot's Grok clip carries beside its still
 * (videoGen/grok.js sends them to reference_to_video). The still fixes the
 * opening frame; these keep the people the same once the clip moves past it,
 * as when a hidden face turns into view. They are the identity
 * references the shot's still was conditioned on (productionDispatch.js), set
 * plates and the storyboard panel left out: the still already holds the place.
 */

import { resolveGalleryImage, resolveImageInputPath } from '../../lib/pathSafety.js';
import { MUSIC_VIDEO_GROK_CLIP_REFERENCE_LIMIT, MUSIC_VIDEO_MAX_REFERENCE_CHOICES, musicVideoClipConditioningReferences, musicVideoClipReferenceChoices } from '../../lib/musicVideoConditioning.js';
import { ServerError } from '../../lib/errorHandler.js';
import { loadSceneCastMedia } from './castGuideMedia.js';

/** Ordered references for a tagged shot, resolved once before the job is queued. */
export async function musicVideoClipReferences({ projectId, sceneId } = {}, limit = MUSIC_VIDEO_MAX_REFERENCE_CHOICES, { excludePath = null } = {}) {
  if (!projectId || !sceneId || limit < 1) return [];
  const { getProject } = await import('./projects.js');
  const project = await getProject(projectId);
  const scene = project?.scenes?.find((entry) => entry.sceneId === sceneId);
  if (!scene) return [];
  const castMedia = await loadSceneCastMedia(scene);
  const choices = musicVideoClipReferenceChoices(project, scene, castMedia);
  if (Array.isArray(scene.clipReferenceIds) && scene.clipReferenceIds.some((id) => !choices.some((ref) => ref.id === id))) {
    throw new ServerError('A selected clip reference is unavailable. Restore it or reset the clip references.', { status: 409, code: 'MUSIC_VIDEO_CLIP_REFERENCE_MISSING' });
  }
  const references = musicVideoClipConditioningReferences(project, scene, castMedia);
  const resolved = [];
  for (const ref of references) {
    if (resolved.length >= limit) break;
    const path = ref.castGuide ? resolveImageInputPath(ref.imageId) : resolveGalleryImage(ref.imageId);
    if (!path) throw new ServerError(`The clip reference ${ref.label || ref.imageId} is missing. Restore it or select another.`,
      { status: 409, code: 'MUSIC_VIDEO_CLIP_REFERENCE_MISSING' });
    if (path === excludePath || resolved.some((item) => item.path === path)) continue;
    resolved.push({ path, label: ref.label || '', ...(ref.role && ref.role !== 'character' ? { role: ref.role } : {}) });
  }
  return resolved;
}

/** The Grok CLI does not expose its video-model id; use the older model's cap. */
export const musicVideoClipCastReferences = (tag) => musicVideoClipReferences(tag, MUSIC_VIDEO_GROK_CLIP_REFERENCE_LIMIT);

/**
 * Resolved paths of the shot's cast sheets for a local reference-to-video model
 * (`maxReferenceImages` counts the source still first, so `limit` is the rest):
 * the still provides the scene reference and these help preserve its cast.
 */
export async function musicVideoLocalReferencePaths({ projectId, sceneId } = {}, limit = 0, { excludePath = null } = {}) {
  const references = await musicVideoClipReferences({ projectId, sceneId }, limit, { excludePath });
  return references.map((ref) => ref.path);
}
