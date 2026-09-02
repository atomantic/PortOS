import { request } from './apiCore.js';

// Git
export const getGitInfo = (path) => request('/git/info', {
  method: 'POST',
  body: JSON.stringify({ path })
});
export const getGitDiff = (path, staged = false) => request('/git/diff', {
  method: 'POST',
  body: JSON.stringify({ path, staged })
});
export const stageFiles = (path, files) => request('/git/stage', {
  method: 'POST',
  body: JSON.stringify({ path, files })
});
export const unstageFiles = (path, files) => request('/git/unstage', {
  method: 'POST',
  body: JSON.stringify({ path, files })
});
export const createCommit = (path, message) => request('/git/commit', {
  method: 'POST',
  body: JSON.stringify({ path, message })
});
export const updateBranches = (path) => request('/git/update-branches', {
  method: 'POST',
  body: JSON.stringify({ path })
});
export const getBranchComparison = (path, base, head) => request('/git/branch-comparison', {
  method: 'POST',
  body: JSON.stringify({ path, base, head })
});
export const pushBranch = (path, branch) => request('/git/push', {
  method: 'POST',
  body: JSON.stringify({ path, branch })
});
export const pushAllBranches = (path) => request('/git/push-all', {
  method: 'POST',
  body: JSON.stringify({ path })
});
export const getBranches = (path) => request('/git/branches', {
  method: 'POST',
  body: JSON.stringify({ path })
});
export const checkoutBranch = (path, branch) => request('/git/checkout', {
  method: 'POST',
  body: JSON.stringify({ path, branch })
});
export const syncBranch = (path, branch) => request('/git/sync', {
  method: 'POST',
  body: JSON.stringify({ path, branch })
});
export const getRemoteBranches = (path, { force = false } = {}) => request('/git/remote-branches', {
  method: 'POST',
  body: JSON.stringify({ path, force })
});
// `options` lets a caller suppress request()'s auto-toast with `{ silent: true }`
// when it already renders its own error UI.
export const deleteBranch = (path, branch, { local = false, remote = false } = {}, options = {}) =>
  request('/git/delete-branch', {
    method: 'POST',
    body: JSON.stringify({ path, branch, local, remote }),
    ...options
  });
// Destructive: discards tracked changes and local commits on the default
// branch. Resolves with `previousHead` — the pre-reset sha, so the caller can
// show a recovery handle.
export const resetToDefaultBranch = (path, options = {}) => request('/git/reset-to-default', {
  method: 'POST',
  body: JSON.stringify({ path }),
  ...options
});
export const cleanupMergedBranches = (path, options = {}) => request('/git/cleanup-merged', {
  method: 'POST',
  body: JSON.stringify({ path }),
  ...options
});
export const mergeBranch = (path, branch, options = {}) => request('/git/merge', {
  method: 'POST',
  body: JSON.stringify({ path, branch }),
  ...options
});
export const checkoutRemoteBranch = (path, branch, options = {}) => request('/git/checkout-remote', {
  method: 'POST',
  body: JSON.stringify({ path, branch }),
  ...options
});
// repoPath is optional — omitted, the server reports the PortOS checkout's
// submodules. Resolves to `{ submodules, defaultBranch }`.
export const getSubmodules = (repoPath, options = {}) => request(
  `/git/submodules/status${repoPath ? `?${new URLSearchParams({ repoPath })}` : ''}`,
  options
);
export const updateSubmodule = (path, { repoPath, commit, ...options } = {}) => request('/git/submodules/update', {
  method: 'POST',
  body: JSON.stringify({ path, repoPath, commit }),
  ...options
});
