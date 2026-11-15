/**
 * apiImageVerifier.js — Client API service for on-demand image evaluations
 * and manual overrides.
 */

import { request } from './apiCore.js';

export const verifyImageNow = (params, options = {}) =>
  request('/image-verifier/verify', {
    method: 'POST',
    body: JSON.stringify(params),
    ...options,
  });

export const overrideVerification = (params, options = {}) =>
  request('/image-verifier/override', {
    method: 'POST',
    body: JSON.stringify(params),
    ...options,
  });
