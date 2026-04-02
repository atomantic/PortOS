import { request } from './apiCore.js';

// Git
export const getGitInfo = (path) => request('/git/info', {
  method: 'POST',
  body: JSON.stringify({ path })
});
export const getGitStatus = (path) => request('/git/status', {
  method: 'POST',
  body: JSON.stringify({ path })
});
export const getGitDiff = (path, staged = false) => request('/git/diff', {
  method: 'POST',
  body: JSON.stringify({ path, staged })
});
export const getGitCommits = (path, limit = 10) => request('/git/commits', {
  method: 'POST',
  body: JSON.stringify({ path, limit })
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
export const pullBranch = (path) => request('/git/pull', {
  method: 'POST',
  body: JSON.stringify({ path })
});
export const syncBranch = (path, branch) => request('/git/sync', {
  method: 'POST',
  body: JSON.stringify({ path, branch })
});
export const getRemoteBranches = (path) => request('/git/remote-branches', {
  method: 'POST',
  body: JSON.stringify({ path })
});
export const deleteBranch = (path, branch, { local = false, remote = false } = {}) =>
  request('/git/delete-branch', {
    method: 'POST',
    body: JSON.stringify({ path, branch, local, remote })
  });
export const cleanupMergedBranches = (path) => request('/git/cleanup-merged', {
  method: 'POST',
  body: JSON.stringify({ path })
});
export const mergeBranch = (path, branch) => request('/git/merge', {
  method: 'POST',
  body: JSON.stringify({ path, branch })
});
export const checkoutRemoteBranch = (path, branch) => request('/git/checkout-remote', {
  method: 'POST',
  body: JSON.stringify({ path, branch })
});
