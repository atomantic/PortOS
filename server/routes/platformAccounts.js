/**
 * Platform Accounts Routes
 *
 * Manage platform accounts (Moltbook, etc.) linked to agents.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validate, platformAccountSchema, accountRegistrationSchema } from '../lib/validation.js';
import * as platformAccounts from '../services/platformAccounts.js';
import * as agentPersonalities from '../services/agentPersonalities.js';
import { logAction } from '../services/history.js';
import * as moltbook from '../integrations/moltbook/index.js';
import * as moltworld from '../integrations/moltworld/index.js';

const router = Router();

// GET / - Get all platform accounts
router.get('/', asyncHandler(async (req, res) => {
  console.log('🔗 GET /api/agents/accounts');
  const { agentId, platform } = req.query;

  let accounts;
  if (agentId) {
    accounts = await platformAccounts.getAccountsByAgent(agentId);
    if (platform) {
      accounts = accounts.filter(a => a.platform === platform);
    }
  } else if (platform) {
    accounts = await platformAccounts.getAccountsByPlatform(platform);
  } else {
    accounts = await platformAccounts.getAllAccounts();
  }

  res.json(accounts);
}));

// GET /:id - Get account by ID
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  console.log(`🔗 GET /api/agents/accounts/${id}`);

  const account = await platformAccounts.getAccountById(id);
  if (!account) {
    throw new ServerError('Account not found', { status: 404, code: 'NOT_FOUND' });
  }

  res.json(account);
}));

// POST / - Create/link new platform account
router.post('/', asyncHandler(async (req, res) => {
  console.log('🔗 POST /api/agents/accounts');

  // Check if this is a registration request (for new Moltbook accounts)
  // or a direct account creation (with existing credentials)
  if (req.body.credentials) {
    // Direct account creation with credentials
    const { success, data, errors } = validate(platformAccountSchema, req.body);
    if (!success) {
      return res.status(422).json({ errors });
    }

    // Verify agent exists
    const agent = await agentPersonalities.getAgentById(data.agentId);
    if (!agent) {
      throw new ServerError('Agent not found', { status: 404, code: 'AGENT_NOT_FOUND' });
    }

    const account = await platformAccounts.createAccount(data);
    await logAction('create', 'platform-account', account.id, {
      platform: account.platform,
      agentId: account.agentId
    });

    res.status(201).json(account);
  } else {
    // Registration request - create new account on platform
    const { success, data, errors } = validate(accountRegistrationSchema, req.body);
    if (!success) {
      return res.status(422).json({ errors });
    }

    // Verify agent exists
    const agent = await agentPersonalities.getAgentById(data.agentId);
    if (!agent) {
      throw new ServerError('Agent not found', { status: 404, code: 'AGENT_NOT_FOUND' });
    }

    // Register with Moltbook
    if (data.platform === 'moltbook') {
      let apiKey, claimUrl, username;

      // Register with Moltbook API (v1 returns { agent: { api_key, claim_url, name } })
      const result = await moltbook.register(data.name, data.description);
      const agent_data = result.agent || result;
      apiKey = agent_data.api_key;
      claimUrl = agent_data.claim_url;
      username = agent_data.name || data.name.toLowerCase().replace(/\s+/g, '_');

      const account = await platformAccounts.createAccount({
        agentId: data.agentId,
        platform: data.platform,
        credentials: {
          apiKey,
          username
        },
        status: 'pending',
        platformData: {
          claimUrl,
          registrationName: data.name,
          registrationDescription: data.description
        }
      });

      await logAction('register', 'platform-account', account.id, {
        platform: account.platform,
        agentId: account.agentId
      });

      res.status(201).json({
        ...account,
        claimUrl
      });
    } else if (data.platform === 'moltworld') {
      // Register with Moltworld API — returns agent ID and API key
      const result = await moltworld.register(data.name, {});
      const apiKey = result.apiKey || result.api_key;
      const moltworldAgentId = result.agentId || result.agent_id || result.id || apiKey;
      const username = data.name;
      console.log(`🌍 Moltworld registration result keys: ${Object.keys(result).join(', ')}`);

      const account = await platformAccounts.createAccount({
        agentId: data.agentId,
        platform: data.platform,
        credentials: {
          apiKey,
          username,
          agentId: moltworldAgentId   // Moltworld uses agentId for auth
        },
        status: 'active',  // No claim step for Moltworld
        platformData: {
          registrationName: data.name,
          registrationDescription: data.description
        }
      });

      await logAction('register', 'platform-account', account.id, {
        platform: account.platform,
        agentId: account.agentId
      });

      res.status(201).json(account);
    } else {
      throw new ServerError('Unsupported platform', { status: 400, code: 'UNSUPPORTED_PLATFORM' });
    }
  }
}));

// DELETE /:id - Remove account
router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  console.log(`🔗 DELETE /api/agents/accounts/${id}`);

  const deleted = await platformAccounts.deleteAccount(id);
  if (!deleted) {
    throw new ServerError('Account not found', { status: 404, code: 'NOT_FOUND' });
  }

  await logAction('delete', 'platform-account', id, {});
  res.json({ success: true });
}));

// POST /:id/test - Test account connection
router.post('/:id/test', asyncHandler(async (req, res) => {
  const { id } = req.params;
  console.log(`🔗 POST /api/agents/accounts/${id}/test`);

  const account = await platformAccounts.getAccountWithCredentials(id);
  if (!account) {
    throw new ServerError('Account not found', { status: 404, code: 'NOT_FOUND' });
  }

  if (account.platform === 'moltbook') {
    // Test with real Moltbook API - fetch profile (read-only, no side effects)
    const client = new moltbook.MoltbookClient(account.credentials.apiKey);
    const profileResult = await client.getProfile();
    const agent = profileResult.agent || profileResult;
    const platformStatus = agent.is_claimed ? 'active' : 'pending_claim';

    const testResult = {
      success: !!agent.id,
      message: agent.id
        ? `Connection successful — ${agent.name} (${agent.stats?.posts || 0} posts, ${agent.karma || 0} karma)`
        : 'Could not retrieve profile',
      platform: account.platform,
      username: account.credentials.username,
      platformStatus
    };

    // Update account status if it changed
    if (agent.id && agent.is_claimed) {
      await platformAccounts.updateAccountStatus(id, 'active');
    } else if (!agent.is_claimed) {
      await platformAccounts.updateAccountStatus(id, 'pending');
    }

    res.json(testResult);
  } else if (account.platform === 'moltworld') {
    // Test with Moltworld API — fetch profile + balance
    const client = new moltworld.MoltworldClient(
      account.credentials.apiKey,
      account.credentials.agentId
    );
    const profileResult = await client.getProfile();
    const agent = profileResult?.agent || profileResult;
    const balanceResult = await client.getBalance().catch(() => null);
    const balance = balanceResult?.balance;

    const testResult = {
      success: !!agent?.id || !!agent?.name,
      message: agent?.id || agent?.name
        ? `Connection successful — ${agent.name}${balance ? ` (${balance.sim || 0} SIM)` : ''}`
        : 'Could not retrieve profile',
      platform: account.platform,
      username: account.credentials.username,
      platformStatus: 'active'
    };

    res.json(testResult);
  } else {
    throw new ServerError('Unsupported platform', { status: 400, code: 'UNSUPPORTED_PLATFORM' });
  }
}));

// POST /:id/claim - Mark account as claimed (after user visits claim URL)
router.post('/:id/claim', asyncHandler(async (req, res) => {
  const { id } = req.params;
  console.log(`🔗 POST /api/agents/accounts/${id}/claim`);

  const account = await platformAccounts.getAccountById(id);
  if (!account) {
    throw new ServerError('Account not found', { status: 404, code: 'NOT_FOUND' });
  }

  if (account.status !== 'pending') {
    throw new ServerError('Account already claimed or in error state', {
      status: 400,
      code: 'INVALID_STATE'
    });
  }

  // Update status to active
  const updated = await platformAccounts.updateAccountStatus(id, 'active');
  await logAction('claim', 'platform-account', id, { platform: updated.platform });

  res.json(updated);
}));

export default router;
