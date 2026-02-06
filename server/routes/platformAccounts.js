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

const router = Router();

// GET / - Get all platform accounts
router.get('/', asyncHandler(async (req, res) => {
  console.log('🔗 GET /api/agents/accounts');
  const { agentId, platform } = req.query;

  let accounts;
  if (agentId) {
    accounts = await platformAccounts.getAccountsByAgent(agentId);
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

      // Try to register with real Moltbook API
      const result = await moltbook.register(data.name, data.description);
      apiKey = result.api_key;
      claimUrl = result.claim_url;
      username = result.username || data.name.toLowerCase().replace(/\s+/g, '_');

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
    // Test with real Moltbook API
    const client = new moltbook.MoltbookClient(account.credentials.apiKey);
    const status = await client.getStatus();

    const testResult = {
      success: status.status === 'active' || status.status === 'claimed',
      message: status.status === 'active' || status.status === 'claimed'
        ? 'Connection successful'
        : status.status === 'pending_claim'
          ? 'Account pending claim - visit claim URL to activate'
          : `Account status: ${status.status}`,
      platform: account.platform,
      username: account.credentials.username,
      platformStatus: status.status
    };

    // Update account status if it changed
    if (status.status === 'active' || status.status === 'claimed') {
      await platformAccounts.updateAccountStatus(id, 'active');
    } else if (status.status === 'suspended') {
      await platformAccounts.updateAccountStatus(id, 'suspended');
    }

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
