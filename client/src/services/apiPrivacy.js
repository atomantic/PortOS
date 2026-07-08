import { request } from './apiCore.js';

// Privacy Center — Trusted Organizations registry (issues #2140, #2141, #2147).
// Only the Digital Twin cross-link surfaces are wired today; the full vault /
// org-registry client lands with the Privacy Center UI (Phase 3/5/6).

/** Social-account → org links for the Twin's "in org registry" badges (#2147). */
export const getSocialAccountOrgLinks = (options) =>
  request('/privacy/social-account-links', options);

/** Create a trusted-org record (used by the Twin's "Add to org registry"). */
export const createPrivacyOrg = (data, options) =>
  request('/privacy/orgs', { method: 'POST', body: JSON.stringify(data), ...options });
