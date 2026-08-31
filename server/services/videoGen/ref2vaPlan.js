export const MAX_REF2VA_AUDIO_SECONDS = 15;
export const REF2VA_SEAM_WARMUP_SECONDS = 3;

export const planRef2vaAudioSegments = (
  durationSeconds,
  {
    startSeconds = 0,
    maxSegmentSeconds = MAX_REF2VA_AUDIO_SECONDS,
    seamWarmupSeconds = REF2VA_SEAM_WARMUP_SECONDS,
  } = {},
) => {
  const duration = Number(durationSeconds);
  const start = Number(startSeconds);
  const maxSegment = Number(maxSegmentSeconds);
  const seamWarmup = Number(seamWarmupSeconds);
  if (!Number.isFinite(duration) || duration <= 0) throw new TypeError('durationSeconds must be positive');
  if (!Number.isFinite(start) || start < 0 || start >= duration) throw new TypeError('startSeconds must be within the audio');
  if (!Number.isFinite(maxSegment) || maxSegment <= 0 || maxSegment > MAX_REF2VA_AUDIO_SECONDS) {
    throw new TypeError(`maxSegmentSeconds must be between 0 and ${MAX_REF2VA_AUDIO_SECONDS}`);
  }
  if (!Number.isFinite(seamWarmup) || seamWarmup < 0 || seamWarmup >= maxSegment) {
    throw new TypeError('seamWarmupSeconds must be non-negative and shorter than maxSegmentSeconds');
  }

  const segments = [];
  let outputStart = start;
  while (outputStart < duration - 1e-6) {
    // H3 fades in at the beginning of every invocation. Later invocations read
    // three seconds of already-rendered audio as warm-up, then PortOS blends
    // that overlapping picture with the prior window. The delivered timeline
    // remains exact while every reference request stays within H3's 15-second cap.
    // A non-zero requested source offset can use the same warm-up immediately;
    // at absolute zero there is no earlier source audio to borrow.
    const trimStartSeconds = outputStart > 0 ? Math.min(seamWarmup, outputStart) : 0;
    const outputCapacity = maxSegment - trimStartSeconds;
    const segmentDuration = Math.min(outputCapacity, duration - outputStart);
    segments.push({
      index: segments.length,
      startSeconds: outputStart,
      durationSeconds: segmentDuration,
      referenceStartSeconds: outputStart - trimStartSeconds,
      referenceDurationSeconds: trimStartSeconds + segmentDuration,
      trimStartSeconds,
    });
    outputStart += segmentDuration;
  }
  return segments;
};
