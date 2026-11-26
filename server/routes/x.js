import { emitToOperatorsOn } from '../services/socketIo.js';
import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import {
  xAccountSchema, xAccountUpdateSchema, xDraftCreateSchema, xDraftUpdateSchema,
  xHandoffSchema, xIdSchema, xReviewSchema,
} from '../lib/xValidation.js';
import * as x from '../services/x.js';

const router = Router();
const requireId = (value, label = 'ID') => {
  if (!xIdSchema.safeParse(value).success) throw new ServerError(`Invalid ${label}`, { status: 400 });
};
const requireAccount = async (id) => {
  if (!(await x.getAccount(id))) throw new ServerError('X account not found', { status: 404 });
};
const emitChanged = (req, accountId) => emitToOperatorsOn(req.app.get('io'), 'x:changed', { accountId });

router.get('/accounts', asyncHandler(async (_req, res) => res.json({ accounts: await x.listAccounts() })));

router.post('/accounts', asyncHandler(async (req, res) => {
  const account = await x.createAccount(validateRequest(xAccountSchema, req.body));
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
  const account = await x.updateAccount(req.params.id, validateRequest(xAccountUpdateSchema, req.body));
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

// Sync and destination open execute CDP browser automation or handoffs on the host;
// draft review authorizes a public post and compose open launches the CDP compose
// view. All four require operator authority via the central host-control gate.
router.post('/accounts/:id/sync', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'account ID');
  const result = await x.syncAccount(req.params.id);
  if (!result) throw new ServerError('X account not found', { status: 404 });
  emitChanged(req, req.params.id);
  res.json(result);
}));

router.post('/accounts/:id/open', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'account ID');
  const { kind } = validateRequest(xHandoffSchema, req.body);
  const result = await x.openAccountDestination(req.params.id, kind);
  if (!result) throw new ServerError('X account not found', { status: 404 });
  res.json(result);
}));

router.get('/accounts/:id/posts', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'account ID');
  await requireAccount(req.params.id);
  res.json({ posts: await x.listPosts(req.params.id) });
}));

router.get('/accounts/:id/drafts', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'account ID');
  await requireAccount(req.params.id);
  res.json({ drafts: await x.listDrafts(req.params.id) });
}));

router.post('/drafts', asyncHandler(async (req, res) => {
  const draft = await x.createDraft(validateRequest(xDraftCreateSchema, req.body));
  emitChanged(req, draft.accountId);
  res.status(201).json(draft);
}));

router.patch('/drafts/:id', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'draft ID');
  const draft = await x.updateDraft(req.params.id, validateRequest(xDraftUpdateSchema, req.body ?? {}));
  if (!draft) throw new ServerError('Only saved or rejected X drafts can be edited', { status: 409 });
  emitChanged(req, draft.accountId);
  res.json(draft);
}));

router.delete('/drafts/:id', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'draft ID');
  const accountId = await x.deleteDraft(req.params.id);
  if (!accountId) throw new ServerError('X draft not found', { status: 404 });
  emitChanged(req, accountId);
  res.status(204).send();
}));

router.post('/drafts/:id/review', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'draft ID');
  const { state, reviewNote } = validateRequest(xReviewSchema, req.body);
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
