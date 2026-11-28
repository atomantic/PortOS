// Zod request schemas for the contacts routes.

import { z } from 'zod';

export const enrichBodySchema = z.object({
  dryRun: z.boolean().optional().default(false),
});

export const suggestQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const importBodySchema = z.object({
  contactId: z.string().min(1).max(300).optional(),
  name: z.string().min(1).max(200).optional(),
  phones: z.array(z.string().max(40)).max(20).optional(),
  emails: z.array(z.string().email().max(200)).max(20).optional(),
  organization: z.string().max(200).optional(),
  ring: z.enum(['support', 'core', 'tribe', 'village', 'external']).optional(),
  relationship: z.string().max(200).optional(),
}).refine((b) => b.contactId || b.name || (b.phones?.length) || (b.emails?.length), {
  message: 'contactId or name/phones/emails required',
});
