/**
 * Feature priorities API: resolved tiers, pin updates and the focused-visit beacon (`postFeatureVisit`).
 *
 * `getFeaturePriorities`/`setFeaturePriorityPin` back Settings > Features (#18525); `postFeatureVisit(path)` (`POST /feature-priorities/visit`, #18523) reports one focused page visit so the server can learn which feature areas this install uses.
 *
 * The server maps the path to a feature area and ignores any path no area owns. The call is a one-shot beacon: it is always silent (no toast on failure, including a host-control refusal on a remote password-free install) and the caller never retries.
 */

import { request } from './apiCore.js';

export const postFeatureVisit = (path, options) =>
  request('/feature-priorities/visit', { method: 'POST', body: JSON.stringify({ path }), ...options, silent: true, hostControlOptional: true });

// The resolved tier per feature area. Callers own the load-failure UI, so they pass `{ silent: true }`.
export const getFeaturePriorities = (options) => request('/feature-priorities', options);

// `tier: null` clears the pin. The response is only `{ areaId, tier }`; a cleared pin's effective tier comes from a fresh `getFeaturePriorities`.
export const setFeaturePriorityPin = (areaId, tier, options) =>
  request(`/feature-priorities/${encodeURIComponent(areaId)}`, { method: 'PUT', body: JSON.stringify({ tier }), ...options });
