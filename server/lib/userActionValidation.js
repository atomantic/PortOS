/**
 * Zod schema for the user-action ledger list query.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';
import { USER_ACTION_TYPES, USER_ACTION_ACTORS } from './userActionTypes.js';

// GET /api/user-actions — read the machine-local operator-action ledger (#5594).
// Every value arrives as a query string, so numbers are coerced and `success` is
// the string form of the boolean. Range checking is deliberately loose here and
// the CLAMP lives in `userActions.normalizeListOptions`: a caller asking for 5000
// rows wants "as many as you will give me", not a 400.
const isParseableDate = (value) => !Number.isNaN(new Date(value).getTime());
const userActionDateFilter = z.string().trim().min(1).max(64)
  .refine(isParseableDate, 'must be a parseable date');
const userActionType = z.enum([...USER_ACTION_TYPES]);

export const userActionsListQuerySchema = z.object({
  type: userActionType.optional(),
  // Repeated `?types=a&types=b` arrives as an array; a single one as a string.
  types: z.union([userActionType, z.array(userActionType)]).optional(),
  actor: z.enum([...USER_ACTION_ACTORS]).optional(),
  target: z.string().trim().min(1).max(200).optional(),
  success: z.enum(['true', 'false']).optional(),
  from: userActionDateFilter.optional(),
  to: userActionDateFilter.optional(),
  limit: z.coerce.number().int().optional(),
  offset: z.coerce.number().int().optional(),
});
