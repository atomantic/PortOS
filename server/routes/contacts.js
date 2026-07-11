import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as contactsSync from '../services/contactsSync.js';
import * as identityResolve from '../services/identityResolve.js';
import * as tribeContacts from '../services/tribeContacts.js';

const router = Router();

// Setup check — discover AddressBook DBs and report Full Disk Access issues.
router.get('/setup-check', asyncHandler(async (req, res) => {
  const report = await contactsSync.checkSetup();
  res.json(report);
}));

// Status — cache counts + last sync (no AddressBook open unless setup block).
router.get('/status', asyncHandler(async (req, res) => {
  const status = await contactsSync.getStatus();
  res.json(status);
}));

// Run a full Contacts → cache sync now.
router.post('/sync', asyncHandler(async (req, res) => {
  const result = await contactsSync.runSync();
  res.json(result);
}));

const searchQuerySchema = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

router.get('/search', asyncHandler(async (req, res) => {
  const q = validateRequest(searchQuerySchema, req.query);
  const contacts = await contactsSync.searchContacts(q);
  res.json({ contacts });
}));

const resolveQuerySchema = z.object({
  handle: z.string().min(1).max(200),
});

router.get('/resolve', asyncHandler(async (req, res) => {
  const { handle } = validateRequest(resolveQuerySchema, req.query);
  const ctx = await identityResolve.loadResolverContext();
  const resolution = identityResolve.resolveHandle(handle, ctx);
  res.json(resolution);
}));

const enrichBodySchema = z.object({
  dryRun: z.boolean().optional().default(false),
});

// Fill missing Tribe phones/emails from Contacts matches.
router.post('/enrich-tribe', asyncHandler(async (req, res) => {
  const body = validateRequest(enrichBodySchema, req.body || {});
  const result = await tribeContacts.enrichTribeFromContacts(body);
  res.json(result);
}));

const suggestQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

router.get('/suggest-tribe', asyncHandler(async (req, res) => {
  const q = validateRequest(suggestQuerySchema, req.query);
  const result = await tribeContacts.suggestTribeImports(q);
  res.json(result);
}));

const importBodySchema = z.object({
  contactId: z.string().min(1).max(300).optional(),
  name: z.string().min(1).max(200).optional(),
  phones: z.array(z.string().max(40)).max(20).optional(),
  emails: z.array(z.string().email().max(200)).max(20).optional(),
  organization: z.string().max(200).optional(),
  ring: z.enum(['support', 'core', 'tribe', 'village', 'external']).optional(),
  relationship: z.string().max(200).optional(),
}).refine((b) => b.contactId || b.name || (b.phones?.length) || (b.emails?.length), {
  message: 'contactId or name/phones/emails required',
});

router.post('/import-to-tribe', asyncHandler(async (req, res) => {
  const body = validateRequest(importBodySchema, req.body || {});
  try {
    const result = await tribeContacts.importContactToTribe(body);
    res.status(result.created ? 201 : 200).json(result);
  } catch (err) {
    if (err?.status === 400) {
      throw new ServerError(err.message, { status: 400, code: err.code || 'BAD_REQUEST' });
    }
    throw err;
  }
}));

export default router;
