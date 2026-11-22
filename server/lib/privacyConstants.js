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

// Origin-bound website credentials (#17397). Managed only through the
// website-login endpoints (services/privacyWebsiteLogins.js): the encrypted
// payload is a JSON credential, never a generic string value, so it is NOT in
// PRIVACY_VAULT_TYPES and the generic create/update/reveal paths refuse it.
export const PRIVACY_WEBSITE_LOGIN_TYPE = 'website_login';

// Types that may NEVER be used for broker scans (`use_for_scans` forced false),
// never injected into the twin's prompt, and never decrypted for draft or prompt
// scrubbing. Every reader that excludes these by type covers website logins too.
export const PRIVACY_SENSITIVE_TYPES = Object.freeze([
  'ssn', 'passport', 'drivers_license', 'financial_account', PRIVACY_WEBSITE_LOGIN_TYPE,
]);

// Types whose `use_for_scans` defaults to true.
export const PRIVACY_SCAN_DEFAULT_TYPES = Object.freeze([
  'legal_name', 'email', 'phone', 'address',
]);

export const PRIVACY_VAULT_STATUSES = Object.freeze(['current', 'previous']);
