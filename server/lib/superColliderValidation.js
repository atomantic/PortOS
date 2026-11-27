// Zod request schemas for the super collider routes.

import { z } from 'zod';
import { SUPERCOLLIDER_RENDER } from './superColliderRuntime.js';
import { MUSIC_CODE_MAX } from './musicCodeLimits.js';

export const setupSchema = z.object({ rebuild: z.boolean().optional().default(false) });

export const renderSchema = z.object({
  code: z.string().max(MUSIC_CODE_MAX).refine((code) => code.trim().length > 0, 'code is required'),
  durationSec: z.number().int().min(SUPERCOLLIDER_RENDER.minDurationSec).max(SUPERCOLLIDER_RENDER.maxDurationSec),
  seed: z.number().int().min(0).max(SUPERCOLLIDER_RENDER.maxSeed).optional(),
}).strict();
