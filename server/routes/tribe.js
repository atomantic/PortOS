import {
  personSchema,
  personUpdateSchema,
  touchpointSchema,
  memoryLinkSchema,
  beeperLinkSchema,
  beeperUnlinkSchema,
  beeperCreateAndLinkSchema,
  outreachDraftSchema,
  listQuerySchema,
  tribeGuidSchema,
} from '../lib/tribeValidation.js';
import { emitToOperatorsOn } from '../services/socketIo.js';
import { Router } from 'express';
import { isPaginationRequested, paginateArray, paginationQuerySchema, parsePagination } from '../lib/queryValidation.js';

import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import * as tribe from '../services/tribe.js';
import * as tribeOutreach from '../services/tribeOutreach.js';
import * as beeperTribe from '../services/beeper/beeperTribe.js';

const router = Router();

// Validate UUID path params before they hit the UUID-typed columns; otherwise a
// non-UUID segment raises a raw Postgres "invalid input syntax for type uuid"
// 500 (leaking the column type) instead of a clean 400.
const guidParam = (label) => (req, res, next, value) => {
  if (!tribeGuidSchema.safeParse(value).success) {
    return next(new ServerError(`Invalid ${label}`, { status: 400 }));
  }
  return next();
};
router.param('id', guidParam('person id'));
router.param('memoryId', guidParam('memory id'));
router.param('identityId', guidParam('identity id'));

router.get('/people', asyncHandler(async (req, res) => {
  const query = validateRequest(listQuerySchema, req.query);
  const { search, ring } = query;
  const people = await tribe.listPeople({
    search: search || undefined,
    ring: ring || undefined,
  });
  res.json(isPaginationRequested(query) ? paginateArray(people, query, { maxLimit: 500 }) : { people });
}));

// Care summary — overdue-contact status computed server-side (single source of
// truth) for the dashboard widget and proactive-alerts check.
router.get('/care', asyncHandler(async (req, res) => {
  const { limit } = parsePagination(validateRequest(paginationQuerySchema, req.query), { defaultLimit: 5, maxLimit: 50 });
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
  const { limit } = parsePagination(validateRequest(paginationQuerySchema, req.query), { defaultLimit: 8, maxLimit: 50 });
  const threads = await tribeOutreach.findUnansweredTribeThreads({ limit });
  res.json({ threads });
}));

// Generate a grounded outreach draft for one unanswered thread and file it through
// the existing draft-then-approve pipeline. This is the user-action-gated LLM step
// — it never auto-sends. The client shows the returned draft for review.
router.post('/outreach/draft', asyncHandler(async (req, res) => {
  const data = validateRequest(outreachDraftSchema, req.body);
  const result = await tribeOutreach.generateOutreachDraft(data);
  emitToOperatorsOn(req.app.get('io'), 'messages:draft:created', { draftId: result.draft.id });
  res.status(201).json(result);
}));

router.post('/people', asyncHandler(async (req, res) => {
  const data = validateRequest(personSchema, req.body);
  const person = await tribe.createPerson(data);
  emitToOperatorsOn(req.app.get('io'), 'tribe:changed', { personId: person.id });
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
  emitToOperatorsOn(req.app.get('io'), 'tribe:changed', { personId: person.id });
  res.json(person);
}));

router.delete('/people/:id', asyncHandler(async (req, res) => {
  const deleted = await tribe.deletePerson(req.params.id);
  if (!deleted) throw new ServerError('Person not found', { status: 404 });
  emitToOperatorsOn(req.app.get('io'), 'tribe:changed', { personId: req.params.id });
  res.json({ success: true });
}));

router.get('/people/:id/touchpoints', asyncHandler(async (req, res) => {
  const { limit } = parsePagination(validateRequest(paginationQuerySchema, req.query), { defaultLimit: 50, maxLimit: 200 });
  const touchpoints = await tribe.listTouchpoints(req.params.id, limit);
  res.json({ touchpoints });
}));

router.post('/people/:id/touchpoints', asyncHandler(async (req, res) => {
  const data = validateRequest(touchpointSchema, req.body);
  const touchpoint = await tribe.createTouchpoint(req.params.id, data);
  emitToOperatorsOn(req.app.get('io'), 'tribe:changed', { personId: req.params.id });
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
  emitToOperatorsOn(req.app.get('io'), 'tribe:changed', { personId: req.params.id });
  res.status(201).json({ links });
}));

router.delete('/people/:id/memories/:memoryId', asyncHandler(async (req, res) => {
  await tribe.unlinkMemory(req.params.id, req.params.memoryId);
  emitToOperatorsOn(req.app.get('io'), 'tribe:changed', { personId: req.params.id });
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
  emitToOperatorsOn(req.app.get('io'), 'tribe:changed', { personId });
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
  if (unlinkedPersonId) emitToOperatorsOn(req.app.get('io'), 'tribe:changed', { personId: unlinkedPersonId });
  res.json({ participant, unlinkedPersonId, removedClaims });
}));

// Create a new Tribe person from a Beeper participant's own display name and
// link it in the same action — the other half of #10 decision 4.
router.post('/beeper/link-new', asyncHandler(async (req, res) => {
  const data = validateRequest(beeperCreateAndLinkSchema, req.body);
  const result = await beeperTribe.createPersonAndLinkParticipant(data);
  emitToOperatorsOn(req.app.get('io'), 'tribe:changed', { personId: result.person.id });
  res.status(201).json(result);
}));

// Unlink one Beeper identity claim (#99) — the Tribe person form's
// per-identity "Unlink" action. `identityId` is the `tribe_identities.id`
// the person read model's `identities[]` carries, not a participant key.
router.delete('/beeper/identities/:identityId', asyncHandler(async (req, res) => {
  const identity = await beeperTribe.unlinkIdentity(req.params.identityId);
  if (!identity) throw new ServerError('Identity not found', { status: 404 });
  emitToOperatorsOn(req.app.get('io'), 'tribe:changed', { personId: identity.personId });
  res.json({ success: true });
}));

export default router;
