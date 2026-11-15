/**
 * Shared snapshot used to reject shot downloads based on unsaved inputs.
 */

import { resolveSourceTake } from './musicVideoSourceTake.js';

// Compare the displayed inputs with the persisted inputs before encoding.
// Source-take in-points are video time; startSec/endSec remain song time.
export function shotDownloadBasis(project, scene) {
  const source = resolveSourceTake(scene, project?.scenes);
  const fields = ['sceneId', 'videoHistoryId', 'startSec', 'endSec', 'sourceTake', 'speedFps', 'offsetFrames', 'reverse', 'loop', 'holdLastFrame', 'shotMode', 'visualLayer', 'frameFit', 'referenceImageId', 'takes', 'camera'];
  const shot = Object.fromEntries(fields.map((field) => [field, scene?.[field] ?? null]));
  return JSON.stringify({ shot, source: source && { videoHistoryId: source.videoHistoryId, inSec: source.inSec, outSec: source.outSec, referenceImageId: source.referenceImageId }, trackId: project?.trackId ?? null,
    uploadedAudioFilename: project?.uploadedAudioFilename ?? null, audioRevision: project?.audioRevision ?? null, aspect: project?.treatment?.brief?.aspectRatio ?? null });
}
