/**
 * Privacy Center constants and vocabularies — dependency-free leaf so services
 * don't pull `privacyValidation.js` (route schemas) into the federated graph.
 */

// Fixed UUID for the seeded `self` subject (matches DDL in server/lib/db/schema/privacy.js
// and server/scripts/init-db.sql).
export const PRIVACY_SELF_SUBJECT_ID = '00000000-0000-4000-8000-000000000001';

export const PRIVACY_SUBJECT_RELATIONSHIPS = Object.freeze([
  'self', 'partner', 'child', 'parent', 'dependent', 'other',
]);

export const PRIVACY_CONSENT_METHODS = Object.freeze([
  'self', 'verbal', 'written', 'signed_form', 'guardian', 'power_of_attorney', 'other',
]);

// Consent purpose scopes (#8332) — granted and gated independently.
export const PRIVACY_CONSENT_SCOPES = Object.freeze(['pii_vault', 'broker_scan', 'broker_optout']);

// External-disclosure purposes revocable without deleting the subject.
export const PRIVACY_BROKER_CONSENT_SCOPES = Object.freeze(['broker_scan', 'broker_optout']);

export const PRIVACY_VAULT_TYPES = Object.freeze([
  'legal_name', 'address', 'phone', 'email', 'dob',
  'ssn', 'passport', 'drivers_license', 'financial_account', 'custom',
]);

// Types that may NEVER be used for broker scans (`use_for_scans` forced false).
export const PRIVACY_SENSITIVE_TYPES = Object.freeze([
  'ssn', 'passport', 'drivers_license', 'financial_account',
]);

// Types whose `use_for_scans` defaults to true.
export const PRIVACY_SCAN_DEFAULT_TYPES = Object.freeze([
  'legal_name', 'email', 'phone', 'address',
]);

export const PRIVACY_VAULT_STATUSES = Object.freeze(['current', 'previous']);
