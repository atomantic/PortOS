// Zod request schemas for the feeds routes.

import { z } from 'zod';

export const addFeedSchema = z.object({
  url: z.string().url()
});

const feedIdQuery = { feedId: z.string().min(1).max(200).optional() };

export const itemsQuerySchema = z.object({
  ...feedIdQuery,
  unreadOnly: z.enum(['true', 'false']).optional(),
  // parsePagination clamps these; the schema only refuses non-scalar values.
  limit: z.string().max(20).optional(),
  offset: z.string().max(20).optional(),
});

export const readAllQuerySchema = z.object(feedIdQuery);
