/** Validates HTTP request bodies, query parameters, and path parameters for Persistent Mind routes. */

import { z } from 'zod';
import { MAX_SCREENSHOT_BYTES } from '../uploadLimits.js';
import { PERSISTENT_MIND_LIMITS } from './persistentMind.js';
import { PERSISTENT_MIND_CLEANUP_SCOPES } from './persistentMindCapabilities.js';
import { PERSISTENT_MIND_JOURNAL_KINDS, PERSISTENT_MIND_JOURNAL_LIMITS, PERSISTENT_MIND_JOURNAL_STATUSES } from './persistentMindJournal.js';
import { persistentMindMemoryProtectionSchema } from './persistentMindMemory.js';
import { persistentMindThinkingPresetSchema, persistentMindThinkingSelectionSchema } from './persistentMindThinkingPresets.js';
import { PERSISTENT_MIND_TRAJECTORY_LIMITS, parsePersistentMindCursor } from './persistentMindTrajectory.js';

const idempotencyId = z.string().trim().min(1).max(200);
const eventId = z.string().trim().min(1).max(128);
const text = z.string().trim().min(1).max(PERSISTENT_MIND_LIMITS.MAX_MESSAGE_CHARS);
const messageText = z.string().trim().max(PERSISTENT_MIND_LIMITS.MAX_MESSAGE_CHARS).optional();
const attachmentId = z.string()
  .trim()
  .min(1)
  .max(PERSISTENT_MIND_LIMITS.MAX_ATTACHMENT_ID_CHARS)
  .regex(/^[A-Za-z0-9_-]+$/, 'invalid attachment id');
const imageReference = z.union([
  attachmentId,
  z.object({ attachmentId }).strict(),
]);
export const mindReadSchema = z.object({
  cursor: z.string().max(260).refine((value) => parsePersistentMindCursor(value) !== null, 'Invalid cursor').optional(),
  limit: z.coerce.number().int().positive().max(PERSISTENT_MIND_TRAJECTORY_LIMITS.maxPageSize).optional(),
}).strict();
export const visibilityReadSchema = z.object({
  refresh: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
}).strict();
export const messageSchema = z.object({
  id: idempotencyId,
  text: messageText,
  images: z.array(imageReference).max(PERSISTENT_MIND_LIMITS.MAX_MESSAGE_IMAGES).optional(),
  // "Send with another model": one saved preset, for this message's single turn
  // only. Absent, empty, and null all mean the same thing here — the mind's
  // unchanged default route — so a composer that clears its picker does not
  // have to omit the key to say "no override".
  thinkingPresetId: z.union([
    persistentMindThinkingPresetSchema.shape.id,
    z.literal(''),
    z.null(),
  ]).optional(),
  thinkingPreset: persistentMindThinkingSelectionSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.thinkingPreset && value.thinkingPreset.id !== value.thinkingPresetId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['thinkingPreset'], message: 'The displayed selection must match thinkingPresetId' });
  }
  const images = Array.isArray(value.images) ? value.images : [];
  const ids = images.map((image) => typeof image === 'string' ? image : image.attachmentId);
  if (!value.text && ids.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['text'], message: 'text or at least one image is required' });
  }
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['images'], message: 'image references must be unique' });
  }
});
export const attachmentUploadSchema = z.object({
  filename: z.string().trim().min(1).max(PERSISTENT_MIND_LIMITS.MAX_ATTACHMENT_FILENAME_CHARS),
  data: z.string().min(1).max(Math.ceil(MAX_SCREENSHOT_BYTES * 4 / 3) + 16),
}).strict();
export const attachmentParamsSchema = z.object({ attachmentId }).strict();
export const annotationSchema = z.object({
  id: idempotencyId,
  text,
  turnId: z.string().trim().min(1).max(128).nullable().optional(),
  targetEventId: eventId.nullable().optional(),
}).strict();
export const pauseSchema = z.object({ reason: z.string().trim().min(1).max(PERSISTENT_MIND_LIMITS.MAX_REASON_CHARS).optional() }).strict();
export const acknowledgementSchema = z.object({ id: idempotencyId }).strict();
export const eventParamsSchema = z.object({ eventId }).strict();
// Legacy promotion types predate memoryTypeEnum; map them so stored records stay editable.
const LEGACY_PROMOTION_TYPES = { insight: 'learning', pattern: 'observation' };
export const promotionSchema = z.object({
  id: idempotencyId,
  approved: z.literal(true),
  content: z.string().trim().min(1).max(10_240),
  summary: z.string().trim().max(500).optional(),
  turnId: z.string().trim().min(1).max(128).nullable().optional(),
  type: z.preprocess((value) => LEGACY_PROMOTION_TYPES[value] ?? value, z.enum(['fact', 'learning', 'observation', 'decision', 'preference', 'context'])).optional(),
  category: z.string().trim().min(1).max(100).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
}).strict();
const memoryType = z.enum(['fact', 'learning', 'observation', 'decision', 'preference', 'context']);
const memoryFields = {
  protection: persistentMindMemoryProtectionSchema.optional(),
  content: z.string().trim().min(1).max(10_240),
  summary: z.string().trim().max(500).optional(),
  type: memoryType,
  category: z.string().trim().min(1).max(100),
  tags: z.array(z.string().trim().min(1).max(50)).max(20),
  importance: z.number().min(0).max(1),
};
export const memoryInputSchema = z.object({
  ...memoryFields,
  type: memoryFields.type.optional().default('observation'),
  category: memoryFields.category.optional().default('other'),
  tags: memoryFields.tags.optional().default([]),
  importance: memoryFields.importance.optional().default(0.5),
}).strict();
export const memoryUpdateSchema = z.object(memoryFields).partial().strict().refine(
  (value) => Object.keys(value).length > 0,
  'At least one memory field is required'
);
export const memoryParamsSchema = z.object({ memoryId: z.string().trim().min(1).max(128) }).strict();
export const journalReadSchema = z.object({
  kind: z.enum(PERSISTENT_MIND_JOURNAL_KINDS).optional(),
  status: z.enum(PERSISTENT_MIND_JOURNAL_STATUSES).optional(),
  limit: z.coerce.number().int().positive().max(PERSISTENT_MIND_JOURNAL_LIMITS.maxPageSize).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
}).strict();
// Two verbs, not a free status write: the user may settle an entry or retire
// one the mind got wrong. Neither deletes it, and neither can resurrect a
// retired statement — that is the mind's own supersede operation.
export const journalCorrectionSchema = z.object({
  action: z.enum(['resolve', 'retire']),
  resolution: z.string().trim().max(PERSISTENT_MIND_JOURNAL_LIMITS.maxResolutionChars).optional(),
}).strict();
export const journalParamsSchema = z.object({ journalEventId: z.string().trim().min(1).max(160) }).strict();
export const cleanupSchema = z.object({
  scopes: z.array(z.enum(PERSISTENT_MIND_CLEANUP_SCOPES))
    .min(1)
    .max(PERSISTENT_MIND_CLEANUP_SCOPES.length)
    .refine((scopes) => new Set(scopes).size === scopes.length, 'cleanup scopes must be unique'),
  reason: z.string().trim().min(1).max(300).optional(),
  confirmation: z.literal('CLEAR'),
}).strict();

export const watchdogRunSchema = z.object({ dryRun: z.boolean().optional() }).strict();
