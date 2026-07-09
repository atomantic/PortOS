import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { partialWithoutDefaults } from '../lib/zodCompat.js';
import * as tribe from '../services/tribe.js';

const router = Router();

const ringSchema = z.enum(['support', 'core', 'tribe', 'village', 'external']);
const energySchema = z.enum(['nourishing', 'steady', 'complex', 'draining']);

const personSchema = z.object({
  id: z.string().guid().optional(),
  name: z.string().min(1).max(200),
  relationship: z.string().max(200).optional().default(''),
  ring: ringSchema.optional().default('tribe'),
  cadenceDays: z.number().int().min(1).max(3650).optional(),
  lastContact: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  channel: z.string().max(200).optional().default(''),
  energy: energySchema.optional().default('steady'),
  tags: z.array(z.string().max(80)).max(50).optional().default([]),
  // Known emails/handles used to auto-match calendar attendees / message
  // counterparts to this person (#2033). Service-side `normalizeEmails` lowercases
  // and de-duplicates; the UI splits its single-line input to an array like tags.
  emails: z.array(z.string().max(320)).max(100).optional().default([]),
  // Known phone handles used to auto-match iMessage/Signal counterparts to this
  // person (#2151). Service-side `normalizePhones` E.164-normalizes and
  // de-duplicates; the UI splits its single-line input to an array like tags.
  phones: z.array(z.string().max(40)).max(100).optional().default([]),
  nextMove: z.string().max(2000).optional().default(''),
  notes: z.string().max(10000).optional().default(''),
});

const personUpdateSchema = partialWithoutDefaults(personSchema).extend({
  id: z.never().optional(),
});

const touchpointSchema = z.object({
  happenedAt: z.string().datetime().optional(),
  channel: z.string().max(200).optional().default(''),
  summary: z.string().max(2000).optional().default(''),
  source: z.enum(['user', 'calendar', 'message', 'import']).optional().default('user'),
  calendarAccountId: z.string().max(200).nullable().optional(),
  calendarEventId: z.string().max(500).nullable().optional(),
  metadata: z.record(z.unknown()).optional().default({}),
});

const calendarTouchpointSchema = z.object({
  accountId: z.string().guid(),
  eventId: z.string().min(1).max(500),
  summary: z.string().max(2000).optional(),
});

const memoryLinkSchema = z.object({
  memoryId: z.string().guid(),
  note: z.string().max(1000).optional().default(''),
});

const listQuerySchema = z.object({
  search: z.string().max(200).optional(),
  ring: ringSchema.or(z.literal('all')).optional(),
});

// Validate UUID path params before they hit the UUID-typed columns; otherwise a
// non-UUID segment raises a raw Postgres "invalid input syntax for type uuid"
// 500 (leaking the column type) instead of a clean 400.
const guidParam = (label) => (req, res, next, value) => {
  if (!z.string().guid().safeParse(value).success) {
    return next(new ServerError(`Invalid ${label}`, { status: 400 }));
  }
  return next();
};
router.param('id', guidParam('person id'));
router.param('memoryId', guidParam('memory id'));

router.get('/people', asyncHandler(async (req, res) => {
  const { search, ring } = validateRequest(listQuerySchema, req.query);
  const people = await tribe.listPeople({
    search: search || undefined,
    ring: ring || undefined,
  });
  res.json({ people });
}));

// Care summary — overdue-contact status computed server-side (single source of
// truth) for the dashboard widget and proactive-alerts check.
router.get('/care', asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 50);
  const summary = await tribe.getCareSummary(limit);
  res.json(summary);
}));

router.post('/people', asyncHandler(async (req, res) => {
  const data = validateRequest(personSchema, req.body);
  const person = await tribe.createPerson(data);
  req.app.get('io')?.emit('tribe:changed', { personId: person.id });
  res.status(201).json(person);
}));

router.get('/people/:id', asyncHandler(async (req, res) => {
  const person = await tribe.getPerson(req.params.id);
  if (!person) throw new ServerError('Person not found', { status: 404 });
  res.json(person);
}));

router.put('/people/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(personUpdateSchema, req.body);
  const person = await tribe.updatePerson(req.params.id, data);
  if (!person) throw new ServerError('Person not found', { status: 404 });
  req.app.get('io')?.emit('tribe:changed', { personId: person.id });
  res.json(person);
}));

router.delete('/people/:id', asyncHandler(async (req, res) => {
  const deleted = await tribe.deletePerson(req.params.id);
  if (!deleted) throw new ServerError('Person not found', { status: 404 });
  req.app.get('io')?.emit('tribe:changed', { personId: req.params.id });
  res.json({ success: true });
}));

router.get('/people/:id/touchpoints', asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const touchpoints = await tribe.listTouchpoints(req.params.id, limit);
  res.json({ touchpoints });
}));

router.post('/people/:id/touchpoints', asyncHandler(async (req, res) => {
  const data = validateRequest(touchpointSchema, req.body);
  const touchpoint = await tribe.createTouchpoint(req.params.id, data);
  req.app.get('io')?.emit('tribe:changed', { personId: req.params.id });
  res.status(201).json(touchpoint);
}));

router.post('/people/:id/touchpoints/calendar', asyncHandler(async (req, res) => {
  const data = validateRequest(calendarTouchpointSchema, req.body);
  const touchpoint = await tribe.createCalendarTouchpoint(req.params.id, data);
  req.app.get('io')?.emit('tribe:changed', { personId: req.params.id });
  res.status(201).json(touchpoint);
}));

router.get('/people/:id/memories', asyncHandler(async (req, res) => {
  const links = await tribe.listMemoryLinks(req.params.id);
  res.json({ links });
}));

router.post('/people/:id/memories', asyncHandler(async (req, res) => {
  const { memoryId, note } = validateRequest(memoryLinkSchema, req.body);
  await tribe.linkMemory(req.params.id, memoryId, note);
  const links = await tribe.listMemoryLinks(req.params.id);
  req.app.get('io')?.emit('tribe:changed', { personId: req.params.id });
  res.status(201).json({ links });
}));

router.delete('/people/:id/memories/:memoryId', asyncHandler(async (req, res) => {
  await tribe.unlinkMemory(req.params.id, req.params.memoryId);
  req.app.get('io')?.emit('tribe:changed', { personId: req.params.id });
  res.json({ success: true });
}));

export default router;
