/**
 * Social Accounts Routes (Digital Twin)
 *
 * Manage the user's own social media accounts for the digital twin.
 * Mounted at /api/digital-twin/social-accounts
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validate, socialAccountSchema, socialAccountUpdateSchema } from '../lib/validation.js';
import * as socialAccounts from '../services/socialAccounts.js';

const router = Router();

// GET / - List all social accounts
router.get('/', asyncHandler(async (req, res) => {
  const { platform, category } = req.query;

  let accounts;
  if (platform) {
    accounts = await socialAccounts.getAccountsByPlatform(platform);
  } else if (category) {
    accounts = await socialAccounts.getAccountsByCategory(category);
  } else {
    accounts = await socialAccounts.getAllAccounts();
  }

  res.json({ accounts });
}));

// GET /platforms - List supported platforms
router.get('/platforms', asyncHandler(async (req, res) => {
  const platforms = socialAccounts.getSupportedPlatforms();
  res.json({ platforms });
}));

// GET /stats - Account summary stats
router.get('/stats', asyncHandler(async (req, res) => {
  const stats = await socialAccounts.getAccountStats();
  res.json(stats);
}));

// GET /:id - Get account by ID
router.get('/:id', asyncHandler(async (req, res) => {
  const account = await socialAccounts.getAccountById(req.params.id);
  if (!account) {
    throw new ServerError('Social account not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(account);
}));

// POST / - Create a social account
router.post('/', asyncHandler(async (req, res) => {
  const validation = validate(socialAccountSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const account = await socialAccounts.createAccount(validation.data);
  res.status(201).json(account);
}));

// POST /bulk - Create multiple social accounts at once
router.post('/bulk', asyncHandler(async (req, res) => {
  const { accounts: accountsData } = req.body;
  if (!Array.isArray(accountsData) || accountsData.length === 0) {
    throw new ServerError('accounts array is required', {
      status: 400,
      code: 'VALIDATION_ERROR'
    });
  }

  const results = [];
  for (const accountData of accountsData) {
    const validation = validate(socialAccountSchema, accountData);
    if (!validation.success) {
      results.push({ success: false, errors: validation.errors, input: accountData });
      continue;
    }
    const account = await socialAccounts.createAccount(validation.data);
    results.push({ success: true, account });
  }

  const created = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  console.log(`🔗 Bulk social accounts: ${created} created, ${failed} failed`);

  res.status(201).json({ results, summary: { created, failed } });
}));

// PUT /:id - Update a social account
router.put('/:id', asyncHandler(async (req, res) => {
  const validation = validate(socialAccountUpdateSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const account = await socialAccounts.updateAccount(req.params.id, validation.data);
  if (!account) {
    throw new ServerError('Social account not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(account);
}));

// DELETE /:id - Delete a social account
router.delete('/:id', asyncHandler(async (req, res) => {
  const deleted = await socialAccounts.deleteAccount(req.params.id);
  if (!deleted) {
    throw new ServerError('Social account not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.status(204).send();
}));

export default router;
