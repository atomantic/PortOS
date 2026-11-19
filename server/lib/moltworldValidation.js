/**
 * Zod schema for the Moltworld queue-fail route.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';
import { nullishString } from './sharedSchemas.js';

export const moltworldQueueFailBodySchema = z.object({ error: nullishString });
