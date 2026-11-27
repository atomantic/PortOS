// Zod request schemas for the automation schedules routes.

import { z } from 'zod';

export const toggleScheduleSchema = z.object({
  enabled: z.boolean(),
});
