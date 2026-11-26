/** Request schemas for Signal conversation browsing and privacy mutations. */
import { z } from 'zod';

const handle = z.string().trim().min(1).max(200);
const conversationId = z.string().trim().min(1).max(1000);

export const signalListSchema = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

export const signalConversationSchema = z.object({
  conversationId,
  purgeExisting: z.boolean().optional(),
});

export const signalBlocklistSchema = z.object({
  handles: z.array(handle).max(5000),
  conversationIds: z.array(conversationId).max(5000),
});

export const signalBlocklistHandlesSchema = z.object({
  handles: z.union([handle, z.array(handle).min(1).max(100)]),
  purgeExisting: z.boolean().optional(),
});
