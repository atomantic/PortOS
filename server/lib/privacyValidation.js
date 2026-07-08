import { z } from 'zod';

// =============================================================================
// PRIVACY CENTER SCHEMAS (issue #2140, epic #2138)
// =============================================================================
// Zod schemas for the encrypted PII Vault. Records are db-primary Postgres
// (`privacy_vault_records` / `privacy_consents`), machine-local (federation is
// a deferred child issue). validation.js re-exports everything here so deep
// imports keep working; the lib barrel also namespace-exports this module as
// `privacyValidation`.

export const PRIVACY_VAULT_TYPES = Object.freeze([
  'legal_name', 'address', 'phone', 'email', 'dob',
  'ssn', 'passport', 'drivers_license', 'financial_account', 'custom',
]);

// Types that may NEVER be used for broker scans — `use_for_scans: true` is
// rejected at the API AND hard-forced false in the service (defense in depth).
// Disclosing these to a data broker's search form is never least-disclosure.
export const PRIVACY_SENSITIVE_TYPES = Object.freeze([
  'ssn', 'passport', 'drivers_license', 'financial_account',
]);

// Types whose `use_for_scans` DEFAULTS to true (broker scans need name /
// contact facts to find listings). Everything else defaults false.
export const PRIVACY_SCAN_DEFAULT_TYPES = Object.freeze([
  'legal_name', 'email', 'phone', 'address',
]);

export const PRIVACY_VAULT_STATUSES = Object.freeze(['current', 'previous']);

// ISO calendar date (DATE column) — nullable to clear.
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').nullable().optional();

const rejectSensitiveScans = (val, ctx) => {
  if (val.useForScans === true && PRIVACY_SENSITIVE_TYPES.includes(val.type)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['useForScans'],
      message: `useForScans cannot be true for sensitive type "${val.type}"`,
    });
  }
};

export const privacyVaultCreateSchema = z.object({
  type: z.enum(PRIVACY_VAULT_TYPES),
  label: z.string().trim().min(1).max(200),
  value: z.string().min(1).max(10000),
  status: z.enum(PRIVACY_VAULT_STATUSES).optional(),
  validFrom: isoDateSchema,
  validTo: isoDateSchema,
  shareWithTwin: z.boolean().optional(),
  useForScans: z.boolean().optional(),
  notes: z.string().max(5000).optional(),
}).strict().superRefine(rejectSensitiveScans);

// PUT is a partial update. `type` is immutable (it drives masking + scan
// defaults; changing a record's type is a delete + re-create). The sensitive
// use_for_scans hard-false is re-enforced in the service against the STORED
// type, since the schema can't see it here.
export const privacyVaultUpdateSchema = z.object({
  label: z.string().trim().min(1).max(200).optional(),
  value: z.string().min(1).max(10000).optional(),
  status: z.enum(PRIVACY_VAULT_STATUSES).optional(),
  validFrom: isoDateSchema,
  validTo: isoDateSchema,
  shareWithTwin: z.boolean().optional(),
  useForScans: z.boolean().optional(),
  notes: z.string().max(5000).optional(),
}).strict();

export const privacyVaultListQuerySchema = z.object({
  type: z.enum(PRIVACY_VAULT_TYPES).optional(),
}).strict();

export const privacyVaultIdParamsSchema = z.object({
  id: z.string().uuid(),
}).strict();

// =============================================================================
// TRUSTED ORGANIZATIONS REGISTRY SCHEMAS (issue #2141, epic #2138)
// =============================================================================
// Zod schemas for `privacy_orgs` / `privacy_org_holdings` — db-primary Postgres,
// machine-local (same federation-deferred scope as the vault, #2148).

export const PRIVACY_ORG_CATEGORIES = Object.freeze([
  'bank', 'utility', 'government', 'employer', 'subscription',
  'medical', 'insurance', 'platform', 'broker', 'other',
]);

export const PRIVACY_ORG_TRUST_LEVELS = Object.freeze(['trusted', 'tolerated', 'unwanted']);

export const PRIVACY_ORG_STATUSES = Object.freeze(['active', 'closed', 'opted_out']);

export const PRIVACY_ORG_HOLDING_STATUSES = Object.freeze([
  'current', 'update_pending', 'updated', 'removed', 'unknown',
]);

const privacyOrgContactSchema = z.object({
  email: z.string().max(320).optional(),
  phone: z.string().max(64).optional(),
  portalUrl: z.string().max(2000).optional(),
  mailingAddress: z.string().max(2000).optional(),
}).strict();

export const privacyOrgCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.enum(PRIVACY_ORG_CATEGORIES).optional(),
  website: z.string().max(2000).optional(),
  trust: z.enum(PRIVACY_ORG_TRUST_LEVELS).optional(),
  status: z.enum(PRIVACY_ORG_STATUSES).optional(),
  contact: privacyOrgContactSchema.optional(),
  socialAccountId: z.string().max(200).nullable().optional(),
  notes: z.string().max(5000).optional(),
}).strict();

// PUT is a partial update — every field optional, same shape otherwise.
export const privacyOrgUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  category: z.enum(PRIVACY_ORG_CATEGORIES).optional(),
  website: z.string().max(2000).optional(),
  trust: z.enum(PRIVACY_ORG_TRUST_LEVELS).optional(),
  status: z.enum(PRIVACY_ORG_STATUSES).optional(),
  contact: privacyOrgContactSchema.optional(),
  socialAccountId: z.string().max(200).nullable().optional(),
  notes: z.string().max(5000).optional(),
}).strict();

export const privacyOrgListQuerySchema = z.object({
  trust: z.enum(PRIVACY_ORG_TRUST_LEVELS).optional(),
  status: z.enum(PRIVACY_ORG_STATUSES).optional(),
  category: z.enum(PRIVACY_ORG_CATEGORIES).optional(),
}).strict();

export const privacyOrgIdParamsSchema = z.object({
  id: z.string().uuid(),
}).strict();

// PUT /api/privacy/orgs/:id/holdings — replace-set semantics: body is the
// full list of vault record ids (+ optional status) this org holds. An empty
// array clears all holdings for the org.
export const privacyOrgHoldingsSetSchema = z.object({
  holdings: z.array(z.object({
    vaultRecordId: z.string().uuid(),
    status: z.enum(PRIVACY_ORG_HOLDING_STATUSES).optional(),
  }).strict()).max(500),
}).strict();

// =============================================================================
// CHANGE-OF-ADDRESS EVENTS + INVENTORY SCHEMAS (issue #2143, epic #2138)
// =============================================================================
// Zod schemas for `privacy_change_events` — db-primary Postgres, machine-local
// (same federation-deferred scope as the vault, #2148). Declaring a change flips
// every `current` holding of the old vault record to `update_pending`; the
// Changes tab then works that per-org checklist.

export const PRIVACY_CHANGE_KINDS = Object.freeze([
  'address_change', 'phone_change', 'email_change', 'name_change', 'other',
]);

// The replacement value can be supplied inline (a brand-new vault record is
// created for it) — the same shape as a vault create MINUS status (always
// 'current') and validTo (an active replacement has no end date yet). `type`
// defaults to the OLD record's type in the service when omitted.
const privacyChangeReplacementSchema = z.object({
  type: z.enum(PRIVACY_VAULT_TYPES).optional(),
  label: z.string().trim().min(1).max(200),
  value: z.string().min(1).max(10000),
  validFrom: isoDateSchema,
  shareWithTwin: z.boolean().optional(),
  useForScans: z.boolean().optional(),
  notes: z.string().max(5000).optional(),
}).strict();

// POST /api/privacy/changes — declare a change. Supply the replacement EITHER
// inline (`replacement`) OR by id (`replacementRecordId`), never both; omit both
// for a removal-only change (the field went away with no successor). `kind`
// defaults in the service from the old record's type when omitted.
export const privacyChangeDeclareSchema = z.object({
  vaultRecordId: z.string().uuid(),
  replacement: privacyChangeReplacementSchema.optional(),
  replacementRecordId: z.string().uuid().optional(),
  kind: z.enum(PRIVACY_CHANGE_KINDS).optional(),
  note: z.string().max(5000).optional(),
}).strict().refine(
  (v) => !(v.replacement && v.replacementRecordId),
  { message: 'provide either replacement or replacementRecordId, not both', path: ['replacement'] },
);

export const privacyChangeIdParamsSchema = z.object({
  id: z.string().uuid(),
}).strict();

export const privacyChangeOrgParamsSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
}).strict();

// =============================================================================
// DATA-BROKER DATABASE + CASE LEDGER SCHEMAS (issue #2144, epic #2138)
// =============================================================================
// Zod schemas for `privacy_brokers` / `privacy_broker_cases` — db-primary
// Postgres, machine-local (same federation-deferred scope as the vault, #2148).
// The broker rows themselves are curated seed / auto-refresh, not user-created,
// so there is no broker create/update input schema — only read filters and the
// scan/refresh action bodies.

export const PRIVACY_BROKER_CASE_STATES = Object.freeze([
  'unscanned',
  'found', 'not_found', 'indirect_exposure', 'blocked',
  'optout_in_progress', 'submitted', 'verification_pending', 'awaiting_processing',
  'confirmed_removed', 'human_task_queued', 'reappeared',
]);

// GET /api/privacy/brokers?enabled=true — z.coerce so the string query "true"/
// "false" becomes a boolean (matches the storage of the enabled column).
export const privacyBrokerListQuerySchema = z.object({
  enabled: z.preprocess(
    (v) => (v === undefined ? undefined : v === 'true' || v === true),
    z.boolean().optional(),
  ),
}).strict();

// GET /api/privacy/broker-cases?state=found
export const privacyBrokerCaseListQuerySchema = z.object({
  state: z.enum(PRIVACY_BROKER_CASE_STATES).optional(),
}).strict();

// POST /api/privacy/brokers/refresh — no body; empty object.
export const privacyBrokerRefreshSchema = z.object({}).strict();

// POST /api/privacy/scan — optional concurrency knob.
export const privacyScanStartSchema = z.object({
  concurrency: z.number().int().min(1).max(6).optional(),
}).strict();

// =============================================================================
// OPT-OUT AUTOMATION ENGINE SCHEMAS (issue #2145, epic #2138)
// =============================================================================
// Zod schemas for the opt-out run/verify actions + the user-configured recheck
// settings slice (`settings.privacy.recheck`). The engine reads its submission
// autonomy (auto-approve emails / auto-submit web forms) from that slice —
// BOTH default OFF (a fresh install never auto-sends or auto-submits anything).

// POST /api/privacy/optout — run one opt-out pass. `runVerification` (default
// true) folds the verification poll into the same pass.
export const privacyOptOutPassSchema = z.object({
  runVerification: z.boolean().optional(),
}).strict();

// POST /api/privacy/optout/verify — run only the verification pass. No body.
export const privacyOptOutVerifySchema = z.object({}).strict();

// A basic 5-field cron expression validator (minute hour dom month dow). Kept
// permissive (tokens can be `*`, numbers, ranges, lists, steps) — the scheduler
// library does the strict parse; this just rejects obvious garbage before disk.
const cronExpressionSchema = z.string().trim().min(1).max(120).regex(
  /^(\S+\s+){4}\S+$/, 'expected a 5-field cron expression',
);

// The `privacy.recheck` settings slice. Validated by PUT /api/settings when the
// `privacy` key is present (partial). Everything OFF/absent by default.
export const privacyRecheckConfigSchema = z.object({
  enabled: z.boolean().optional(),
  cronExpression: cronExpressionSchema.optional(),
  autoApproveOptOutEmails: z.boolean().optional(),
  autoSubmitWebForms: z.boolean().optional(),
}).strict();

// The `privacy` settings slice (only `recheck` for now — room to grow).
export const privacySettingsSchema = z.object({
  recheck: privacyRecheckConfigSchema.optional(),
}).strict();
