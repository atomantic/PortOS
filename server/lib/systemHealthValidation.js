/**
 * Zod schemas for the system-health warning and threshold routes.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';

// Dismissible system health warnings — see server/routes/systemHealth.js.
// Probe failures are intentionally excluded: a missing measurement cannot be dismissed.
const SYSTEM_HEALTH_WARNING_TYPES = ['memory', 'cpu', 'disk', 'data-disk', 'process', 'restarts', 'apps', 'database', 'forge', 'code-review', 'health-settings'];
export const systemHealthWarningParamsSchema = z.object({ type: z.enum(SYSTEM_HEALTH_WARNING_TYPES) });
export const systemHealthWarningDismissSchema = z.object({ message: z.string().trim().min(1).max(500) });

export const systemHealthThresholdsBodySchema = z.object({
  memoryWarn: z.coerce.number().finite(),
  memoryCritical: z.coerce.number().finite(),
  diskWarn: z.coerce.number().finite(),
  diskCritical: z.coerce.number().finite(),
});
