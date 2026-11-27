// Zod request schemas for the music video cameos routes.

import { z } from 'zod';
import { MUSIC_VIDEO_CAMEO_ID_PATTERN, MUSIC_VIDEO_CAMEO_VARIANT_ID_PATTERN } from './musicVideo/musicVideoCameos.js';

export const cameoParams = z.object({ id: z.string().min(1).max(200), cameoId: z.string().regex(MUSIC_VIDEO_CAMEO_ID_PATTERN) }).strict();

export const variantParams = cameoParams.extend({ variantId: z.string().regex(MUSIC_VIDEO_CAMEO_VARIANT_ID_PATTERN) }).strict();
