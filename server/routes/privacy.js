/**
 * Privacy Center Routes — encrypted PII Vault + Trusted Organizations
 * registry REST surface (issues #2140, #2141).
 *
 * Mounted at /api/privacy. Vault list/read responses carry `maskedValue`
 * only — `value_enc` and plaintext never leave the service except through
 * the ONE explicit reveal endpoint. Org holdings responses join the vault's
 * masked fields only — never plaintext.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  privacyVaultCreateSchema,
  privacyVaultUpdateSchema,
  privacyVaultListQuerySchema,
  privacyVaultIdParamsSchema,
  privacyOrgCreateSchema,
  privacyOrgUpdateSchema,
  privacyOrgListQuerySchema,
  privacyOrgIdParamsSchema,
  privacyOrgHoldingsSetSchema,
} from '../lib/privacyValidation.js';
import {
  createVaultRecord,
  listVaultRecords,
  getVaultRecord,
  updateVaultRecord,
  deleteVaultRecord,
  revealValue,
  getVaultStatus,
} from '../services/privacyVault.js';
import {
  createOrg,
  listOrgs,
  getOrg,
  updateOrg,
  deleteOrg,
  setOrgHoldings,
  getHoldingsForOrg,
} from '../services/privacyOrgs.js';

const router = Router();

router.get('/status', asyncHandler(async (_req, res) => {
  res.json(await getVaultStatus());
}));

router.get('/vault', asyncHandler(async (req, res) => {
  const { type } = validateRequest(privacyVaultListQuerySchema, req.query);
  res.json(await listVaultRecords({ type }));
}));

router.post('/vault', asyncHandler(async (req, res) => {
  const data = validateRequest(privacyVaultCreateSchema, req.body);
  res.status(201).json(await createVaultRecord(data));
}));

router.get('/vault/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(privacyVaultIdParamsSchema, req.params);
  const record = await getVaultRecord(id);
  if (!record) throw new ServerError('Vault record not found', { status: 404, code: 'NOT_FOUND' });
  res.json(record);
}));

router.put('/vault/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(privacyVaultIdParamsSchema, req.params);
  const patch = validateRequest(privacyVaultUpdateSchema, req.body);
  res.json(await updateVaultRecord(id, patch));
}));

router.delete('/vault/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(privacyVaultIdParamsSchema, req.params);
  res.json(await deleteVaultRecord(id));
}));

router.post('/vault/:id/reveal', asyncHandler(async (req, res) => {
  const { id } = validateRequest(privacyVaultIdParamsSchema, req.params);
  res.json(await revealValue(id));
}));

// ─── Trusted Organizations registry (issue #2141) ──────────────────────────

router.get('/orgs', asyncHandler(async (req, res) => {
  const filters = validateRequest(privacyOrgListQuerySchema, req.query);
  res.json(await listOrgs(filters));
}));

router.post('/orgs', asyncHandler(async (req, res) => {
  const data = validateRequest(privacyOrgCreateSchema, req.body);
  res.status(201).json(await createOrg(data));
}));

router.get('/orgs/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(privacyOrgIdParamsSchema, req.params);
  const org = await getOrg(id);
  if (!org) throw new ServerError('Organization not found', { status: 404, code: 'NOT_FOUND' });
  res.json(org);
}));

router.put('/orgs/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(privacyOrgIdParamsSchema, req.params);
  const patch = validateRequest(privacyOrgUpdateSchema, req.body);
  res.json(await updateOrg(id, patch));
}));

router.delete('/orgs/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(privacyOrgIdParamsSchema, req.params);
  res.json(await deleteOrg(id));
}));

router.get('/orgs/:id/holdings', asyncHandler(async (req, res) => {
  const { id } = validateRequest(privacyOrgIdParamsSchema, req.params);
  res.json(await getHoldingsForOrg(id));
}));

router.put('/orgs/:id/holdings', asyncHandler(async (req, res) => {
  const { id } = validateRequest(privacyOrgIdParamsSchema, req.params);
  const { holdings } = validateRequest(privacyOrgHoldingsSetSchema, req.body);
  res.json(await setOrgHoldings(id, holdings));
}));

export default router;
