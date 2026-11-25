/** Preview URLs for original and deterministically treated shot images. */

import { shotImageTreatment } from '../../../../server/lib/musicVideo/musicVideoImageTreatments.js';

export const originalShotImageUrl = (imageId) => `/data/images/${encodeURIComponent(imageId)}`;

export function shotTreatmentUrl(projectId, sceneId, imageId, treatment) {
  if (!projectId || !treatment) return originalShotImageUrl(imageId);
  const root = `/api/music-video/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/image-treatment`;
  return `${root}?${new URLSearchParams({ treatment: JSON.stringify(treatment) })}`;
}

export function shotImageUrl(projectId, scene, imageId) {
  return shotTreatmentUrl(projectId, scene.sceneId, imageId, shotImageTreatment(scene, imageId));
}
