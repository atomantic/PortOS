import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as stackerNews from '../services/stackerNews.js';
import { reconcileStackerNewsSchedulers } from '../services/stackerNewsScheduler.js';

const router = Router();
const uuid = z.string().uuid();
const ruleStrings = z.array(z.string().trim().min(1).max(300)).max(50).optional();
const rules = z.object({
  guidance: z.string().max(4_000).optional(),
  tone: z.string().max(500).optional(),
  allowedThemes: ruleStrings,
  disallowedThemes: ruleStrings,
  escalationCues: ruleStrings,
  desiredEngagement: ruleStrings,
  actionBudget: z.object({
    maxPerHour: z.number().int().min(1).max(50).optional(),
    maxPerDay: z.number().int().min(1).max(200).optional(),
    minMinutesBetween: z.number().int().min(0).max(1_440).optional(),
  }).strict().optional(),
}).strict().optional();
const accountSchema = z.object({
  label: z.string().trim().min(1).max(120),
  username: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/, 'must be a Stacker News username'),
  apiKey: z.string().trim().min(1).max(400).optional(),
  readTransport: z.enum(['browser', 'api']).optional(),
  enabled: z.boolean().optional(),
  monitoringEnabled: z.boolean().optional(),
  monitoringIntervalMinutes: z.number().int().min(5).max(1_440).optional(),
  analysisEnabled: z.boolean().optional(),
  textModel: z.string().trim().max(200).optional(),
  visionModel: z.string().trim().max(200).optional(),
  rules,
}).strict();
const accountUpdateSchema = accountSchema.partial().extend({ apiKey: z.string().trim().max(400).optional() }).strict();
const territorySchema = z.object({
  accountId: uuid,
  slug: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_-]+$/),
  label: z.string().trim().max(160).optional(),
  isOwned: z.boolean().optional(),
  monitoringEnabled: z.boolean().nullable().optional(),
  inheritAccountRules: z.boolean().optional(),
  rules,
}).strict();
const itemSchema = z.object({
  accountId: uuid,
  territoryId: uuid.nullable().optional(),
  remoteId: z.string().trim().min(1).max(200),
  kind: z.enum(['post', 'comment']),
  authorName: z.string().max(120).optional(),
  title: z.string().max(2_000).optional(),
  body: z.string().max(40_000).optional(),
  sourceUrl: z.string().url().max(2_000).optional(),
  imageUrls: z.array(z.string().url().max(2_000)).max(12).optional(),
  remoteCreatedAt: z.iso.datetime().nullable().optional(),
  remoteUpdatedAt: z.iso.datetime().nullable().optional(),
}).strict();
const actionBase = { accountId: uuid, itemId: uuid.nullable().optional(), territoryId: uuid.nullable().optional() };
const actionSchema = z.discriminatedUnion('kind', [
  z.object({ ...actionBase, kind: z.enum(['draft_post', 'publish_post']), territoryId: uuid, destination: z.literal('').optional(), payload: z.object({ title: z.string().trim().min(1).max(200), body: z.string().max(40_000).optional() }).strict() }).strict(),
  z.object({ ...actionBase, kind: z.enum(['draft_comment', 'publish_comment']), itemId: uuid, destination: z.literal('').optional(), payload: z.object({ body: z.string().trim().min(1).max(40_000) }).strict() }).strict(),
  z.object({ ...actionBase, kind: z.literal('open_browser'), destination: z.enum(['item', 'territory_settings']), payload: z.object({}).strict().optional() }).strict(),
  z.object({ ...actionBase, kind: z.literal('territory_setting'), territoryId: uuid, destination: z.literal('territory_settings').optional(), payload: z.object({}).strict().optional() }).strict(),
]).superRefine((value, ctx) => {
  if (value.kind === 'open_browser' && value.destination === 'item' && !value.itemId) {
    ctx.addIssue({ code: 'custom', message: 'item destination requires itemId' });
  }
  if (value.kind === 'open_browser' && value.destination === 'territory_settings' && !value.territoryId) {
    ctx.addIssue({ code: 'custom', message: 'territory settings destination requires territoryId' });
  }
});
// Optional override so "Check API identity" can test the stored key even while
// the account reads through the browser; omitted, it uses the account's own
// configured read transport.
const verifySchema = z.object({ transport: z.enum(['browser', 'api']).optional() }).strict();
const reviewSchema = z.object({ state: z.enum(['approved', 'rejected']), reviewNote: z.string().max(2_000).optional() }).strict();
const feedbackSchema = z.object({ feedback: z.string().trim().min(1).max(4_000) }).strict();

const requireId = (value, label = 'ID') => {
  if (!uuid.safeParse(value).success) throw new ServerError(`Invalid ${label}`, { status: 400 });
};
const emitChanged = (req, accountId) => req.app.get('io')?.emit('stacker-news:changed', { accountId });

router.get('/capabilities', (_req, res) => res.json(stackerNews.stackerNewsCapabilities));

router.get('/accounts', asyncHandler(async (_req, res) => res.json({ accounts: await stackerNews.listAccounts() })));

router.post('/accounts', asyncHandler(async (req, res) => {
  const account = await stackerNews.createAccount(validateRequest(accountSchema, req.body));
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
  const account = await stackerNews.updateAccount(req.params.id, validateRequest(accountUpdateSchema, req.body));
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
  res.json({ territories: await stackerNews.listTerritories(req.params.id) });
}));

router.post('/territories', asyncHandler(async (req, res) => {
  const territory = await stackerNews.createTerritory(validateRequest(territorySchema, req.body));
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
  res.json({ items: await stackerNews.listItems(req.params.id) });
}));

router.post('/items', asyncHandler(async (req, res) => res.status(201).json(await stackerNews.ingestItem(validateRequest(itemSchema, req.body)))));

router.post('/items/:id/analyze', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'item ID');
  const analysis = await stackerNews.analyzeItem(req.params.id);
  if (!analysis) throw new ServerError('Stacker News item not found', { status: 404 });
  res.json(analysis);
}));

router.get('/items/:id/analyses', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'item ID');
  res.json({ analyses: await stackerNews.listAnalyses(req.params.id) });
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
  res.json({ actions: await stackerNews.listActions(req.params.id) });
}));

router.get('/actions/:id/events', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'action ID');
  res.json({ events: await stackerNews.listActionEvents(req.params.id) });
}));

router.post('/actions', asyncHandler(async (req, res) => {
  const action = await stackerNews.createAction(validateRequest(actionSchema, req.body));
  emitChanged(req, action.accountId);
  res.status(201).json(action);
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
