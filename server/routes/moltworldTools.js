/**
 * Moltworld Tools Routes
 *
 * HTTP endpoints for Moltworld voxel world interactions:
 * joining/moving, building, exploring, and status checks.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validate, moltworldJoinSchema, moltworldBuildSchema, moltworldExploreSchema, moltworldThinkSchema, moltworldSaySchema, moltworldQueueAddSchema } from '../lib/validation.js';
import * as platformAccounts from '../services/platformAccounts.js';
import * as agentPersonalities from '../services/agentPersonalities.js';
import * as agentActivity from '../services/agentActivity.js';
import { MoltworldClient } from '../integrations/moltworld/index.js';
import * as moltworldQueue from '../services/moltworldQueue.js';

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

  // Moltworld uses agentId for all API calls; fall back to apiKey which serves as the agent identifier
  const moltworldAgentId = account.credentials.agentId || account.credentials.apiKey;
  const client = new MoltworldClient(
    account.credentials.apiKey,
    moltworldAgentId
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

  const { client, account } = await getClientAndAgent(data.accountId, data.agentId);
  const result = await client.joinWorld({
    name: account.credentials.username,
    x: data.x ?? 0,
    y: data.y ?? 0,
    thinking: data.thinking,
    say: data.say,
    sayTo: data.sayTo
  });

  await platformAccounts.recordActivity(data.accountId);
  if (data.agentId) {
    await agentActivity.logActivity({
      agentId: data.agentId,
      accountId: data.accountId,
      action: 'mw_heartbeat',
      params: { x: data.x, y: data.y, thinking: data.thinking, say: data.say },
      status: 'completed',
      result: { agents: result?.agents?.length || 0, messages: result?.messages?.length || 0 },
      timestamp: new Date().toISOString()
    });
  }
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
      action: 'mw_build',
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
      action: 'mw_explore',
      params: { x, y, thinking: data.thinking },
      status: 'completed',
      result: { type: 'explore', x, y, nearby: result?.agents?.length || 0 },
      timestamp: new Date().toISOString()
    });
  }

  res.json({ x, y, ...result });
}));

// POST /think — Send a thought
router.post('/think', asyncHandler(async (req, res) => {
  const { success, data, errors } = validate(moltworldThinkSchema, req.body);
  if (!success) {
    throw new ServerError('Validation failed', { status: 400, code: 'VALIDATION_ERROR', context: { errors } });
  }

  console.log(`💭 POST /api/agents/tools/moltworld/think account=${data.accountId}`);

  const { client } = await getClientAndAgent(data.accountId, data.agentId);
  const result = await client.think(data.thought);

  await platformAccounts.recordActivity(data.accountId);
  if (data.agentId) {
    await agentActivity.logActivity({
      agentId: data.agentId,
      accountId: data.accountId,
      action: 'mw_think',
      params: { thought: data.thought },
      status: 'completed',
      result: { type: 'think' },
      timestamp: new Date().toISOString()
    });
  }
  res.json(result);
}));

// POST /say — Send a message (wraps join with say/sayTo params)
router.post('/say', asyncHandler(async (req, res) => {
  const { success, data, errors } = validate(moltworldSaySchema, req.body);
  if (!success) {
    throw new ServerError('Validation failed', { status: 400, code: 'VALIDATION_ERROR', context: { errors } });
  }

  console.log(`💬 POST /api/agents/tools/moltworld/say account=${data.accountId}`);

  const { client, account } = await getClientAndAgent(data.accountId, data.agentId);
  const result = await client.joinWorld({
    name: account.credentials.username,
    say: data.message,
    sayTo: data.sayTo
  });

  await platformAccounts.recordActivity(data.accountId);
  if (data.agentId) {
    await agentActivity.logActivity({
      agentId: data.agentId,
      accountId: data.accountId,
      action: 'mw_say',
      params: { message: data.message, sayTo: data.sayTo },
      status: 'completed',
      result: { type: 'say' },
      timestamp: new Date().toISOString()
    });
  }
  res.json(result);
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

// GET /queue/:agentId — Get queue for an agent
router.get('/queue/:agentId', asyncHandler(async (req, res) => {
  const { agentId } = req.params;
  console.log(`📋 GET /api/agents/tools/moltworld/queue/${agentId}`);
  const queue = moltworldQueue.getQueue(agentId);
  res.json(queue);
}));

// POST /queue — Add action to queue
router.post('/queue', asyncHandler(async (req, res) => {
  const { success, data, errors } = validate(moltworldQueueAddSchema, req.body);
  if (!success) {
    throw new ServerError('Validation failed', { status: 400, code: 'VALIDATION_ERROR', context: { errors } });
  }
  console.log(`📋 POST /api/agents/tools/moltworld/queue agentId=${data.agentId} action=${data.actionType}`);
  const item = moltworldQueue.addAction(data.agentId, data.actionType, data.params, data.scheduledFor);
  res.json(item);
}));

// DELETE /queue/:id — Remove pending item from queue
router.delete('/queue/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  console.log(`📋 DELETE /api/agents/tools/moltworld/queue/${id}`);
  const item = moltworldQueue.removeAction(id);
  if (!item) {
    throw new ServerError('Queue item not found or not pending', { status: 404, code: 'NOT_FOUND' });
  }
  res.json({ success: true, removed: item });
}));

// POST /queue/:id/complete — Mark queue item as completed (used by explore script)
router.post('/queue/:id/complete', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const item = moltworldQueue.markCompleted(id);
  if (!item) {
    throw new ServerError('Queue item not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(item);
}));

// POST /queue/:id/fail — Mark queue item as failed (used by explore script)
router.post('/queue/:id/fail', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { error } = req.body || {};
  const item = moltworldQueue.markFailed(id, error || 'Unknown error');
  if (!item) {
    throw new ServerError('Queue item not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(item);
}));

export default router;
