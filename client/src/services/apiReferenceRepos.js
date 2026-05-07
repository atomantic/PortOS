import { request } from './apiCore.js';

// Reference repos — upstream code we borrow from. Each entry is per-app.
// The `reference-watch` self-improvement task type uses `checkReferenceRepo`
// to pull each ref and decide whether to dispatch a CoS sub-agent.

export const listReferenceRepos = (appId) =>
  request(`/apps/${appId}/reference-repos`);

export const addReferenceRepo = (appId, body) =>
  request(`/apps/${appId}/reference-repos`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

export const updateReferenceRepo = (appId, refId, body) =>
  request(`/apps/${appId}/reference-repos/${refId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });

export const deleteReferenceRepo = (appId, refId) =>
  request(`/apps/${appId}/reference-repos/${refId}`, {
    method: 'DELETE',
  });

// Run a check now — returns { head, headShort, commitCount, commits, ... }.
// Does NOT advance lastReviewedSha.
export const checkReferenceRepo = (appId, refId) =>
  request(`/apps/${appId}/reference-repos/${refId}/check`, {
    method: 'POST',
  });

// Pin lastReviewedSha after the user / agent has processed the changes.
export const markReferenceRepoReviewed = (appId, refId, sha) =>
  request(`/apps/${appId}/reference-repos/${refId}/reviewed`, {
    method: 'POST',
    body: JSON.stringify({ sha }),
  });
