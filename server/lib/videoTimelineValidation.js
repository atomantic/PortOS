// Zod request schemas for the video timeline routes.

import { z } from 'zod';
import {
  IMAGE_ASSET_KINDS,
  AUDIO_ASSET_KINDS,
  MAX_SEGMENTS,
  MAX_OVERLAYS,
  MAX_AUDIO_TRACKS,
  MAX_FADE_SEC,
  MAX_STILL_SEC,
  MAX_VOLUME,
} from './videoTimelineConstraints.js';

// Lane schemas mirror server/services/videoTimeline/segments.js. Zod is the
// coarse shape/bounds gate at the edge; the service validators re-check the
// cross-field rules (fades fitting inside their own duration, asset
// containment under an allowlisted data/ subdirectory) that a schema can't
// express against the filesystem. That split is deliberate — but the kind
// lists and the numeric bounds come FROM the service, so a new asset kind or a
// raised cap can't be accepted by one layer and 400'd by the other.
const fadeFields = {
  fadeInSec: z.number().min(0).max(MAX_FADE_SEC).optional(),
  fadeOutSec: z.number().min(0).max(MAX_FADE_SEC).optional(),
};

const outAfterIn = [
  (c) => c.outSec > c.inSec,
  { message: 'outSec must be > inSec', path: ['outSec'] },
];

const clipTrimFields = {
  clipId: z.string().guid(),
  inSec: z.number().min(0),
  outSec: z.number().min(0),
};

const assetFields = (kinds) => ({
  assetKind: z.enum(kinds),
  // Basename only — the service resolves it under the kind's data/ root and
  // refuses anything that escapes.
  assetFile: z.string().min(1).max(255),
});

const clipSchema = z.object(clipTrimFields).refine(...outAfterIn);

const clipSegmentSchema = z.object({
  type: z.literal('clip'),
  ...clipTrimFields,
  volume: z.number().min(0).max(MAX_VOLUME).optional(),
  ...fadeFields,
}).refine(...outAfterIn);

const stillSegmentSchema = z.object({
  type: z.literal('still'),
  ...assetFields(IMAGE_ASSET_KINDS),
  durationSec: z.number().gt(0).max(MAX_STILL_SEC),
  ...fadeFields,
});

const segmentSchema = z.discriminatedUnion('type', [clipSegmentSchema, stillSegmentSchema]);

const overlaySchema = z.object({
  type: z.literal('image').optional(),
  ...assetFields(IMAGE_ASSET_KINDS),
  startSec: z.number().min(0),
  durationSec: z.number().gt(0).max(MAX_STILL_SEC),
  // Normalized to the canonical canvas so placement survives a change of
  // canonical dimensions. Slight overscan lets a graphic bleed off-frame.
  x: z.number().min(-1).max(2).optional(),
  y: z.number().min(-1).max(2).optional(),
  width: z.number().gt(0).max(4).optional(),
  opacity: z.number().min(0).max(1).optional(),
  ...fadeFields,
});

const audioTrackSchema = z.object({
  ...assetFields(AUDIO_ASSET_KINDS),
  startSec: z.number().min(0),
  offsetSec: z.number().min(0).optional(),
  durationSec: z.number().gt(0).max(MAX_STILL_SEC),
  volume: z.number().min(0).max(MAX_VOLUME).optional(),
  ...fadeFields,
});

const audioSchema = z.object({
  clipVolume: z.number().min(0).max(MAX_VOLUME).optional(),
  tracks: z.array(audioTrackSchema).max(MAX_AUDIO_TRACKS).optional(),
});

export const createBodySchema = z.object({
  name: z.string().min(1).max(200),
});

const PATCHABLE_KEYS = ['name', 'clips', 'segments', 'overlays', 'audio'];

export const updateBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  // `clips` is the v1 video lane. Still accepted so an older client (or an
  // older peer-authored payload) keeps working; the service upgrades it to
  // clip segments, and `segments` wins when both are present.
  clips: z.array(clipSchema).max(MAX_SEGMENTS).optional(),
  segments: z.array(segmentSchema).max(MAX_SEGMENTS).optional(),
  overlays: z.array(overlaySchema).max(MAX_OVERLAYS).optional(),
  audio: audioSchema.optional(),
  expectedUpdatedAt: z.string().optional(),
}).refine((b) => PATCHABLE_KEYS.some((k) => b[k] !== undefined), {
  message: `PATCH body must include at least one of: ${PATCHABLE_KEYS.join(', ')}`,
});
