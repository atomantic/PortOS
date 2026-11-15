/**
 * Shared Zod shape and vocabulary for anchored calendar recurrences that cannot be represented
 * faithfully by five-field cron.
 */

import { z } from 'zod';

// Calendar recurrence is deliberately separate from five-field cron. Cron is
// still the wire format for existing schedules, but it cannot express an
// anchored every-N-weeks rule without either drifting at month boundaries or
// firing on the wrong weeks.
export const RECURRENCE_FREQUENCIES = Object.freeze([
  'daily',
  'weekly',
  'monthly-date',
  'monthly-weekday',
  'custom',
]);

export const RECURRENCE_ORDINALS = Object.freeze(['first', 'second', 'third', 'fourth', 'last']);

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isValidCalendarDate(value) {
  const match = value.match(DATE_RE);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() + 1 === month
    && date.getUTCDate() === day;
}

export const recurrenceRuleSchema = z.object({
  frequency: z.enum(RECURRENCE_FREQUENCIES),
  // For daily this is days; weekly, weeks; monthly, months.
  interval: z.number().int().min(1).max(365).optional().default(1),
  time: z.string().regex(HHMM_RE, 'must be HH:MM (24h)').optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional().default([]),
  weekday: z.number().int().min(0).max(6).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  ordinal: z.enum(RECURRENCE_ORDINALS).optional(),
  // The anchor is local-calendar data, not an instant. It makes every-N-weeks
  // and every-N-months stable across restarts and timezone/DST changes.
  anchorDate: z.string()
    .regex(DATE_RE, 'must be YYYY-MM-DD')
    .refine(isValidCalendarDate, 'must be a valid calendar date')
    .optional(),
  // Only used when frequency is custom. The scheduler validates the expression
  // with its own parser after this shape check.
  cron: z.string().trim().max(120).optional(),
}).superRefine((value, ctx) => {
  if (value.frequency === 'custom') {
    if (!value.cron) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cron'], message: 'custom recurrence requires cron' });
    return;
  }
  if (!value.time) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['time'], message: 'recurrence requires time' });
  }
  if (value.interval > 1 && !value.anchorDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['anchorDate'], message: 'multi-period recurrence requires anchorDate' });
  }
  if (value.frequency === 'weekly' && value.interval > 52) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['interval'], message: 'weekly recurrence supports at most 52 weeks' });
  }
  if ((value.frequency === 'monthly-date' || value.frequency === 'monthly-weekday') && value.interval > 12) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['interval'], message: 'monthly recurrence supports at most 12 months' });
  }
  if (value.frequency === 'weekly' && value.weekdays.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['weekdays'], message: 'weekly recurrence requires a weekday' });
  }
  if (value.frequency === 'monthly-date' && value.dayOfMonth == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dayOfMonth'], message: 'monthly-date recurrence requires dayOfMonth' });
  }
  if (value.frequency === 'monthly-weekday') {
    if (!value.ordinal) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ordinal'], message: 'monthly-weekday recurrence requires ordinal' });
    if (value.weekday == null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['weekday'], message: 'monthly-weekday recurrence requires weekday' });
  }
});
