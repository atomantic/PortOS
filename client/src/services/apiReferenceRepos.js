import { request } from './apiCore.js';

// Reference repos — upstream code we borrow from. Each entry is per-app.
// The `reference-watch` self-improvement task type uses `checkReferenceRepo`
// to pull each ref and decide whether to dispatch a CoS sub-agent.

export const listReferenceRepos = (appId) =>
  request(`/apps/${appId}/reference-repos`);

// `options` lets a caller suppress request()'s auto-toast with `{ silent: true }`
// when it already renders its own error UI.
export const addReferenceRepo = (appId, body, options = {}) =>
  request(`/apps/${appId}/reference-repos`, {
    method: 'POST',
    body: JSON.stringify(body),
    ...options,
  });

export const updateReferenceRepo = (appId, refId, body, options = {}) =>
  request(`/apps/${appId}/reference-repos/${refId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    ...options,
  });

export const deleteReferenceRepo = (appId, refId, options = {}) =>
  request(`/apps/${appId}/reference-repos/${refId}`, {
    method: 'DELETE',
    ...options,
  });

// Run a check now — returns { head, headShort, commitCount, commits, ... }.
// Does NOT advance lastReviewedSha.
export const checkReferenceRepo = (appId, refId, options = {}) =>
  request(`/apps/${appId}/reference-repos/${refId}/check`, {
    method: 'POST',
    ...options,
  });

// Pin lastReviewedSha after the user / agent has processed the changes.
export const markReferenceRepoReviewed = (appId, refId, sha, options = {}) =>
  request(`/apps/${appId}/reference-repos/${refId}/reviewed`, {
    method: 'POST',
    body: JSON.stringify({ sha }),
    ...options,
  });
