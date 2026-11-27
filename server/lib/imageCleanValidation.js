// Zod request schemas for the image clean routes.

import { z } from 'zod';
import { IGNORE_ZONE_FEATHER_DEFAULT } from './imageClean.js';
import { REGEN_STRENGTH_MIN, REGEN_STRENGTH_MAX } from './imageGenCapabilities.js';

// Query-string flag → boolean. Accepts the common truthy/falsey string forms a
// browser fetch sends ("1"/"0"/"true"/"false"); anything else falls back to the
// schema default. Mirrors the history.js success-filter pattern.
const queryFlag = (def) => z.preprocess(
  (v) => {
    if (v === undefined) return def;
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
    return v;
  },
  z.boolean(),
);

// Diffusion sub-mode. `off` (default) skips it entirely; `light` runs the
// CPU-only spatial pass (`applyLightRegen`) that actually perturbs SynthID's
// resolution-dependent carriers — the no-GPU fallback, always available since
// sharp is a hard dependency. `gpu` (the FLUX img2img round-trip) is
// GPU-serialized via mediaJobQueue: the route stages the sync-cleaned bytes,
// enqueues a job through the shared regen seam, and returns a `jobId` the
// client tracks via the media-job progress channel (issue #2264). Anything
// else → the `off` default.
const diffusionMode = z.preprocess(
  (v) => {
    if (v === undefined || v === '' || v === '0' || v === 'false' || v === 'off') return 'off';
    if (v === 'light' || v === 'cpu' || v === '1' || v === 'true') return 'light';
    if (v === 'gpu' || v === 'flux') return 'gpu';
    return 'off';
  },
  z.enum(['off', 'light', 'gpu']),
);

// Pipeline steps ride in the query string, not the body (the body is the image).
// `mask=1` signals an ignore-zone preserve-region envelope in the body (see the
// length-prefixed decode below); `feather` is the soft-boundary blur sigma (px)
// clamped in the lib. The mask only has any effect when a diffusion step runs —
// it composites the ORIGINAL pixels back over the diffused result.
export const cleanQuerySchema = z.object({
  metadata: queryFlag(true),
  denoise: queryFlag(false),
  diffusion: diffusionMode,
  mask: queryFlag(false),
  feather: z.preprocess(
    (v) => (v === undefined || v === '' ? IGNORE_ZONE_FEATHER_DEFAULT : Number(v)),
    z.number().min(0).max(50),
  ),
  // GPU-diffusion-only knobs (issue #2264), ignored by the sync passes.
  // `strength` is the img2img denoise, clamped to the same [MIN, MAX] the
  // lightbox slider is bound to; absent → the conservative arbitrary-upload
  // default. `maxMp` is the optional per-run render-megapixel budget override.
  strength: z.preprocess(
    (v) => (v === undefined || v === '' ? undefined : Number(v)),
    z.number().min(REGEN_STRENGTH_MIN).max(REGEN_STRENGTH_MAX).optional(),
  ),
  maxMp: z.preprocess(
    (v) => (v === undefined || v === '' ? undefined : Number(v)),
    z.number().min(0.25).max(16).optional(),
  ),
});

// Validate a clean job id — the mediaJobQueue mints v4 UUIDs, so anything that
// isn't UUID-shaped can't be a real job (and keeps the temp-path resolution
// safe). Reused by the result-fetch + save-to-gallery routes below.
export const jobIdSchema = z.object({
  jobId: z.string().uuid('Invalid job id'),
});
