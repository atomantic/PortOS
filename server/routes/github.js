import express from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, githubRepoUpdateSchema, githubSecretSchema, githubAccountCreateSchema, githubAccountUpdateSchema,
  githubNotificationsQuerySchema, githubNotificationsSyncSchema, githubNotificationsClearSchema, githubNotificationActionSchema, githubDeploymentReviewSchema, GITHUB_NOTIFICATION_THREAD_ID_RE,
  githubNotificationCadenceSchema, githubAuditApplySchema } from '../lib/validation.js';
import * as githubService from '../services/github.js';
import * as githubAccounts from '../services/githubAccounts.js';
import * as githubNotifications from '../services/githubNotifications.js';
import * as githubAudit from '../services/githubNotificationAudit.js';
import * as githubDeployment from '../services/githubNotificationDeployment.js';
import { requestHasHostControl } from '../services/authGate.js';

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
 * POST /api/github/notifications/sync — fetch unread notifications from GitHub.
 * Open as a refresh; Assist/Autopilot run only for a caller with host control
 * (lib/hostControlRoutes.js, #12952).
 */
router.post('/notifications/sync', asyncHandler(async (req, res) => {
  const { accountId } = validateRequest(githubNotificationsSyncSchema, req.body ?? {});
  const options = { automate: requestHasHostControl(req) };
  const results = accountId
    ? [{ ...(await githubNotifications.syncAccountNotifications(accountId, options)), ok: true }]
    : await githubNotifications.syncAllNotifications(options);
  res.json({ results });
}));

/**
 * POST /api/github/notifications/clear-finished — mark every open closed,
 * merged, folded-duplicate or PR-workflow thread done on GitHub
 */
router.post('/notifications/clear-finished', asyncHandler(async (req, res) => {
  const { accountId } = validateRequest(githubNotificationsClearSchema, req.body ?? {});
  res.json(await githubNotifications.clearFinishedNotifications({ accountId }));
}));

const threadIdParam = (req) => {
  if (!GITHUB_NOTIFICATION_THREAD_ID_RE.test(req.params.threadId)) {
    throw new ServerError('Invalid notification thread id', { status: 400 });
  }
  return req.params.threadId;
};

/**
 * GET /api/github/notifications/:accountId/:threadId — one thread with its triage evidence and action log
 */
router.get('/notifications/:accountId/:threadId', asyncHandler(async (req, res) => {
  res.json(await githubNotifications.getNotification(req.params.accountId, threadIdParam(req)));
}));

/**
 * POST /api/github/notifications/:accountId/:threadId — read / done / reopen / mute / unsubscribe / resubscribe
 */
router.post('/notifications/:accountId/:threadId', asyncHandler(async (req, res) => {
  const { action } = validateRequest(githubNotificationActionSchema, req.body ?? {});
  res.json(await githubNotifications.applyNotificationAction(req.params.accountId, threadIdParam(req), action));
}));

/**
 * POST /api/github/notifications/:accountId/:threadId/agent — Resolve with agent: queue the thread's lane now
 */
router.post('/notifications/:accountId/:threadId/agent', asyncHandler(async (req, res) => {
  res.json(await githubNotifications.resolveWithAgent(req.params.accountId, threadIdParam(req)));
}));

/**
 * GET /api/github/notifications/:accountId/:threadId/deployment — the environments a waiting run needs you to approve
 */
router.get('/notifications/:accountId/:threadId/deployment', asyncHandler(async (req, res) => {
  res.json(await githubDeployment.getDeploymentReview(req.params.accountId, threadIdParam(req)));
}));

/**
 * POST /api/github/notifications/:accountId/:threadId/deployment — approve or reject those environments
 */
router.post('/notifications/:accountId/:threadId/deployment', asyncHandler(async (req, res) => {
  const body = validateRequest(githubDeploymentReviewSchema, req.body ?? {});
  res.json(await githubDeployment.reviewDeployment(req.params.accountId, threadIdParam(req), body));
}));

/**
 * GET /api/github/automations — the notification check's cadence and each account's last run
 */
router.get('/automations', asyncHandler(async (req, res) => {
  res.json(await githubNotifications.getAutomationsOverview());
}));

/**
 * PUT /api/github/automations/schedule — weekday 15-minute checks, or Run now only
 */
router.put('/automations/schedule', asyncHandler(async (req, res) => {
  const { cadence } = validateRequest(githubNotificationCadenceSchema, req.body ?? {});
  res.json(await githubNotifications.setNotificationCadence(cadence));
}));

const numericIdParam = (req) => {
  if (!/^\d{1,18}$/.test(req.params.id)) throw new ServerError('Invalid id', { status: 400 });
  return req.params.id;
};

/**
 * GET /api/github/automations/activity — recent Assist actions, newest first
 */
router.get('/automations/activity', asyncHandler(async (req, res) => {
  res.json({ actions: await githubNotifications.listAutomationActivity() });
}));

/**
 * POST /api/github/automations/activity/:id/undo — reverse one Assist action (reopen a done thread, unmute)
 */
router.post('/automations/activity/:id/undo', asyncHandler(async (req, res) => {
  res.json(await githubNotifications.undoAutomationAction(numericIdParam(req)));
}));

/**
 * GET /api/github/automations/rules — rules learned from the operator's corrections
 */
router.get('/automations/rules', asyncHandler(async (req, res) => {
  res.json({ rules: await githubNotifications.listLearnedRules() });
}));

/**
 * DELETE /api/github/automations/rules/:id — forget one learned rule
 */
router.delete('/automations/rules/:id', asyncHandler(async (req, res) => {
  res.json(await githubNotifications.deleteLearnedRule(numericIdParam(req)));
}));

/**
 * GET /api/github/audit-changes — changes applied from audit cards, newest first
 */
router.get('/audit-changes', asyncHandler(async (req, res) => {
  res.json({ changes: await githubAudit.listAuditChanges() });
}));

/**
 * POST /api/github/audit-changes/:id/undo — re-watch the repo or re-subscribe the muted threads
 */
router.post('/audit-changes/:id/undo', asyncHandler(async (req, res) => {
  res.json(await githubAudit.undoAuditChange(numericIdParam(req)));
}));

/**
 * GET /api/github/audit/:accountId — the account's latest audit, or null
 */
router.get('/audit/:accountId', asyncHandler(async (req, res) => {
  res.json({ audit: await githubAudit.getLastAudit(req.params.accountId) });
}));

/**
 * POST /api/github/audit/:accountId — audit the last 30 days of notifications against what was done about them
 */
router.post('/audit/:accountId', asyncHandler(async (req, res) => {
  res.json({ audit: await githubAudit.runAccountAudit(req.params.accountId) });
}));

/**
 * POST /api/github/audit/:accountId/apply — apply one audit suggestion (unwatch, mute handled threads)
 */
router.post('/audit/:accountId/apply', asyncHandler(async (req, res) => {
  const { suggestionId } = validateRequest(githubAuditApplySchema, req.body ?? {});
  res.json(await githubAudit.applyAuditSuggestion(req.params.accountId, suggestionId));
}));

export default router;
