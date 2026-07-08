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

// ── Digital Twin cross-link (#2147) ─────────────────────────────────────────
/** Social-account → org links for the Twin's "in org registry" badges. */
export const getSocialAccountOrgLinks = (options) =>
  request('/privacy/social-account-links', options);
