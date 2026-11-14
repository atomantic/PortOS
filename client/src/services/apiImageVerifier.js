/**
 * apiImageVerifier.js — Client API service for Image Verifier settings,
 * profiles, on-demand evaluations, and manual overrides.
 */

import { request } from './apiCore.js';

export const getVerifierSettings = (options = {}) =>
  request('/image-verifier/settings', options);

export const updateVerifierSettings = (updates, options = {}) =>
  request('/image-verifier/settings', {
    method: 'PUT',
    body: JSON.stringify(updates),
    ...options,
  });

export const listVerificationProfiles = (options = {}) =>
  request('/image-verifier/profiles', options);

export const getVerificationProfile = (id, options = {}) =>
  request(`/image-verifier/profiles/${encodeURIComponent(id)}`, options);

export const saveVerificationProfile = (profile, options = {}) =>
  request('/image-verifier/profiles', {
    method: 'POST',
    body: JSON.stringify(profile),
    ...options,
  });

export const deleteVerificationProfile = (id, options = {}) =>
  request(`/image-verifier/profiles/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    ...options,
  });

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
