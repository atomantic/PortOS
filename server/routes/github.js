import express from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, githubRepoUpdateSchema, githubSecretSchema, githubAccountCreateSchema, githubAccountUpdateSchema,
  githubNotificationsQuerySchema, githubNotificationsSyncSchema, githubNotificationActionSchema, GITHUB_NOTIFICATION_THREAD_ID_RE } from '../lib/validation.js';
import * as githubService from '../services/github.js';
import * as githubAccounts from '../services/githubAccounts.js';
import * as githubNotifications from '../services/githubNotifications.js';

const router = express.Router();

/**
 * GET /api/github/repos — cached repo list
 */
router.get('/repos', asyncHandler(async (req, res) => {
  const repos = await githubService.getRepos();
  res.json(repos);
}));

/**
 * POST /api/github/repos/sync — trigger gh repo list sync
 */
router.post('/repos/sync', asyncHandler(async (req, res) => {
  const data = await githubService.syncRepos();
  res.json({
    repos: data.repos,
    lastRepoSync: data.lastRepoSync,
    githubUser: data.githubUser,
    truncated: data.truncated,
  });
}));

/**
 * PUT /api/github/repos/:fullName — update repo flags/secrets
 */
router.put('/repos/:fullName', asyncHandler(async (req, res) => {
  const fullName = decodeURIComponent(req.params.fullName);
  const body = validateRequest(githubRepoUpdateSchema, req.body);
  const repo = await githubService.updateRepoFlags(fullName, body);
  res.json(repo);
}));

/**
 * POST /api/github/repos/:fullName/archive — archive a repo
 */
router.post('/repos/:fullName/archive', asyncHandler(async (req, res) => {
  const fullName = decodeURIComponent(req.params.fullName);
  const repo = await githubService.setRepoArchived(fullName, true);
  res.json(repo);
}));

/**
 * POST /api/github/repos/:fullName/unarchive — unarchive a repo
 */
router.post('/repos/:fullName/unarchive', asyncHandler(async (req, res) => {
  const fullName = decodeURIComponent(req.params.fullName);
  const repo = await githubService.setRepoArchived(fullName, false);
  res.json(repo);
}));

/**
 * GET /api/github/secrets — secret metadata (no values)
 */
router.get('/secrets', asyncHandler(async (req, res) => {
  const secrets = await githubService.getSecrets();
  res.json(secrets);
}));

/**
 * PUT /api/github/secrets/:name — set secret value + auto-sync to repos
 */
router.put('/secrets/:name', asyncHandler(async (req, res) => {
  const name = req.params.name;
  if (!/^[A-Z0-9_]{1,100}$/.test(name)) {
    throw new ServerError('Invalid secret name. Use uppercase letters, digits, and underscores only.', { status: 400 });
  }
  const { value } = validateRequest(githubSecretSchema, req.body);
  const result = await githubService.setSecret(name, value);
  res.json(result);
}));

/**
 * POST /api/github/secrets/:name/sync — re-sync existing secret to flagged repos
 */
router.post('/secrets/:name/sync', asyncHandler(async (req, res) => {
  const name = req.params.name;
  if (!/^[A-Z0-9_]{1,100}$/.test(name)) {
    throw new ServerError('Invalid secret name. Use uppercase letters, digits, and underscores only.', { status: 400 });
  }
  const result = await githubService.syncSecretToRepos(name);
  res.json(result);
}));

/**
 * GET /api/github/status — sync status
 */
router.get('/status', asyncHandler(async (req, res) => {
  const status = await githubService.getStatus();
  res.json(status);
}));

/**
 * GET /api/github/accounts — configured accounts (github.com + Enterprise hosts)
 */
router.get('/accounts', asyncHandler(async (req, res) => {
  res.json(await githubAccounts.listAccounts());
}));

router.post('/accounts', asyncHandler(async (req, res) => {
  const body = validateRequest(githubAccountCreateSchema, req.body);
  res.status(201).json(await githubAccounts.createAccount(body));
}));

router.put('/accounts/:id', asyncHandler(async (req, res) => {
  const body = validateRequest(githubAccountUpdateSchema, req.body);
  res.json(await githubAccounts.updateAccount(req.params.id, body));
}));

router.delete('/accounts/:id', asyncHandler(async (req, res) => {
  res.json(await githubAccounts.deleteAccount(req.params.id));
}));

/**
 * GET /api/github/accounts/:id/status — live `gh` sign-in probe for one account
 */
router.get('/accounts/:id/status', asyncHandler(async (req, res) => {
  res.json(await githubAccounts.getAccountStatus(req.params.id));
}));

/**
 * GET /api/github/notifications — stored inbox rows for one or every account
 */
router.get('/notifications', asyncHandler(async (req, res) => {
  const { accountId, view } = validateRequest(githubNotificationsQuerySchema, req.query);
  res.json(await githubNotifications.listNotifications({ accountId, view }));
}));

/**
 * POST /api/github/notifications/sync — fetch unread notifications from GitHub
 */
router.post('/notifications/sync', asyncHandler(async (req, res) => {
  const { accountId } = validateRequest(githubNotificationsSyncSchema, req.body ?? {});
  const results = accountId
    ? [{ ...(await githubNotifications.syncAccountNotifications(accountId)), ok: true }]
    : await githubNotifications.syncAllNotifications();
  res.json({ results });
}));

/**
 * POST /api/github/notifications/:accountId/:threadId — read / done / reopen / mute / unsubscribe / resubscribe
 */
router.post('/notifications/:accountId/:threadId', asyncHandler(async (req, res) => {
  const { action } = validateRequest(githubNotificationActionSchema, req.body ?? {});
  if (!GITHUB_NOTIFICATION_THREAD_ID_RE.test(req.params.threadId)) {
    throw new ServerError('Invalid notification thread id', { status: 400 });
  }
  res.json(await githubNotifications.applyNotificationAction(req.params.accountId, req.params.threadId, action));
}));

export default router;
