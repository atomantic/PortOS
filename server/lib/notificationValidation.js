/**
 * Zod schema for the notification list query.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';
import { NOTIFICATION_TYPES } from './notificationTypes.js';

// Read-route query contracts: a malformed limit is a 400, never a silent
// negative slice or an ignored NaN.
export const listNotificationsQuerySchema = z.object({
  type: z.enum(Object.values(NOTIFICATION_TYPES)).optional(),
  includeCount: z.literal('true').optional(),
  unreadOnly: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});
