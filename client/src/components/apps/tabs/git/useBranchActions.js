import { useState } from 'react';
import toast from '../../../ui/Toast';
import { triggerCosOnDemandTask, forceCosEvaluate } from '../../../../services/apiAgents.js';
import {
  checkoutBranch,
  pushBranch,
  syncBranch,
  mergeBranch,
  deleteBranch,
  checkoutRemoteBranch,
  cleanupMergedBranches,
  getBranches,
} from '../../../../services/apiGit.js';

// Per-row branch actions for the Local and Remote Branches panels: in-flight
// markers (the branch name being acted on), the open inline confirm, and the
// merged-branch cleanup the two panels share (one confirm open at a time,
// tagged 'local' | 'remote'). Owned by GitTab rather than the panels because a
// reload swaps the panels for a spinner, and an open confirm or an in-flight
// guard must survive that.
export default function useBranchActions({ appId, appName, repoPath, setBranches, setRemoteBranches, loadGitInfo }) {
  const [reconciling, setReconciling] = useState(false);
  const [checkingOut, setCheckingOut] = useState(null);
  const [pushing, setPushing] = useState(null);
  const [syncing, setSyncing] = useState(null);
  const [merging, setMerging] = useState(null);
  const [mergeConfirm, setMergeConfirm] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [checkingOutRemote, setCheckingOutRemote] = useState(null);
  // false | true (bulk cleanup) | branch name (one merged branch from its row)
  const [cleaningUp, setCleaningUp] = useState(false);
  const [cleanupConfirm, setCleanupConfirm] = useState(false);
  const [mergedDeleteConfirm, setMergedDeleteConfirm] = useState(null);

  const handleReconcileBranches = async () => {
    if (!appId || reconciling) return;
    setReconciling(true);
    const result = await triggerCosOnDemandTask('branch-reconcile', appId, { silent: true }).catch((err) => {
      toast.error(`Could not queue branch reconcile: ${err.message}`);
      return null;
    });
    setReconciling(false);
    if (result) {
      toast.success(`Branch reconcile queued for ${appName} — check CoS Agents`);
      await forceCosEvaluate().catch(() => null);
    }
  };

  const handleCheckout = async (branchName) => {
    if (!repoPath || checkingOut) return;
    setCheckingOut(branchName);
    const result = await checkoutBranch(repoPath, branchName).catch(() => null);
    setCheckingOut(null);
    if (result?.success) {
      toast.success(`Switched to ${branchName}`);
      await loadGitInfo();
    }
  };

  const handlePush = async (branchName) => {
    if (!repoPath || pushing) return;
    setPushing(branchName);
    const result = await pushBranch(repoPath, branchName).catch(() => null);
    setPushing(null);
    if (result?.success) {
      toast.success(`Pushed ${branchName}`);
      await loadGitInfo();
    }
  };

  const handleSync = async (branchName) => {
    if (!repoPath || syncing) return;
    setSyncing(branchName);
    const result = await syncBranch(repoPath, branchName).catch(() => null);
    setSyncing(null);
    if (result?.success) {
      toast.success(`Synced ${branchName}`);
      await loadGitInfo();
    } else if (result?.error) {
      toast.error(`Sync failed: ${result.error}`);
    }
  };

  const handleMerge = async (branchName) => {
    if (!repoPath || merging) return;
    setMerging(branchName);
    setMergeConfirm(null);
    const result = await mergeBranch(repoPath, branchName, { silent: true }).catch((err) => {
      toast.error(`Merge failed: ${err.message}`);
      return null;
    });
    setMerging(null);
    if (result?.success) {
      toast.success(`Merged ${branchName} into current branch`);
      await loadGitInfo();
    }
  };

  const handleDeleteBranch = async (branchName, { local, remote }) => {
    if (!repoPath || deleting) return;
    setDeleting(branchName);
    setDeleteConfirm(null);
    const result = await deleteBranch(repoPath, branchName, { local, remote }, { silent: true }).catch((err) => {
      toast.error(`Delete failed: ${err.message}`);
      return null;
    });
    setDeleting(null);
    if (result) {
      const results = result.results || {};
      const parts = Object.entries(results).map(([k, v]) => `${k}: ${v}`);
      toast.success(`Branch ${branchName} — ${parts.join(', ')}`);
      const localDeleted = local && results.local === 'deleted';
      const remoteDeleted = remote && results.remote === 'deleted';
      if (localDeleted) {
        setBranches(prev => prev.filter(b => b.name !== branchName));
      }
      if (remoteDeleted) {
        setRemoteBranches(prev => prev.filter(b => b.name !== branchName));
      }
      if (localDeleted && !remoteDeleted) {
        setRemoteBranches(prev => prev.map(b =>
          b.name === branchName ? { ...b, hasLocal: false } : b
        ));
      }
      if (remoteDeleted && !localDeleted) {
        setBranches(prev => prev.map(b =>
          b.name === branchName
            ? { ...b, tracking: null, ahead: 0, behind: 0, hasRemote: false }
            : b
        ));
      }
    }
  };

  const handleCheckoutRemote = async (branchName) => {
    if (!repoPath || checkingOutRemote) return;
    setCheckingOutRemote(branchName);
    const result = await checkoutRemoteBranch(repoPath, branchName, { silent: true }).catch((err) => {
      toast.error(`Checkout failed: ${err.message}`);
      return null;
    });
    setCheckingOutRemote(null);
    if (result?.success) {
      toast.success(`Checked out ${branchName}`);
      setRemoteBranches(prev => prev.map(b =>
        b.name === branchName ? { ...b, hasLocal: true } : b
      ));
      await loadGitInfo();
    }
  };

  // With a branch name, the same server cleanup (and its safety holds) scoped
  // to that one merged branch — the per-row delete.
  const handleCleanupMerged = async (branchName = null) => {
    if (!repoPath || cleaningUp) return;
    setCleaningUp(branchName || true);
    setCleanupConfirm(false);
    setMergedDeleteConfirm(null);
    const result = await cleanupMergedBranches(repoPath, { silent: true, ...(branchName && { branches: [branchName] }) }).catch((err) => {
      toast.error(`${branchName ? `Delete ${branchName}` : 'Cleanup'} failed: ${err.message}`);
      return null;
    });
    setCleaningUp(false);
    if (result) {
      const deleted = Array.isArray(result.deleted) ? result.deleted : [];
      const skipped = Array.isArray(result.skipped) ? result.skipped : [];
      const count = deleted.length;
      const removedWorktrees = deleted.filter(d => d.worktree === 'removed').length;
      // Each entry already reads "<branch> (local: <why it survived>)" — the
      // answer to "why is this branch still here?", which a bare count isn't.
      const preserved = `${skipped.slice(0, 2).join('; ')}${skipped.length > 2 ? ` (+${skipped.length - 2} more)` : ''}`;
      if (count === 0) {
        if (branchName) {
          toast.error(skipped.length > 0 ? `Not deleted — ${preserved}` : `Not deleted — ${branchName} is no longer a merged branch`);
        } else {
          toast(
            skipped.length > 0 ? `No branches deleted — preserved ${preserved}` : 'No merged branches to clean up',
            { icon: skipped.length > 0 ? '⚠️' : 'ℹ️' }
          );
        }
        return;
      }
      if (branchName) {
        toast.success(`Deleted ${branchName}${removedWorktrees > 0 ? ' and its worktree' : ''}`);
      } else {
        const worktreeSuffix = removedWorktrees > 0
          ? ` and ${removedWorktrees} worktree${removedWorktrees === 1 ? '' : 's'}`
          : '';
        toast.success(`Cleaned up ${count} merged branch${count === 1 ? '' : 'es'}${worktreeSuffix}`);
      }
      if (skipped.length > 0) toast(`Preserved ${preserved}`, { icon: '⚠️' });
      const deletedRemotes = new Set(deleted.filter(d => d.remote === 'deleted').map(d => d.name));
      setRemoteBranches(prev => prev.filter(b => !deletedRemotes.has(b.name)));
      // A reap also clears the `worktree` flag on whatever survived, so re-read
      // the branches instead of filtering the stale list. Only the branch list
      // can have changed — no need for the full loadGitInfo fan-out.
      if (removedWorktrees > 0) {
        const refreshed = await getBranches(repoPath).catch(() => null);
        if (refreshed) setBranches(refreshed.branches || []);
      } else {
        const deletedLocals = new Set(deleted.filter(d => d.local === 'deleted').map(d => d.name));
        setBranches(prev => prev.filter(b => !deletedLocals.has(b.name)));
      }
    }
  };

  return {
    // Any row action in flight; the tab's Rebase & push stays disabled meanwhile.
    busy: Boolean(syncing || pushing || checkingOut || merging || checkingOutRemote),
    reconciling,
    handleReconcileBranches,
    checkingOut,
    pushing,
    syncing,
    merging,
    mergeConfirm,
    setMergeConfirm,
    deleting,
    deleteConfirm,
    setDeleteConfirm,
    checkingOutRemote,
    cleaningUp,
    cleanupConfirm,
    setCleanupConfirm,
    mergedDeleteConfirm,
    setMergedDeleteConfirm,
    handleCheckout,
    handlePush,
    handleSync,
    handleMerge,
    handleDeleteBranch,
    handleCheckoutRemote,
    handleCleanupMerged,
  };
}
