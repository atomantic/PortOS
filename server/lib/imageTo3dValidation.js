// Zod request schemas for the image-to-3D routes.

import { z } from 'zod';
import {
  RENDER_STEPS_MIN,
  RENDER_STEPS_MAX,
  RENDER_SEED_MAX,
  DETAIL_TIERS,
  ALPHA_MODES,
  SUBJECT_SCALE_MIN_EXCLUSIVE,
  SUBJECT_SCALE_MAX,
} from './imageTo3dRenderLimits.js';

const galleryFilenameSchema = z.string().trim().min(1).max(256)
  .regex(/^[^/\\]+\.(png|jpe?g|webp)$/i, 'filename must be a gallery image basename');

// PER-RUN sampler knobs, shared by create and re-generate. Nothing persists
// between runs: absent steps → the pipeline default, absent seed → a fresh
// random roll for that run, absent keyBackground → no keying (the pipeline's own
// learned matte runs instead), absent subjectScale → the source's own framing.
export const renderOptionsSchema = z.object({
  steps: z.number().int().min(RENDER_STEPS_MIN).max(RENDER_STEPS_MAX).optional(),
  seed: z.number().int().min(0).max(RENDER_SEED_MAX).optional(),
  keyBackground: z.boolean().optional(),
  // Abstract tier, not a lane's raw pipeline value — the target maps it (see
  // renderOptions.js). Enums come from there so the route can't accept a tier the
  // normalizer would silently discard.
  detail: z.enum([...DETAIL_TIERS]).optional(),
  alphaMode: z.enum([...ALPHA_MODES]).optional(),
  normalMap: z.boolean().optional(),
  // Open at zero, closed at one — `1` is the identity (no reframing) and the
  // default; bounds come from renderOptions.js so the route can't accept a value
  // the normalizer would silently discard.
  subjectScale: z.number()
    .gt(SUBJECT_SCALE_MIN_EXCLUSIVE)
    .max(SUBJECT_SCALE_MAX)
    .optional(),
});

export const imageTo3dCreateModelSchema = (targetIds) => z.object({
  name: z.string().trim().min(1).max(120),
  filename: galleryFilenameSchema,
  target: z.enum([...targetIds]).optional(),
}).extend(renderOptionsSchema.shape);

export const installQuerySchema = z.object({ repair: z.enum(['0', '1']).optional() });
