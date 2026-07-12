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

// Change-of-address event kinds (issue #2143) — mirrors PRIVACY_CHANGE_KINDS.
export const CHANGE_KINDS = [
  { id: 'address_change', label: 'Address change' },
  { id: 'phone_change', label: 'Phone change' },
  { id: 'email_change', label: 'Email change' },
  { id: 'name_change', label: 'Name change' },
  { id: 'other', label: 'Other' },
];

// Which vault type each change kind operates on — drives the Declare drawer's
// record picker and the derived default kind.
export const KIND_FOR_TYPE = {
  address: 'address_change',
  phone: 'phone_change',
  email: 'email_change',
  legal_name: 'name_change',
};

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

// ── Data-broker opt-out (issue #2146) ───────────────────────────────────────
// Case states — mirrors CASE_STATES / PRIVACY_BROKER_CASE_STATES on the server.
export const CASE_STATES = [
  { id: 'unscanned', label: 'Unscanned' },
  { id: 'found', label: 'Found' },
  { id: 'not_found', label: 'Not found' },
  { id: 'indirect_exposure', label: 'Indirect exposure' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'optout_in_progress', label: 'In progress' },
  { id: 'submitted', label: 'Submitted' },
  { id: 'verification_pending', label: 'Verifying' },
  { id: 'awaiting_processing', label: 'Awaiting' },
  { id: 'confirmed_removed', label: 'Removed' },
  { id: 'human_task_queued', label: 'Human task' },
  { id: 'reappeared', label: 'Reappeared' },
];

// Pre-composed Tailwind tone tokens per case state (JIT needs whole class names).
export const CASE_STATE_TONE = {
  unscanned: 'bg-gray-700/40 text-gray-400 border-gray-600/40',
  found: 'bg-port-error/15 text-port-error border-port-error/30',
  not_found: 'bg-gray-700/40 text-gray-400 border-gray-600/40',
  indirect_exposure: 'bg-port-warning/15 text-port-warning border-port-warning/30',
  // Warning (not error) tone: blocked means "unknown — needs a manual check,"
  // not "exposure confirmed."
  blocked: 'bg-port-warning/15 text-port-warning border-port-warning/30',
  optout_in_progress: 'bg-port-accent/15 text-port-accent border-port-accent/30',
  submitted: 'bg-port-accent/15 text-port-accent border-port-accent/30',
  verification_pending: 'bg-port-accent/15 text-port-accent border-port-accent/30',
  awaiting_processing: 'bg-port-warning/15 text-port-warning border-port-warning/30',
  confirmed_removed: 'bg-port-success/15 text-port-success border-port-success/30',
  human_task_queued: 'bg-port-warning/15 text-port-warning border-port-warning/30',
  reappeared: 'bg-port-error/15 text-port-error border-port-error/30',
};

// The exposure-map header chips, in display order (a curated subset + grouping).
export const EXPOSURE_MAP_STATES = [
  'found', 'indirect_exposure', 'optout_in_progress', 'submitted',
  'verification_pending', 'awaiting_processing', 'confirmed_removed',
  'blocked', 'human_task_queued', 'not_found',
];

// Manual case actions a human can take per state, as a PRESENTATION table
// (labels/tones/icons are UI concerns). The drawer + digest action strips both
// render from this table, so the rule lives in ONE place. Legality is NOT
// hardcoded here: `manualCaseActions()` filters each entry against the case's
// server-supplied `allowedTransitions` (derived from STATE_TRANSITIONS in
// server/services/privacyBrokers.js), so the UI structurally cannot offer an
// illegal transition or drift from the server. e.g. a blocked case's positive
// outcome is "I'm listed" (→ found); blocked → submitted is not legal and the
// server list simply never contains `submitted`, so it can never render.
export const CASE_ACTIONS = {
  blocked: [
    { target: 'found', label: "I'm listed", tone: 'error', icon: 'check' },
    { target: 'not_found', label: 'Dismiss (not found)', tone: 'muted', icon: 'x' },
  ],
  found: [
    { target: 'not_found', label: 'Dismiss (not found)', tone: 'muted', icon: 'x' },
  ],
  indirect_exposure: [
    { target: 'not_found', label: 'Dismiss (not found)', tone: 'muted', icon: 'x' },
  ],
  human_task_queued: [
    { target: 'submitted', label: 'Mark done', tone: 'success', icon: 'check' },
    { target: 'not_found', label: 'Dismiss (not found)', tone: 'muted', icon: 'x' },
  ],
};

// Pre-composed Tailwind tone tokens per action tone (JIT needs whole classes).
// `chip` = digest icon button, `button` = drawer labeled button.
export const ACTION_TONES = {
  error: {
    chip: 'text-port-error hover:bg-port-error/10',
    button: 'border-port-error/40 text-port-error hover:bg-port-error/10',
  },
  success: {
    chip: 'text-port-success hover:bg-port-success/10',
    button: 'border-port-success/40 text-port-success hover:bg-port-success/10',
  },
  muted: {
    chip: 'text-gray-400 hover:text-white hover:bg-port-border/50',
    button: 'border-port-border text-gray-400 hover:text-white hover:bg-port-card',
  },
};

// The manual action descriptors the UI may render for a case, gated by the
// server-supplied `allowedTransitions` so an illegal/absent transition is never
// offered. If `allowedTransitions` is absent (older payload / stale cached
// client), fall back to the curated table as-is — every curated entry is legal
// by construction, so this is a safe best-effort, not a legality bypass.
export function manualCaseActions(state, allowedTransitions) {
  const actions = CASE_ACTIONS[state] || [];
  if (!Array.isArray(allowedTransitions)) return actions;
  return actions.filter((a) => allowedTransitions.includes(a.target));
}

export const BROKER_SOURCES = [
  { id: 'curated', label: 'Curated' },
  { id: 'badbool', label: 'BADBOOL' },
  { id: 'ca_registry', label: 'CA registry' },
];

export const BROKER_CONFIDENCE = [
  { id: 'field_verified', label: 'Field-verified' },
  { id: 'documented', label: 'Documented' },
  { id: 'auto', label: 'Auto' },
];

export const labelFor = (list, id) => list.find((x) => x.id === id)?.label ?? id;
