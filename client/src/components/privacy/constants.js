// Privacy Center shared enums + display labels (issue #2142). Kept in sync with
// the server Zod schemas in server/lib/privacyValidation.js — a mismatch would
// let the UI offer a value the API rejects.

export const VAULT_TYPES = [
  { id: 'legal_name', label: 'Legal name' },
  { id: 'address', label: 'Address' },
  { id: 'phone', label: 'Phone' },
  { id: 'email', label: 'Email' },
  { id: 'dob', label: 'Date of birth' },
  { id: 'ssn', label: 'SSN' },
  { id: 'passport', label: 'Passport' },
  { id: 'drivers_license', label: "Driver's license" },
  { id: 'financial_account', label: 'Financial account' },
  { id: 'custom', label: 'Custom' },
];

// Mirrors PRIVACY_SENSITIVE_TYPES — these can never be used for broker scans.
export const SENSITIVE_TYPES = ['ssn', 'passport', 'drivers_license', 'financial_account'];

export const VAULT_STATUSES = [
  { id: 'current', label: 'Current' },
  { id: 'previous', label: 'Previous' },
];

export const ORG_CATEGORIES = [
  { id: 'bank', label: 'Bank' },
  { id: 'utility', label: 'Utility' },
  { id: 'government', label: 'Government' },
  { id: 'employer', label: 'Employer' },
  { id: 'subscription', label: 'Subscription' },
  { id: 'medical', label: 'Medical' },
  { id: 'insurance', label: 'Insurance' },
  { id: 'platform', label: 'Platform' },
  { id: 'broker', label: 'Data broker' },
  { id: 'other', label: 'Other' },
];

export const ORG_TRUST_LEVELS = [
  { id: 'trusted', label: 'Trusted' },
  { id: 'tolerated', label: 'Tolerated' },
  { id: 'unwanted', label: 'Unwanted' },
];

export const ORG_STATUSES = [
  { id: 'active', label: 'Active' },
  { id: 'closed', label: 'Closed' },
  { id: 'opted_out', label: 'Opted out' },
];

export const ORG_HOLDING_STATUSES = [
  { id: 'current', label: 'Current' },
  { id: 'update_pending', label: 'Update pending' },
  { id: 'updated', label: 'Updated' },
  { id: 'removed', label: 'Removed' },
  { id: 'unknown', label: 'Unknown' },
];

// Tailwind tone classes per trust level (pre-composed — the JIT needs whole tokens).
export const TRUST_TONE = {
  trusted: 'bg-port-success/15 text-port-success border-port-success/30',
  tolerated: 'bg-port-warning/15 text-port-warning border-port-warning/30',
  unwanted: 'bg-port-error/15 text-port-error border-port-error/30',
};

export const HOLDING_TONE = {
  current: 'bg-gray-700/40 text-gray-300 border-gray-600/40',
  update_pending: 'bg-port-warning/15 text-port-warning border-port-warning/30',
  updated: 'bg-port-success/15 text-port-success border-port-success/30',
  removed: 'bg-gray-700/40 text-gray-400 border-gray-600/40',
  unknown: 'bg-gray-700/40 text-gray-400 border-gray-600/40',
};

export const labelFor = (list, id) => list.find((x) => x.id === id)?.label ?? id;
