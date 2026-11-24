/** Compatibility entry point for the Git service and its callers. */

export { resolveForgeForRepo, resolveForgeTokenEnv } from './forgeAuth.js';
export { execGit, execGitSafe } from '../lib/execGit.js';
export { parseStatus, extractAgentSummary } from '../lib/gitOutputParsers.js';
export {
  parseGitRemote,
  parseGitHubOwnerFromRemote,
  pickGhAccountForOwner,
  detectForgeCli,
  parsePullRequestUrl
} from '../lib/gitForge.js';
export {
  getStatus,
  getStatusPorcelain,
  getBranch,
  getCommits,
  getDiff,
  getDiffStats,
  stageFiles,
  unstageFiles,
  commit,
  isRepo,
  notGitRepoMessage,
  getRemote,
  getBranchComparison,
  hasChangelogDir,
  getDefaultBranch,
  getRepoBranches,
  getBranches,
  getGitInfo
} from './git/status.js';
export {
  recordFetchSuccess,
  isFetchFresh,
  clearFetchCache,
  fetchOrigin,
  getRemoteBranches,
  updateBranches,
  push,
  pushAll,
  createBranch,
  checkout,
  mergeBranch,
  checkoutRemoteBranch,
  updateDefaultBranch,
  syncBranch,
  rebaseAndPushDefaultBranch,
  ensureLatest
} from './git/sync.js';
export {
  createPR,
  mergePR,
  requestCopilotReview,
  generatePRDescription,
  suggestPRTitle
} from './git/prs.js';
export {
  getWorktreeBranches,
  deleteBranch,
  readBranchLineage,
  readBranchAgeMs,
  readBranchPublished,
  hasBranchMergeEvidence,
  countDiscardable,
  findActiveAgentInWorkspace,
  resetToDefaultBranch,
  deleteMergedRemoteBranches,
  deleteMergedBranches
} from './git/cleanup.js';
