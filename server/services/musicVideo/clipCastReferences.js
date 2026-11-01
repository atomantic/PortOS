/**
 * The character sheets a Music Video shot's Grok clip carries beside its still
 * (videoGen/grok.js sends them to reference_to_video). The still fixes the
 * opening frame; these keep the people the same once the clip moves past it,
 * as when a hidden face turns into view. They are the identity
 * references the shot's still was conditioned on (productionDispatch.js), set
 * plates and the storyboard panel left out: the still already holds the place.
 */

import { resolveGalleryImage, resolveImageInputPath } from '../../lib/pathSafety.js';
import { musicVideoConditioningReferences } from '../../lib/musicVideoConditioning.js';
import { loadSceneCastMedia } from './castGuideMedia.js';

/** `[{ path, label }]` for the tagged shot's cast; empty when it has none or is gone. */
export async function musicVideoClipCastReferences({ projectId, sceneId } = {}) {
  if (!projectId || !sceneId) return [];
  const { getProject } = await import('./projects.js');
  const project = await getProject(projectId);
  const scene = project?.scenes?.find((entry) => entry.sceneId === sceneId);
  if (!scene) return [];
  const references = musicVideoConditioningReferences(project, scene, await loadSceneCastMedia(scene));
  return references
    .filter((ref) => ref.role === 'character' && !ref.panelArt && !ref.greybox)
    .map((ref) => ({ path: ref.castGuide ? resolveImageInputPath(ref.imageId) : resolveGalleryImage(ref.imageId), label: ref.label || '' }))
    .filter((ref) => ref.path);
}
