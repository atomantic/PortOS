/**
 * Convert an audio duration into the smallest frame canvas that covers it on a
 * runtime's causal-VAE temporal grid. Kept pure so route preparation can reject
 * an over-limit upload before it reaches the persistent media queue.
 */
export const audioDurationToFrames = (durationSeconds, fps, frameStride) => {
  const duration = Number(durationSeconds);
  const rate = Number(fps);
  const stride = Number(frameStride);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new TypeError('durationSeconds must be positive');
  }
  if (!Number.isFinite(rate) || rate <= 0) throw new TypeError('fps must be positive');
  if (!Number.isInteger(stride) || stride <= 0) {
    throw new TypeError('frameStride must be a positive integer');
  }
  const targetFrames = duration * rate;
  return Math.max(1, Math.ceil((targetFrames - 1) / stride) * stride + 1);
};
