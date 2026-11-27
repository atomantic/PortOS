/**
 * Zod schemas for the calendar daily-review and auto-configure routes.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';
import { optionalString } from './sharedSchemas.js';

// Smaller single-purpose bodies
// GET /api/calendar/review/:date — bounded page of the day's events. The
// defaults reproduce the legacy single-page response.
export const dailyReviewQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

export const calendarAutoConfigureBodySchema = z.object({
  email: optionalString,
  requestId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).optional(),
});

// === Validation Schemas ===
export const createAccountSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['outlook-calendar', 'google-calendar']),
  email: z.union([z.string().email(), z.literal('')]).optional().default('')
});

export const updateAccountSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.union([z.string().email(), z.literal('')]).optional(),
  enabled: z.boolean().optional(),
  syncMethod: z.enum(['claude-mcp', 'google-api']).optional()
});

const subcalendarSchema = z.object({
  calendarId: z.string().min(1),
  name: z.string().min(1),
  color: z.string().optional().default(''),
  enabled: z.boolean().optional().default(true),
  dormant: z.boolean().optional().default(false),
  goalIds: z.array(z.string()).optional().default([]),
  addedAt: z.string().optional()
});

export const updateSubcalendarsSchema = z.object({
  subcalendars: z.array(subcalendarSchema)
});

export const confirmEventSchema = z.object({
  eventId: z.string().min(1),
  happened: z.boolean(),
  goalId: z.string().optional(),
  durationMinutes: z.number().int().min(1).max(1440).optional(),
  note: z.string().max(1000).optional()
});

export const eventsQuerySchema = z.object({
  accountId: z.string().optional(),
  search: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

export const googleCalendarCredentialsSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1)
});

export const googleCalendarAuthUrlQuerySchema = z.object({ returnTo: z.enum(['calendar', 'messages']).optional().default('calendar') });
