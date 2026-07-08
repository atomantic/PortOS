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
  privacyBrokerListQuerySchema,
  privacyBrokerCaseListQuerySchema,
  privacyBrokerRefreshSchema,
  privacyScanStartSchema,
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
  getOrgsBySocialAccounts,
} from '../services/privacyOrgs.js';
import {
  listBrokers,
  refreshBrokers,
  listBrokerCases,
  getScanStatus,
} from '../services/privacyBrokers.js';
import { runScanPass } from '../services/privacyScan.js';

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

// Digital Twin ↔ org cross-link (issue #2147): which social accounts are in
// the org registry. Declared before `/orgs/:id` so the literal path wins.
router.get('/social-account-links', asyncHandler(async (_req, res) => {
  res.json(await getOrgsBySocialAccounts());
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
  const org = await getOrg(id);
  if (!org) throw new ServerError('Organization not found', { status: 404, code: 'NOT_FOUND' });
  res.json(await getHoldingsForOrg(id));
}));

router.put('/orgs/:id/holdings', asyncHandler(async (req, res) => {
  const { id } = validateRequest(privacyOrgIdParamsSchema, req.params);
  const { holdings } = validateRequest(privacyOrgHoldingsSetSchema, req.body);
  res.json(await setOrgHoldings(id, holdings));
}));

// ─── Data-broker database + exposure scan + case ledger (issue #2144) ───────

router.get('/brokers', asyncHandler(async (req, res) => {
  const { enabled } = validateRequest(privacyBrokerListQuerySchema, req.query);
  res.json(await listBrokers({ enabled }));
}));

// User-triggered refresh (never at boot) — pulls BADBOOL + CA registry, never
// clobbers curated rows.
router.post('/brokers/refresh', asyncHandler(async (req, res) => {
  validateRequest(privacyBrokerRefreshSchema, req.body ?? {});
  res.json(await refreshBrokers());
}));

router.get('/broker-cases', asyncHandler(async (req, res) => {
  const { state } = validateRequest(privacyBrokerCaseListQuerySchema, req.query);
  res.json(await listBrokerCases({ state }));
}));

router.get('/scan/status', asyncHandler(async (_req, res) => {
  res.json(await getScanStatus());
}));

// User-triggered read-only exposure scan pass over enabled brokers.
router.post('/scan', asyncHandler(async (req, res) => {
  const { concurrency } = validateRequest(privacyScanStartSchema, req.body ?? {});
  res.json(await runScanPass(concurrency ? { concurrency } : {}));
}));

export default router;
