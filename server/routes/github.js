import express from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest, githubRepoUpdateSchema, githubSecretSchema } from '../lib/validation.js';
import * as githubService from '../services/github.js';

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
  res.json({ repos: data.repos, lastRepoSync: data.lastRepoSync });
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
    return res.status(400).json({ error: 'Invalid secret name. Use uppercase letters, digits, and underscores only.' });
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
    return res.status(400).json({ error: 'Invalid secret name.' });
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

export default router;
