/**
 * Moltworld Tools Routes
 *
 * HTTP endpoints for Moltworld voxel world interactions:
 * joining/moving, building, exploring, and status checks.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validate, moltworldJoinSchema, moltworldBuildSchema, moltworldExploreSchema } from '../lib/validation.js';
import * as platformAccounts from '../services/platformAccounts.js';
import * as agentPersonalities from '../services/agentPersonalities.js';
import * as agentActivity from '../services/agentActivity.js';
import { MoltworldClient } from '../integrations/moltworld/index.js';

const router = Router();

/**
 * Get authenticated MoltworldClient for an account
 */
async function getClientAndAgent(accountId, agentId) {
  const account = await platformAccounts.getAccountWithCredentials(accountId);
  if (!account) {
    throw new ServerError('Account not found', { status: 404, code: 'NOT_FOUND' });
  }
  if (account.status !== 'active') {
    throw new ServerError(`Account not active: ${account.status}`, { status: 400, code: 'ACCOUNT_INACTIVE' });
  }
  if (account.platform !== 'moltworld') {
    throw new ServerError('Account is not a Moltworld account', { status: 400, code: 'WRONG_PLATFORM' });
  }

  const agent = agentId ? await agentPersonalities.getAgentById(agentId) : null;

  const client = new MoltworldClient(
    account.credentials.apiKey,
    account.credentials.agentId
  );
  return { client, agent, account };
}

// POST /join — Move agent in the world (also heartbeat)
router.post('/join', asyncHandler(async (req, res) => {
  const { success, data, errors } = validate(moltworldJoinSchema, req.body);
  if (!success) {
    throw new ServerError('Validation failed', { status: 400, code: 'VALIDATION_ERROR', context: { errors } });
  }

  console.log(`🌍 POST /api/agents/tools/moltworld/join account=${data.accountId}`);

  const { client, account } = await getClientAndAgent(data.accountId, null);
  const result = await client.joinWorld({
    name: account.credentials.username,
    x: data.x ?? 0,
    y: data.y ?? 0,
    thinking: data.thinking,
    say: data.say,
    sayTo: data.sayTo
  });

  await platformAccounts.recordActivity(data.accountId);
  res.json(result);
}));

// POST /build — Place or remove blocks
router.post('/build', asyncHandler(async (req, res) => {
  const { success, data, errors } = validate(moltworldBuildSchema, req.body);
  if (!success) {
    throw new ServerError('Validation failed', { status: 400, code: 'VALIDATION_ERROR', context: { errors } });
  }

  console.log(`🧱 POST /api/agents/tools/moltworld/build account=${data.accountId}`);

  const { client, agent } = await getClientAndAgent(data.accountId, data.agentId);
  const result = await client.build({
    x: data.x,
    y: data.y,
    z: data.z,
    type: data.type || 'stone',
    action: data.action || 'place'
  });

  await platformAccounts.recordActivity(data.accountId);
  if (data.agentId) {
    await agentActivity.logActivity({
      agentId: data.agentId,
      accountId: data.accountId,
      action: 'build',
      params: { x: data.x, y: data.y, z: data.z, type: data.type, action: data.action },
      status: 'completed',
      result: { type: 'build', ...result },
      timestamp: new Date().toISOString()
    });
  }

  res.json(result);
}));

// POST /explore — Move to coordinates and think
router.post('/explore', asyncHandler(async (req, res) => {
  const { success, data, errors } = validate(moltworldExploreSchema, req.body);
  if (!success) {
    throw new ServerError('Validation failed', { status: 400, code: 'VALIDATION_ERROR', context: { errors } });
  }

  console.log(`🌍 POST /api/agents/tools/moltworld/explore agent=${data.agentId}`);

  const { client, agent, account } = await getClientAndAgent(data.accountId, data.agentId);

  // Use provided coordinates or random position
  const x = data.x ?? Math.floor(Math.random() * 480) - 240;
  const y = data.y ?? Math.floor(Math.random() * 480) - 240;

  const result = await client.joinWorld({
    name: account.credentials.username,
    x,
    y,
    thinking: data.thinking || `Exploring area (${x}, ${y})...`
  });

  await platformAccounts.recordActivity(data.accountId);
  if (data.agentId) {
    await agentActivity.logActivity({
      agentId: data.agentId,
      accountId: data.accountId,
      action: 'explore',
      params: { x, y, thinking: data.thinking },
      status: 'completed',
      result: { type: 'explore', x, y, nearby: result?.nearby?.length || 0 },
      timestamp: new Date().toISOString()
    });
  }

  res.json({ x, y, ...result });
}));

// GET /status — Agent position, balance, nearby agents
router.get('/status', asyncHandler(async (req, res) => {
  const { accountId } = req.query;
  if (!accountId) {
    throw new ServerError('accountId required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  console.log(`🌍 GET /api/agents/tools/moltworld/status account=${accountId}`);

  const { client } = await getClientAndAgent(accountId);
  const [profile, balance] = await Promise.all([
    client.getProfile(),
    client.getBalance()
  ]);

  res.json({ profile, balance });
}));

// GET /balance — SIM token balance
router.get('/balance', asyncHandler(async (req, res) => {
  const { accountId } = req.query;
  if (!accountId) {
    throw new ServerError('accountId required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  console.log(`💰 GET /api/agents/tools/moltworld/balance account=${accountId}`);

  const { client } = await getClientAndAgent(accountId);
  const result = await client.getBalance();
  res.json(result);
}));

// GET /rate-limits — Rate limit status
router.get('/rate-limits', asyncHandler(async (req, res) => {
  const { accountId } = req.query;
  if (!accountId) {
    throw new ServerError('accountId required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  console.log(`⏱️ GET /api/agents/tools/moltworld/rate-limits account=${accountId}`);

  const { client } = await getClientAndAgent(accountId);
  const rateLimits = client.getRateLimitStatus();
  res.json(rateLimits);
}));

export default router;
