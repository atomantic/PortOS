/**
 * Zod schemas for the rapid-reader library routes.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';

export const rapidReaderLibraryParamsSchema = z.object({ id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/) });
export const rapidReaderLibraryCreateSchema = z.object({ title: z.string().trim().min(1).max(200), author: z.string().trim().max(200).optional(), text: z.string().trim().min(1).max(2 * 1024 * 1024) });
export const rapidReaderLibraryFetchSchema = z.object({ url: z.string().trim().url().max(2000).refine((value) => /^https?:\/\//i.test(value), 'url must be http(s)'), title: z.string().trim().min(1).max(200).optional() });
