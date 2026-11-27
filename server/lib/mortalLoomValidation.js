/** Request schemas for verified MortalLoom recovery downloads and revision-bound restores. */
import { z } from 'zod';

const revisionId = z.string().regex(/^[a-f0-9]{64}$/);
export const mortalLoomRestoreSchema = z.object({
  id: revisionId, expectedRevision: revisionId, confirmed: z.literal(true),
}).strict();
export const mortalLoomRecoverySchema = z.object({ id: revisionId }).strict();
