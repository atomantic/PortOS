import { z } from 'zod';

// Shared: safe relative path (no traversal)
const safeRelativePath = z.string().min(1).max(1000).refine(
  p => !p.includes('..') && !p.startsWith('/'),
  { message: 'Path must be relative and cannot contain ..' }
);

export const vaultInputSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  path: z.string().min(1).max(1000)
});

export const vaultUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  path: z.string().min(1).max(1000).optional()
});

export const notePathSchema = z.object({
  path: safeRelativePath
});

export const createNoteSchema = z.object({
  path: safeRelativePath,
  content: z.string().max(500000).optional().default('')
});

export const updateNoteSchema = z.object({
  content: z.string().max(500000)
});

export const searchQuerySchema = z.object({
  q: z.string().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50)
});

export const scanQuerySchema = z.object({
  folder: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(500),
  offset: z.coerce.number().int().min(0).optional().default(0)
});
