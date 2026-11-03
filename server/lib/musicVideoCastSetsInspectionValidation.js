import { z } from 'zod';
export const musicVideoCastSetsInspectSchema = z.object({
  keys: z.array(z.string().min(1).max(80)).min(1).max(100).optional(),
}).strict();

export const musicVideoCastSetsAcknowledgeSchema = z.object({
  inputs: z.object({ key: z.string().min(1).max(80), imageId: z.string().min(1).max(500),
    jobId: z.string().max(200).nullable(), imageRevision: z.number().int().min(0),
    planPrompt: z.string().min(1).max(100000), submittedPrompt: z.string().max(20000).nullable() }).strict(),
  inspectionId: z.string().uuid().nullable(),
}).strict();
