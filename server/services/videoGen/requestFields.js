// Request fields that only local video runtimes understand. Their Zod schemas
// stay at the HTTP boundary, while this domain-level list lets submission logic
// decide whether a request can be routed to a Grok pin without duplicating names.
export const VIDEO_GEN_LOCAL_ONLY_FIELDS = Object.freeze({
  NUM_FRAMES: 'numFrames',
  FPS: 'fps',
  STEPS: 'steps',
  GUIDANCE_SCALE: 'guidanceScale',
  SEED: 'seed',
  IMAGE_STRENGTH: 'imageStrength',
  I2V_REFERENCE_MODE: 'i2vReferenceMode',
  TILING: 'tiling',
  TEXT_ENCODER_ID: 'textEncoderId',
  SPEED_PROFILE_ID: 'speedProfileId',
  DRAFT_DECODE: 'draftDecode',
});

export const VIDEO_GEN_LOCAL_ONLY_FIELD_NAMES = Object.freeze(
  Object.values(VIDEO_GEN_LOCAL_ONLY_FIELDS),
);
