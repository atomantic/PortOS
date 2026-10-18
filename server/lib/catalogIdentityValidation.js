import { z } from 'zod';
const id = z.string().min(1).max(160);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const identityPreviewSchema = z.object({ operationId: z.string().uuid(), sourceId: id, survivorId: id,
  fieldChoices: z.record(z.string().max(500), z.enum(['source', 'survivor'])).default({}) }).strict();
export const identityCreateSchema = identityPreviewSchema.extend({ planHash: digest });
export const identityImportSchema = z.object({ peerId: id, operationId: id }).strict();
export const identityAcceptSchema = z.object({ planHash: digest }).strict();
export const identityEmptySchema = z.object({}).strict();
export const identitySnapshotQuerySchema = z.object({ ingredientId: id, challenge: digest }).strict();
export const identityStatusQuerySchema = z.object({ operationId: id, challenge: digest }).strict();

export const identityListQuerySchema = z.object({ ingredientId: id.optional(), limit: z.coerce.number().int().min(1).max(50).default(20), offset: z.coerce.number().int().min(0).max(100000).default(0) }).strict();
