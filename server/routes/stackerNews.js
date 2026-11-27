import {
  uuid,
  accountSchema,
  accountUpdateSchema,
  territorySchema,
  actionSchema,
  verifySchema,
  reviewSchema,
  feedbackSchema,
} from '../lib/stackerNewsValidation.js';
import { emitToOperatorsOn } from '../services/socketIo.js';
import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import * as stackerNews from '../services/stackerNews.js';
import { reconcileStackerNewsSchedulers } from '../services/stackerNewsScheduler.js';

const router = Router();

const requireId = (value, label = 'ID') => {
  if (!uuid.safeParse(value).success) throw new ServerError(`Invalid ${label}`, { status: 400 });
};
const requireAccount = async (id) => {
  if (!(await stackerNews.getAccount(id))) throw new ServerError('Stacker News account not found', { status: 404 });
};
const emitChanged = (req, accountId) => emitToOperatorsOn(req.app.get('io'), 'stacker-news:changed', { accountId });

router.get('/accounts', asyncHandler(async (_req, res) => res.json({ accounts: await stackerNews.listAccounts() })));

router.post('/accounts', asyncHandler(async (req, res) => {
  const data = validateRequest(accountSchema, req.body);
  const account = await stackerNews.createAccount(data);
  await reconcileStackerNewsSchedulers();
  emitChanged(req, account.id);
  res.status(201).json(account);
}));

router.get('/accounts/:id', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'account ID');
  const account = await stackerNews.getAccount(req.params.id);
  if (!account) throw new ServerError('Stacker News account not found', { status: 404 });
  res.json(account);
}));

router.patch('/accounts/:id', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'account ID');
  const data = validateRequest(accountUpdateSchema, req.body);
  const account = await stackerNews.updateAccount(req.params.id, data);
  if (!account) throw new ServerError('Stacker News account not found', { status: 404 });
  await reconcileStackerNewsSchedulers();
  emitChanged(req, account.id);
  res.json(account);
}));

router.delete('/accounts/:id', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'account ID');
  if (!await stackerNews.deleteAccount(req.params.id)) throw new ServerError('Stacker News account not found', { status: 404 });
  await reconcileStackerNewsSchedulers();
  emitChanged(req, req.params.id);
  res.status(204).send();
}));

router.post('/accounts/:id/verify', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'account ID');
  const status = await stackerNews.verifyConnection(req.params.id, validateRequest(verifySchema, req.body || {}));
  if (!status) throw new ServerError('Stacker News account not found', { status: 404 });
  res.json(status);
}));

router.post('/accounts/:id/browser-identity', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'account ID');
  const status = await stackerNews.getBrowserIdentity(req.params.id);
  if (!status) throw new ServerError('Stacker News account not found', { status: 404 });
  res.json(status);
}));

router.post('/accounts/:id/sync', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'account ID');
  const result = await stackerNews.syncAccount(req.params.id, { force: true });
  if (!result) throw new ServerError('Stacker News account not found', { status: 404 });
  emitChanged(req, req.params.id);
  res.json(result);
}));

router.get('/accounts/:id/territories', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'account ID');
  await requireAccount(req.params.id);
  res.json({ territories: await stackerNews.listTerritories(req.params.id) });
}));

router.post('/territories', asyncHandler(async (req, res) => {
  const data = validateRequest(territorySchema, req.body);
  const territory = await stackerNews.createTerritory(data);
  await reconcileStackerNewsSchedulers();
  emitChanged(req, territory.accountId);
  res.status(201).json(territory);
}));

router.patch('/territories/:id', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'territory ID');
  const data = validateRequest(territorySchema.omit({ accountId: true }).partial().strict(), req.body);
  const territory = await stackerNews.updateTerritory(req.params.id, data);
  if (!territory) throw new ServerError('Stacker News territory not found', { status: 404 });
  await reconcileStackerNewsSchedulers();
  emitChanged(req, territory.accountId);
  res.json(territory);
}));

router.delete('/territories/:id', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'territory ID');
  const accountId = await stackerNews.deleteTerritory(req.params.id);
  if (!accountId) throw new ServerError('Stacker News territory not found', { status: 404 });
  await reconcileStackerNewsSchedulers();
  emitChanged(req, accountId);
  res.status(204).send();
}));

router.get('/accounts/:id/items', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'account ID');
  await requireAccount(req.params.id);
  res.json({ items: await stackerNews.listItems(req.params.id) });
}));

router.post('/items/:id/analyze', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'item ID');
  const analysis = await stackerNews.analyzeItem(req.params.id);
  if (!analysis) throw new ServerError('Stacker News item not found', { status: 404 });
  emitChanged(req, analysis.item.accountId);
  res.json(analysis);
}));

router.post('/analyses/:id/feedback', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'analysis ID');
  const { feedback } = validateRequest(feedbackSchema, req.body);
  const analysis = await stackerNews.setAnalysisFeedback(req.params.id, feedback);
  if (!analysis) throw new ServerError('Stacker News analysis not found', { status: 404 });
  res.json(analysis);
}));

router.get('/accounts/:id/actions', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'account ID');
  await requireAccount(req.params.id);
  res.json({ actions: await stackerNews.listActions(req.params.id) });
}));

router.post('/actions', asyncHandler(async (req, res) => {
  const { action, created, changed } = await stackerNews.createActionWithOutcome(validateRequest(actionSchema, req.body));
  if (changed) emitChanged(req, action.accountId);
  res.status(created ? 201 : 200).json(action);
}));

router.post('/actions/:id/review', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'action ID');
  const { state, reviewNote } = validateRequest(reviewSchema, req.body);
  const action = await stackerNews.updateActionState(req.params.id, state, reviewNote);
  if (!action) throw new ServerError('Action is not pending review', { status: 409 });
  emitChanged(req, action.accountId);
  res.json(action);
}));

router.post('/actions/:id/execute', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'action ID');
  const action = await stackerNews.executeApprovedAction(req.params.id);
  if (!action) throw new ServerError('Action is not approved or is already executing', { status: 409 });
  emitChanged(req, action.accountId);
  res.json(action);
}));

export default router;
