import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, parsePagination } from '../lib/validation.js';
import { partialWithoutDefaults } from '../lib/zodCompat.js';
import * as tribe from '../services/tribe.js';
import * as tribeOutreach from '../services/tribeOutreach.js';
import * as beeperTribe from '../services/beeperTribe.js';

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
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
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

// Beeper participant → Tribe linking (#34). conversationId/sourceUserId
// identify the beeper_participants row. No `network` field here on purpose:
// it used to be client-supplied and scoped a username-shaped identity claim,
// but that let a request omit it (writing an inert kind='handle' row no
// later lookup can ever match) or spoof a WRONG network (silently stealing
// another person's claim on a UNIQUE (kind, network, handle) collision) —
// see server/services/beeperTribe.js. The network is now derived server-side
// from the participant's own beeper_conversations.network; a phone-shaped
// claim stays network-less (see server/lib/tribeMatch.js).
const beeperLinkSchema = z.object({
  conversationId: z.string().guid(),
  sourceUserId: z.string().min(1).max(500),
  personId: z.string().guid(),
});

// Unlink a Beeper participant from whichever Tribe person currently owns it
// (#97 part B). Same identifying pair as `beeperLinkSchema` — no `personId`
// here, since unlink releases whatever the participant is CURRENTLY linked
// to, and is a no-op rather than an error when that is nothing.
const beeperUnlinkSchema = z.object({
  conversationId: z.string().guid(),
  sourceUserId: z.string().min(1).max(500),
});

const beeperCreateAndLinkSchema = z.object({
  conversationId: z.string().guid(),
  sourceUserId: z.string().min(1).max(500),
  name: z.string().min(1).max(200).optional(),
  ring: ringSchema.optional().default('tribe'),
  relationship: z.string().max(200).optional().default(''),
});

// Outreach draft generation (#2158). The seed fields come from a detected
// unanswered thread; the LLM call happens only on this explicit POST (user action)
// per the AI-provider policy — never from the detection sweep.
const outreachDraftSchema = z.object({
  personId: z.string().guid().nullable().optional(),
  source: z.string().max(60).nullable().optional(),
  // Message-account id (#2820) — scopes the email grounding query so a threadId
  // shared across accounts can't merge conversations. Optional/back-compat.
  accountId: z.string().max(200).nullable().optional(),
  threadId: z.string().max(500).nullable().optional(),
  chatGuid: z.string().max(500).nullable().optional(),
  conversationId: z.string().max(500).nullable().optional(),
  handle: z.string().max(320).nullable().optional(),
  lastInboundAt: z.string().datetime().nullable().optional(),
  instructions: z.string().max(2000).optional().default(''),
  useVoice: z.boolean().optional(),
}).refine(
  // Require a conversation key — without one, generateOutreachDraft would query
  // the whole timeline and draft a reply to an unrelated conversation.
  (d) => Boolean(d.threadId || d.chatGuid || d.conversationId || d.handle),
  { message: 'An outreach draft needs one of threadId, chatGuid, conversationId, or handle' },
);

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
router.param('identityId', guidParam('identity id'));

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
  const { limit } = parsePagination(req.query, { defaultLimit: 5, maxLimit: 50 });
  const summary = await tribe.getCareSummary(limit);
  res.json(summary);
}));

// Report of emails/phones shared by more than one person (#5908). `tribe_people` has
// no uniqueness on those columns, so a routine sync can silently re-target a shared
// identifier from one person to the other. Detection only — never merges or writes.
router.get('/duplicate-identifiers', asyncHandler(async (req, res) => {
  res.json(await tribe.checkDuplicateTribeIdentifiers());
}));

// Unanswered inbound threads from Tribe people, detected from the activity
// timeline (#2158). Detection only — NO LLM. Feeds the Tribe Outreach panel and
// mirrors the `tribe_unanswered` proactive alert.
router.get('/outreach', asyncHandler(async (req, res) => {
  const { limit } = parsePagination(req.query, { defaultLimit: 8, maxLimit: 50 });
  const threads = await tribeOutreach.findUnansweredTribeThreads({ limit });
  res.json({ threads });
}));

// Generate a grounded outreach draft for one unanswered thread and file it through
// the existing draft-then-approve pipeline. This is the user-action-gated LLM step
// — it never auto-sends. The client shows the returned draft for review.
router.post('/outreach/draft', asyncHandler(async (req, res) => {
  const data = validateRequest(outreachDraftSchema, req.body);
  const result = await tribeOutreach.generateOutreachDraft(data);
  req.app.get('io')?.emit('messages:draft:created', { draftId: result.draft.id });
  res.status(201).json(result);
}));

router.post('/people', asyncHandler(async (req, res) => {
  const data = validateRequest(personSchema, req.body);
  const person = await tribe.createPerson(data);
  req.app.get('io')?.emit('tribe:changed', { personId: person.id });
  res.status(201).json(person);
}));

// `identities` (#99) is joined in here, not in `tribe.getPerson` itself —
// keeps the generic person read model Beeper-agnostic (see
// `beeperTribe.listPersonIdentitiesWithConversations`'s docblock) and keeps
// the join off `listPeople` (the roster), which never renders identity
// chips and shouldn't pay for the extra query per row.
router.get('/people/:id', asyncHandler(async (req, res) => {
  const person = await tribe.getPerson(req.params.id);
  if (!person) throw new ServerError('Person not found', { status: 404 });
  const identities = await beeperTribe.listPersonIdentitiesWithConversations(person.id);
  res.json({ ...person, identities });
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
  const { limit } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
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

// Link a Beeper conversation participant to an EXISTING Tribe person — the
// inline thread-participant action decided on #10 (#34). Never creates a
// person; see POST /beeper/link-new for that. `displacedPersonId` is set
// when the participant's handle was already claimed by a DIFFERENT person —
// that ownership move is silent at the DB/audit-trigger level (see
// tribeIdentities.linkIdentity), so it is surfaced here instead.
router.post('/beeper/link', asyncHandler(async (req, res) => {
  const { conversationId, sourceUserId, personId } = validateRequest(beeperLinkSchema, req.body);
  const { displacedPersonId, ...participant } = await beeperTribe.linkParticipant({
    conversationId, sourceUserId, personId,
  });
  req.app.get('io')?.emit('tribe:changed', { personId });
  res.json({ participant, displacedPersonId: displacedPersonId || null });
}));

// Unlink a Beeper participant from whichever Tribe person currently owns it
// (#97 part B) — the counterpart POST /beeper/link never had. Idempotent: an
// already-unlinked participant is a 200 no-op with `unlinkedPersonId: null`.
// Releases every `tribe_identities` claim THAT person held for this
// participant (never one another person now holds on the same handle) and
// nulls the cache on this row and every other one those claims were backing
// — see `beeperTribe.unlinkParticipant`.
router.delete('/beeper/link', asyncHandler(async (req, res) => {
  const { conversationId, sourceUserId } = validateRequest(beeperUnlinkSchema, req.body);
  const { participant, unlinkedPersonId, removedClaims } = await beeperTribe.unlinkParticipant({
    conversationId, sourceUserId,
  });
  if (unlinkedPersonId) req.app.get('io')?.emit('tribe:changed', { personId: unlinkedPersonId });
  res.json({ participant, unlinkedPersonId, removedClaims });
}));

// Create a new Tribe person from a Beeper participant's own display name and
// link it in the same action — the other half of #10 decision 4.
router.post('/beeper/link-new', asyncHandler(async (req, res) => {
  const data = validateRequest(beeperCreateAndLinkSchema, req.body);
  const result = await beeperTribe.createPersonAndLinkParticipant(data);
  req.app.get('io')?.emit('tribe:changed', { personId: result.person.id });
  res.status(201).json(result);
}));

// Unlink one Beeper identity claim (#99) — the Tribe person form's
// per-identity "Unlink" action. `identityId` is the `tribe_identities.id`
// the person read model's `identities[]` carries, not a participant key.
router.delete('/beeper/identities/:identityId', asyncHandler(async (req, res) => {
  const identity = await beeperTribe.unlinkIdentity(req.params.identityId);
  if (!identity) throw new ServerError('Identity not found', { status: 404 });
  req.app.get('io')?.emit('tribe:changed', { personId: identity.personId });
  res.json({ success: true });
}));

export default router;
