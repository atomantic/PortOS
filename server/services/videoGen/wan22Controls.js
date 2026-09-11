import { ServerError } from '../../lib/errorHandler.js';

/** Validate the already-resolved frame count shared by Wan admission and rendering. */
export const wan22FrameCountError = (model, numFrames) => {
  if (model?.runtime !== 'wan22' && model?.runtime !== 'wan22_cuda') return null;
  const frameStride = Number(model.frameStride);
  if (Number.isFinite(frameStride) && frameStride > 0 && (Number(numFrames) - 1) % frameStride !== 0) {
    return new ServerError(
      `${model.name} requires a ${frameStride}n+1 frame count; got ${numFrames}.`,
      { status: 400, code: 'WAN22_INVALID_FRAME_COUNT' },
    );
  }
  return null;
};
