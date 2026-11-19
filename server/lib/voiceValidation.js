/**
 * Zod schema for the voice Piper-fetch route.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';
import { nonEmptyString } from './sharedSchemas.js';

export const voicePiperFetchBodySchema = z.object({ voice: nonEmptyString });
