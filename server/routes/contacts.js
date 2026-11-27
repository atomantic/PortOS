import { enrichBodySchema, suggestQuerySchema, importBodySchema } from '../lib/contactsValidation.js';
import { Router } from 'express';

import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import * as contactsSync from '../services/contactsSync.js';
import * as tribeContacts from '../services/tribeContacts.js';

const router = Router();

// Setup check — discover AddressBook DBs and report Full Disk Access issues.
router.get('/setup-check', asyncHandler(async (req, res) => {
  const report = await contactsSync.checkSetup();
  res.json(report);
}));

// Status — cache counts + last sync; never opens AddressBook (setup-check does).
router.get('/status', asyncHandler(async (req, res) => {
  const status = await contactsSync.getStatus();
  res.json(status);
}));

// Run a full Contacts → cache sync now.
router.post('/sync', asyncHandler(async (req, res) => {
  const result = await contactsSync.runSync();
  res.json(result);
}));

// Clear cached Contacts PII and reset sync state idempotently.
router.delete('/cache', asyncHandler(async (req, res) => {
  const result = await contactsSync.clearContactCache();
  res.json(result);
}));

// Fill missing Tribe phones/emails from Contacts matches.
router.post('/enrich-tribe', asyncHandler(async (req, res) => {
  const body = validateRequest(enrichBodySchema, req.body || {});
  const result = await tribeContacts.enrichTribeFromContacts(body);
  res.json(result);
}));

router.get('/suggest-tribe', asyncHandler(async (req, res) => {
  const q = validateRequest(suggestQuerySchema, req.query);
  const result = await tribeContacts.suggestTribeImports(q);
  res.json(result);
}));

router.post('/import-to-tribe', asyncHandler(async (req, res) => {
  const body = validateRequest(importBodySchema, req.body || {});
  const result = await tribeContacts.importContactToTribe(body);
  res.status(result.created ? 201 : 200).json(result);
}));

export default router;
