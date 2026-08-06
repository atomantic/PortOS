import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as x from '../services/x.js';

const router = Router();
const uuid = z.string().uuid();
const username = z.preprocess((value) => typeof value === 'string' ? value.trim().replace(/^@/, '') : value, z.string().regex(/^[A-Za-z0-9_]{1,15}$/, 'must be an X username'));
const accountSchema = z.object({
  label: z.string().trim().min(1).max(120),
  username,
  enabled: z.boolean().optional(),
  notes: z.string().max(4_000).optional(),
}).strict();
const accountUpdateSchema = accountSchema.partial().strict();
const draftSchema = z.object({ accountId: uuid, body: z.string().trim().min(1).max(4_000) }).strict();
const reviewSchema = z.object({ state: z.enum(['pending_review', 'approved', 'rejected']), reviewNote: z.string().max(2_000).optional() }).strict();
const handoffSchema = z.object({ kind: z.enum(['profile', 'latest', 'people', 'settings']) }).strict();

const requireId = (value, label = 'ID') => {
  if (!uuid.safeParse(value).success) throw new ServerError(`Invalid ${label}`, { status: 400 });
};
const emitChanged = (req, accountId) => req.app.get('io')?.emit('x:changed', { accountId });

router.get('/capabilities', (_req, res) => res.json({
  readTransport: 'managed-browser',
  reads: ['profile', 'latest', 'people'],
  writes: ['draft', 'manual-compose-handoff'],
  automaticPublishing: false,
}));

router.get('/accounts', asyncHandler(async (_req, res) => res.json({ accounts: await x.listAccounts() })));

router.post('/accounts', asyncHandler(async (req, res) => {
  const account = await x.createAccount(validateRequest(accountSchema, req.body));
  emitChanged(req, account.id);
  res.status(201).json(account);
}));

router.get('/accounts/:id', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'account ID');
  const account = await x.getAccount(req.params.id);
  if (!account) throw new ServerError('X account not found', { status: 404 });
  res.json(account);
}));

router.patch('/accounts/:id', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'account ID');
  const account = await x.updateAccount(req.params.id, validateRequest(accountUpdateSchema, req.body));
  if (!account) throw new ServerError('X account not found', { status: 404 });
  emitChanged(req, account.id);
  res.json(account);
}));

router.delete('/accounts/:id', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'account ID');
  if (!await x.deleteAccount(req.params.id)) throw new ServerError('X account not found', { status: 404 });
  emitChanged(req, req.params.id);
  res.status(204).send();
}));

router.post('/accounts/:id/sync', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'account ID');
  const result = await x.syncAccount(req.params.id);
  if (!result) throw new ServerError('X account not found', { status: 404 });
  emitChanged(req, req.params.id);
  res.json(result);
}));

router.post('/accounts/:id/open', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'account ID');
  const { kind } = validateRequest(handoffSchema, req.body);
  const result = await x.openAccountDestination(req.params.id, kind);
  if (!result) throw new ServerError('X account not found', { status: 404 });
  res.json(result);
}));

router.get('/accounts/:id/posts', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'account ID');
  res.json({ posts: await x.listPosts(req.params.id) });
}));

router.get('/accounts/:id/drafts', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'account ID');
  res.json({ drafts: await x.listDrafts(req.params.id) });
}));

router.post('/drafts', asyncHandler(async (req, res) => {
  const draft = await x.createDraft(validateRequest(draftSchema, req.body));
  emitChanged(req, draft.accountId);
  res.status(201).json(draft);
}));

router.post('/drafts/:id/review', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'draft ID');
  const { state, reviewNote } = validateRequest(reviewSchema, req.body);
  const draft = await x.reviewDraft(req.params.id, state, reviewNote);
  if (!draft) throw new ServerError('X draft is not in a reviewable state', { status: 409 });
  emitChanged(req, draft.accountId);
  res.json(draft);
}));

router.post('/drafts/:id/open', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'draft ID');
  const draft = await x.openApprovedDraft(req.params.id);
  if (!draft) throw new ServerError('X draft is not approved or was already opened', { status: 409 });
  emitChanged(req, draft.accountId);
  res.json(draft);
}));

export default router;
