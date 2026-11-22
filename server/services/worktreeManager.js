/** Compatibility entry point for the Git worktree manager and its callers. */

export { isHumanClaimWorktree } from '../lib/worktreeOwnership.js';
export {
  WORKTREE_ADD_TIMEOUT_MS,
  isGitLockError,
  isBranchCheckedOutElsewhereError,
  addWorktreeWithRetry,
  isPreexistingRefError,
} from './worktree/gitErrors.js';
export { linkWorktreeDependencies, unlinkWorktreeDependencies } from './worktree/dependencies.js';
export { classifyWorktreeDirt, readCheckoutPresence, readWorktreeStatus } from './worktree/status.js';
export {
  PINNED_HEAD_MOVED,
  createWorktree,
  findAdoptableWorktreeForBranch,
  SIBLING_NEXT_HOLDER_IDLE_MS,
  releaseIdleSiblingNextHolder,
  releaseOwnerlessForeignHolder,
  adoptWorktree,
} from './worktree/create.js';
export {
  deleteCompletedLocalBranch,
  forceRemoveWorktreeDir,
  shouldRefuseDefaultBranchMerge,
  removeWorktree,
  removeWorktreeAtPath,
} from './worktree/remove.js';
export { createPersistentWorktree, removePersistentWorktree, mergeBaseIntoFeatureWorktree } from './worktree/persistent.js';
export { cleanupOrphanedWorktrees, reapMergedWorktrees, listWorktrees } from './worktree/cleanup.js';
