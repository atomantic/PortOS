// Request fields that only local video runtimes understand. Their Zod schemas
// stay at the HTTP boundary, while this domain-level list lets submission logic
// decide whether a request can be routed to a Grok pin without duplicating names.
export const VIDEO_GEN_LOCAL_ONLY_FIELDS = Object.freeze({
  NUM_FRAMES: 'numFrames',
  FPS: 'fps',
  STEPS: 'steps',
  GUIDANCE_SCALE: 'guidanceScale',
  SEED: 'seed',
  BATCH_SIZE: 'batchSize',
  IMAGE_STRENGTH: 'imageStrength',
  I2V_REFERENCE_MODE: 'i2vReferenceMode',
  A2V_LORA_STAGE_STRENGTHS: 'a2vLoraStageStrengths',
  TILING: 'tiling',
  TEXT_ENCODER_ID: 'textEncoderId',
  SPEED_PROFILE_ID: 'speedProfileId',
  DRAFT_DECODE: 'draftDecode',
  // Block-streaming request (#6499) — an LTX-2/2.5 MLX-only knob, so it makes
  // no sense on a Grok/fal/reactor render and stays local-only for the same
  // reason speedProfileId/draftDecode do.
  STREAMING_MODE: 'streamingMode',
  CONTINUITY_STRATEGY: 'continuityStrategy',
});

// Indexed multipart slots for ordered voice references (FastH3 Omni): the
// streaming parser keeps one file per field name, so N clips need N names.
export const REFERENCE_AUDIO_FIELDS = Object.freeze(['referenceAudio0', 'referenceAudio1', 'referenceAudio2']);

// Extra reference images that ride beside a Grok image-to-video source frame
// (Grok's reference_to_video tool). Indexed multipart slots `referenceImage1..N`,
// each with an optional `referenceLabelN` text field describing what it shows.
// The parser also accepts one slot past the maximum so an over-limit request is
// refused with a clear error instead of the extra file being silently dropped.
export const MAX_VIDEO_REFERENCE_IMAGES = 3;
export const MAX_VIDEO_REFERENCE_LABEL_LENGTH = 120;
export const VIDEO_REFERENCE_IMAGE_FIELDS = Object.freeze(
  Array.from({ length: MAX_VIDEO_REFERENCE_IMAGES + 1 }, (_, i) => `referenceImage${i + 1}`),
);

/** The uploaded reference images in slot order, each with its trimmed label. */
export const videoReferenceImageSlots = (uploads = {}, body = {}) => VIDEO_REFERENCE_IMAGE_FIELDS
  .map((field, i) => ({ field, file: uploads[field], label: String(body[`referenceLabel${i + 1}`] ?? '').trim() }))
  .filter((slot) => slot.file);

export const VIDEO_GEN_LOCAL_ONLY_FIELD_NAMES = Object.freeze(
  Object.values(VIDEO_GEN_LOCAL_ONLY_FIELDS),
);
