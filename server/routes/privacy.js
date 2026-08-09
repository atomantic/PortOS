/**
 * Privacy Center Routes — encrypted PII Vault + Trusted Organizations
 * registry REST surface (issues #2140, #2141).
 *
 * Every record-bearing endpoint is scoped to ONE household subject via an
 * optional `?subjectId=` (list/read) or body `subjectId` (create). Omitting it
 * means the seeded `self` subject, so every pre-#3658 client keeps working.
 *
 * Mounted at /api/privacy. Vault list/read responses carry `maskedValue`
 * only — `value_enc` and plaintext never leave the service except through
 * the ONE explicit reveal endpoint. Org holdings responses join the vault's
 * masked fields only — never plaintext.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, isPaginationRequested, paginateArray } from '../lib/validation.js';
import {
  privacySubjectCreateSchema,
  privacySubjectUpdateSchema,
  privacySubjectIdParamsSchema,
  privacySubjectConsentSchema,
  privacyChangeListQuerySchema,
  privacySubjectScopeQuerySchema,
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
  privacyBrokerIdParamsSchema,
  privacyBrokerUpdateSchema,
  privacyCaseIdParamsSchema,
  privacyCaseTransitionSchema,
  privacyScanStartSchema,
  privacyChangeDeclareSchema,
  privacyChangeIdParamsSchema,
  privacyChangeOrgParamsSchema,
  privacyOptOutPassSchema,
  privacyOptOutVerifySchema,
  privacyRecheckConfigSchema,
} from '../lib/privacyValidation.js';
import {
  listSubjects,
  getSubject,
  createSubject,
  updateSubject,
  deleteSubject,
  listSubjectConsents,
  recordConsent,
  assertSubject,
} from '../services/privacySubjects.js';
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
  setBrokerEnabled,
  forceRecheckCase,
  transitionCase,
} from '../services/privacyBrokers.js';
import { runScanPass } from '../services/privacyScan.js';
import { runOptOutPass, runVerificationPass, getOptOutDigest } from '../services/privacyOptOut.js';
import {
  getPrivacyRecheckStatus,
  restartPrivacyRecheckScheduler,
} from '../services/privacyRecheckScheduler.js';
import { getSettings, updateSettingsWith } from '../services/settings.js';
import {
  declareChange,
  listChangeEvents,
  getChange,
  markOrgUpdated,
  markOrgRemoved,
  draftUpdateEmail,
} from '../services/privacyChanges.js';

const router = Router();

// ─── Household subjects (issue #3658) ──────────────────────────────────────
// The people the Privacy Center works on behalf of. `self` is seeded and
// undeletable; every other subject requires a recorded consent method at
// creation, and the scan/opt-out engines refuse to act without one.

router.get('/subjects', asyncHandler(async (_req, res) => {
  res.json(await listSubjects());
}));

router.post('/subjects', asyncHandler(async (req, res) => {
  const data = validateRequest(privacySubjectCreateSchema, req.body);
  res.status(201).json(await createSubject(data));
}));

router.get('/subjects/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(privacySubjectIdParamsSchema, req.params);
  const subject = await getSubject(id);
  if (!subject) throw new ServerError('Privacy subject not found', { status: 404, code: 'SUBJECT_NOT_FOUND' });
  res.json(subject);
}));

router.put('/subjects/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(privacySubjectIdParamsSchema, req.params);
  const patch = validateRequest(privacySubjectUpdateSchema, req.body);
  res.json(await updateSubject(id, patch));
}));

// Hard DELETE — cascades the subject's vault records, orgs, holdings, change
// events, broker cases, and consent rows (machine-local, no tombstones).
router.delete('/subjects/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(privacySubjectIdParamsSchema, req.params);
  res.json(await deleteSubject(id));
}));

router.get('/subjects/:id/consents', asyncHandler(async (req, res) => {
  const { id } = validateRequest(privacySubjectIdParamsSchema, req.params);
  await assertSubject(id);
  res.json(await listSubjectConsents(id));
}));

// Append a further consent row (e.g. the subject later agreed to broker
// opt-outs). Append-only — there is no revoke endpoint: revoking consent means
// deleting the subject, which hard-deletes their records.
router.post('/subjects/:id/consents', asyncHandler(async (req, res) => {
  const { id } = validateRequest(privacySubjectIdParamsSchema, req.params);
  const { scope, method, note } = validateRequest(privacySubjectConsentSchema, req.body);
  res.status(201).json(await recordConsent({ subjectId: id, scope, method, note }));
}));

router.get('/status', asyncHandler(async (req, res) => {
  const { subjectId } = validateRequest(privacySubjectScopeQuerySchema, req.query);
  res.json(await getVaultStatus({ subjectId }));
}));

router.get('/vault', asyncHandler(async (req, res) => {
  const { type, subjectId } = validateRequest(privacyVaultListQuerySchema, req.query);
  const records = await listVaultRecords({ type, subjectId });
  if (!isPaginationRequested(req.query)) return res.json(records);
  res.json(paginateArray(records, req.query, { defaultLimit: 50, maxLimit: 500 }));
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
  const { limit, offset, ...filters } = validateRequest(privacyOrgListQuerySchema, req.query);
  const orgs = await listOrgs(filters);
  if (!isPaginationRequested(req.query)) return res.json(orgs);
  res.json(paginateArray(orgs, req.query, { defaultLimit: 50, maxLimit: 500 }));
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

// ─── Change-of-address events + inventory workflow (issue #2143) ────────────

router.get('/changes', asyncHandler(async (req, res) => {
  const { subjectId } = validateRequest(privacyChangeListQuerySchema, req.query);
  const events = await listChangeEvents({ subjectId });
  if (!isPaginationRequested(req.query)) return res.json(events);
  res.json(paginateArray(events, req.query, { defaultLimit: 50, maxLimit: 500 }));
}));

router.post('/changes', asyncHandler(async (req, res) => {
  const data = validateRequest(privacyChangeDeclareSchema, req.body);
  res.status(201).json(await declareChange(data));
}));

router.get('/changes/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(privacyChangeIdParamsSchema, req.params);
  res.json(await getChange(id));
}));

router.post('/changes/:id/orgs/:orgId/updated', asyncHandler(async (req, res) => {
  const { id, orgId } = validateRequest(privacyChangeOrgParamsSchema, req.params);
  res.json(await markOrgUpdated(id, orgId));
}));

router.post('/changes/:id/orgs/:orgId/removed', asyncHandler(async (req, res) => {
  const { id, orgId } = validateRequest(privacyChangeOrgParamsSchema, req.params);
  res.json(await markOrgRemoved(id, orgId));
}));

router.post('/changes/:id/orgs/:orgId/draft-email', asyncHandler(async (req, res) => {
  const { id, orgId } = validateRequest(privacyChangeOrgParamsSchema, req.params);
  res.status(201).json(await draftUpdateEmail(id, orgId));
}));

// ─── Data-broker database + exposure scan + case ledger (issue #2144) ───────

router.get('/brokers', asyncHandler(async (req, res) => {
  const { enabled } = validateRequest(privacyBrokerListQuerySchema, req.query);
  const brokers = await listBrokers({ enabled });
  if (!isPaginationRequested(req.query)) return res.json(brokers);
  res.json(paginateArray(brokers, req.query, { defaultLimit: 50, maxLimit: 500 }));
}));

// User-triggered refresh (never at boot) — pulls BADBOOL + CA registry, never
// clobbers curated rows.
router.post('/brokers/refresh', asyncHandler(async (req, res) => {
  validateRequest(privacyBrokerRefreshSchema, req.body ?? {});
  res.json(await refreshBrokers());
}));

// Per-broker enable/disable toggle (Brokers-tab, #2146). A disabled broker is
// skipped by the scan + opt-out passes.
router.put('/brokers/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(privacyBrokerIdParamsSchema, req.params);
  const { enabled } = validateRequest(privacyBrokerUpdateSchema, req.body);
  res.json(await setBrokerEnabled(id, enabled));
}));

router.get('/broker-cases', asyncHandler(async (req, res) => {
  const { state, subjectId } = validateRequest(privacyBrokerCaseListQuerySchema, req.query);
  const cases = await listBrokerCases({ state, subjectId });
  if (!isPaginationRequested(req.query)) return res.json(cases);
  res.json(paginateArray(cases, req.query, { defaultLimit: 50, maxLimit: 500 }));
}));

// Force a case due for recheck NOW (case drawer "Re-check" control, #2146).
router.post('/broker-cases/:id/recheck', asyncHandler(async (req, res) => {
  const { id } = validateRequest(privacyCaseIdParamsSchema, req.params);
  res.json(await forceRecheckCase(id));
}));

// Manual case transition (digest done/dismiss, case-drawer controls, #2146).
// Only human-reachable targets are accepted (schema); the service's state
// machine enforces validity of the specific from→to move on top of that.
router.post('/broker-cases/:id/transition', asyncHandler(async (req, res) => {
  const { id } = validateRequest(privacyCaseIdParamsSchema, req.params);
  const { toState, reason } = validateRequest(privacyCaseTransitionSchema, req.body);
  res.json(await transitionCase(id, toState, reason === undefined ? {} : { reason }));
}));

router.get('/scan/status', asyncHandler(async (req, res) => {
  const { subjectId } = validateRequest(privacySubjectScopeQuerySchema, req.query);
  res.json(await getScanStatus({ subjectId }));
}));

// User-triggered read-only exposure scan pass over enabled brokers.
router.post('/scan', asyncHandler(async (req, res) => {
  const { concurrency, subjectId } = validateRequest(privacyScanStartSchema, req.body ?? {});
  res.json(await runScanPass({ ...(concurrency ? { concurrency } : {}), subjectId }));
}));

// ─── Opt-out automation engine (issue #2145) ───────────────────────────────

// User-triggered opt-out pass: submit found/indirect cases via the chosen lane
// (web-form / email), poll verifications. Submission autonomy (auto-send /
// auto-submit) is read from settings.privacy.recheck — both default OFF.
router.post('/optout', asyncHandler(async (req, res) => {
  const { runVerification, subjectId } = validateRequest(privacyOptOutPassSchema, req.body ?? {});
  res.json(await runOptOutPass({
    ...(runVerification === undefined ? {} : { runVerification }),
    subjectId,
  }));
}));

// User-triggered verification-only pass (inbox confirmation scan + removal re-scan).
router.post('/optout/verify', asyncHandler(async (req, res) => {
  const { subjectId } = validateRequest(privacyOptOutVerifySchema, req.body ?? {});
  res.json(await runVerificationPass({ subjectId }));
}));

// Human-task digest: cases that need a person (blocked walls, auto-submit-off
// forms, fax/phone/gov-ID channels) with the prepared request + playbook.
router.get('/optout/digest', asyncHandler(async (req, res) => {
  const { subjectId } = validateRequest(privacySubjectScopeQuerySchema, req.query);
  res.json(await getOptOutDigest({ subjectId }));
}));

// Recheck-schedule status: enabled, cron, autonomy toggles, next fire time.
router.get('/optout/schedule', asyncHandler(async (_req, res) => {
  res.json(await getPrivacyRecheckStatus());
}));

// Enable/disable the recheck cron + autonomy toggles (Brokers-tab run controls,
// #2146). Deep-merges the `privacy.recheck` settings slice, then restarts the
// scheduler so the change takes effect immediately (the cron expression is
// locked in at registration). Enabling creates the cron; disabling removes it.
router.put('/optout/schedule', asyncHandler(async (req, res) => {
  const patch = validateRequest(privacyRecheckConfigSchema, req.body ?? {});
  await updateSettingsWith((current) => ({
    ...current,
    privacy: {
      ...(current.privacy || {}),
      recheck: { ...(current.privacy?.recheck || {}), ...patch },
    },
  }));
  await restartPrivacyRecheckScheduler();
  res.json(await getPrivacyRecheckStatus());
}));

export default router;
