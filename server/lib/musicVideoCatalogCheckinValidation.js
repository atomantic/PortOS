import { z } from 'zod';

// Legacy approvals have no body; catalog approvals carry the displayed basis.
export const musicVideoCatalogCheckinApprovalSchema = z.object({
  catalogBasis: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
