import { request } from './apiCore.js';

// Privacy Center — encrypted PII Vault + Trusted Organizations registry
// (issues #2140, #2141; UI shell #2142; Digital Twin cross-link #2147). Every
// wrapper takes an optional `options` object so callers that own their own error
// UI (useAsyncAction, custom catch) can pass `{ silent: true }` per the toasting
// convention.

// ── Status (doctor-style readout) ───────────────────────────────────────────
export const getPrivacyStatus = (options) => request('/privacy/status', options);

// ── Vault records ───────────────────────────────────────────────────────────
export const getVaultRecords = (type, options) =>
  request(`/privacy/vault${type ? `?type=${encodeURIComponent(type)}` : ''}`, options);
export const getVaultRecord = (id, options) => request(`/privacy/vault/${id}`, options);
export const createVaultRecord = (data, options) => request('/privacy/vault', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options,
});
export const updateVaultRecord = (id, patch, options) => request(`/privacy/vault/${id}`, {
  method: 'PUT',
  body: JSON.stringify(patch),
  ...options,
});
export const deleteVaultRecord = (id, options) => request(`/privacy/vault/${id}`, {
  method: 'DELETE',
  ...options,
});
// The ONE decrypt path — explicit user action. Returns { id, type, value }.
export const revealVaultRecord = (id, options) => request(`/privacy/vault/${id}/reveal`, {
  method: 'POST',
  ...options,
});

// ── Trusted Organizations registry ──────────────────────────────────────────
export const getPrivacyOrgs = (filters = {}, options) => {
  const qs = new URLSearchParams(
    Object.entries(filters).filter(([, v]) => v != null && v !== ''),
  ).toString();
  return request(`/privacy/orgs${qs ? `?${qs}` : ''}`, options);
};
export const getPrivacyOrg = (id, options) => request(`/privacy/orgs/${id}`, options);
export const createPrivacyOrg = (data, options) => request('/privacy/orgs', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options,
});
export const updatePrivacyOrg = (id, patch, options) => request(`/privacy/orgs/${id}`, {
  method: 'PUT',
  body: JSON.stringify(patch),
  ...options,
});
export const deletePrivacyOrg = (id, options) => request(`/privacy/orgs/${id}`, {
  method: 'DELETE',
  ...options,
});

// ── Org holdings (which vault records an org holds) ─────────────────────────
export const getOrgHoldings = (id, options) => request(`/privacy/orgs/${id}/holdings`, options);
// Replace-set semantics: `holdings` is the FULL list of { vaultRecordId, status }.
export const setOrgHoldings = (id, holdings, options) => request(`/privacy/orgs/${id}/holdings`, {
  method: 'PUT',
  body: JSON.stringify({ holdings }),
  ...options,
});

// ── Change-of-address events + inventory (#2143) ────────────────────────────
export const getPrivacyChanges = (options) => request('/privacy/changes', options);
export const getPrivacyChange = (id, options) => request(`/privacy/changes/${id}`, options);
// Declare a change: { vaultRecordId, replacement?|replacementRecordId?, kind?, note? }.
export const declarePrivacyChange = (data, options) => request('/privacy/changes', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options,
});
export const markChangeOrgUpdated = (id, orgId, options) =>
  request(`/privacy/changes/${id}/orgs/${orgId}/updated`, { method: 'POST', ...options });
export const markChangeOrgRemoved = (id, orgId, options) =>
  request(`/privacy/changes/${id}/orgs/${orgId}/removed`, { method: 'POST', ...options });
// Drafts a "please update my records" email into the Comms queue (unapproved).
export const draftChangeUpdateEmail = (id, orgId, options) =>
  request(`/privacy/changes/${id}/orgs/${orgId}/draft-email`, { method: 'POST', ...options });

// ── Data-broker database + case ledger + opt-out engine (#2144/#2145; UI #2146) ─
/** Broker database rows. `enabled` filters to enabled-only when true/false. */
export const getPrivacyBrokers = (enabled, options) =>
  request(`/privacy/brokers${enabled === undefined ? '' : `?enabled=${enabled ? 'true' : 'false'}`}`, options);
/** Toggle a broker on/off (skips it in scan + opt-out passes). */
export const setPrivacyBrokerEnabled = (id, enabled, options) => request(`/privacy/brokers/${id}`, {
  method: 'PUT',
  body: JSON.stringify({ enabled }),
  ...options,
});
/** User-triggered broker-list refresh (BADBOOL + CA registry; never clobbers curated). */
export const refreshPrivacyBrokers = (options) => request('/privacy/brokers/refresh', {
  method: 'POST',
  ...options,
});
/** Case ledger rows (joined with broker name/tier). `state` filters when set. */
export const getPrivacyBrokerCases = (state, options) =>
  request(`/privacy/broker-cases${state ? `?state=${encodeURIComponent(state)}` : ''}`, options);
/** Force a case due for recheck now. */
export const recheckPrivacyCase = (id, options) =>
  request(`/privacy/broker-cases/${id}/recheck`, { method: 'POST', ...options });
/** Manual case transition (digest done/dismiss, drawer controls): { toState, reason? }. */
export const transitionPrivacyCase = (id, toState, reason, options) => request(`/privacy/broker-cases/${id}/transition`, {
  method: 'POST',
  body: JSON.stringify(reason ? { toState, reason } : { toState }),
  ...options,
});
/** Aggregate exposure readout: enabledBrokers, caseCounts (per state), dueForRecheck. */
export const getPrivacyScanStatus = (options) => request('/privacy/scan/status', options);
/** Run a read-only exposure scan pass over enabled brokers. */
export const runPrivacyScan = (options) => request('/privacy/scan', { method: 'POST', ...options });
/** Run one opt-out pass (submit found/indirect cases via the chosen lane, poll verifications). */
export const runPrivacyOptOut = (options) => request('/privacy/optout', { method: 'POST', ...options });
/** Human-task digest: cases needing a person (blocked / human-only channels). */
export const getPrivacyOptOutDigest = (options) => request('/privacy/optout/digest', options);
/** Recheck-schedule status: { enabled, cronExpression, autoApproveOptOutEmails, autoSubmitWebForms, nextRun }. */
export const getPrivacyOptOutSchedule = (options) => request('/privacy/optout/schedule', options);
/** Update the recheck cron + autonomy toggles; restarts the scheduler. Returns the new status. */
export const updatePrivacyOptOutSchedule = (patch, options) => request('/privacy/optout/schedule', {
  method: 'PUT',
  body: JSON.stringify(patch),
  ...options,
});

// ── Digital Twin cross-link (#2147) ─────────────────────────────────────────
/** Social-account → org links for the Twin's "in org registry" badges. */
export const getSocialAccountOrgLinks = (options) =>
  request('/privacy/social-account-links', options);
