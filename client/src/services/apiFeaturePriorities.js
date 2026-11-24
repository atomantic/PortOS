/**
 * Feature priorities (#18523): `postFeatureVisit(path)` (`POST /feature-priorities/visit`) reports one focused page visit so the server can learn which feature areas this install uses.
 *
 * The server maps the path to a feature area and ignores any path no area owns. The call is a one-shot beacon: it is always silent (no toast on failure) and the caller never retries.
 */

import { request } from './apiCore.js';

export const postFeatureVisit = (path, options) =>
  request('/feature-priorities/visit', { method: 'POST', body: JSON.stringify({ path }), ...options, silent: true });
