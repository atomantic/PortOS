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
