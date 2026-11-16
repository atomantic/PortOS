import { GitBranch, RefreshCw, Upload, ArrowUpDown, Check, Trash2, GitMerge, Loader2 } from 'lucide-react';
import ListLoadError from '../../../ui/ListLoadError';
import { iconBtnCls, touchBtnCls } from './gitButtonClasses';

function LocalBranchRow({ branch, actions }) {
  const {
    checkingOut, pushing, syncing, merging, mergeConfirm, setMergeConfirm,
    cleaningUp, mergedDeleteConfirm, setMergedDeleteConfirm,
    handleCheckout, handlePush, handleSync, handleMerge, handleCleanupMerged,
  } = actions;
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-y-1 py-2 px-2 rounded-lg ${branch.current ? 'bg-port-accent/10 border border-port-accent/30' : 'hover:bg-port-bg'}`}
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {branch.current ? (
          <Check size={14} className="text-port-accent shrink-0" />
        ) : (
          <GitBranch size={14} className="text-gray-500 shrink-0" />
        )}
        <span className={`text-sm truncate ${branch.current ? 'text-port-accent font-medium' : 'text-gray-300'}`}>
          {branch.name}
        </span>
        {branch.merged && (
          <span className="flex items-center gap-1 text-xs text-port-success px-1.5 py-0.5 bg-port-success/10 rounded shrink-0">
            <GitMerge size={10} />
            merged
          </span>
        )}
        {branch.worktree && (
          <span
            className="flex items-center gap-1 text-xs text-gray-400 px-1.5 py-0.5 bg-gray-500/10 rounded shrink-0"
            title="Checked out in a worktree"
          >
            <GitBranch size={10} />
            worktree
          </span>
        )}
        {branch.tracking && (
          <span className="text-xs text-gray-500 shrink-0">
            {branch.ahead > 0 && <span className="text-port-success">+{branch.ahead}</span>}
            {branch.ahead > 0 && branch.behind > 0 && ' / '}
            {branch.behind > 0 && <span className="text-port-warning">-{branch.behind}</span>}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {!branch.current && (
          <button
            onClick={() => handleCheckout(branch.name)}
            disabled={checkingOut === branch.name}
            className={`${iconBtnCls} text-gray-400 hover:text-white hover:bg-port-bg rounded disabled:opacity-50`}
            title="Checkout"
          >
            {checkingOut === branch.name ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <Check size={14} />
            )}
          </button>
        )}
        {branch.tracking && branch.ahead > 0 && (
          <button
            onClick={() => handlePush(branch.name)}
            disabled={pushing === branch.name}
            className={`${iconBtnCls} text-gray-400 hover:text-port-success hover:bg-port-bg rounded disabled:opacity-50`}
            title="Push"
          >
            {pushing === branch.name ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <Upload size={14} />
            )}
          </button>
        )}
        {branch.tracking && (
          <button
            onClick={() => handleSync(branch.name)}
            disabled={syncing === branch.name}
            className={`${iconBtnCls} text-gray-400 hover:text-port-accent hover:bg-port-bg rounded disabled:opacity-50`}
            title="Sync (pull & push)"
          >
            {syncing === branch.name ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <ArrowUpDown size={14} />
            )}
          </button>
        )}
        {!branch.current && (
          mergeConfirm === branch.name ? (
            <div className="flex flex-wrap items-center gap-1">
              <button
                onClick={() => handleMerge(branch.name)}
                disabled={merging === branch.name}
                className={`px-2 py-1 ${touchBtnCls} text-xs bg-port-accent/20 text-port-accent rounded hover:bg-port-accent/30 disabled:opacity-50 inline-flex items-center gap-1`}
              >
                {merging === branch.name ? <Loader2 size={12} className="animate-spin" /> : null}
                {merging === branch.name ? 'Merging...' : 'Confirm'}
              </button>
              <button
                onClick={() => setMergeConfirm(null)}
                className={`px-2 py-1 ${touchBtnCls} text-xs text-gray-400 hover:text-white`}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setMergeConfirm(branch.name)}
              className={`pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${iconBtnCls} text-gray-400 hover:text-port-accent hover:bg-port-bg rounded`}
              title={`Merge ${branch.name} into current branch`} aria-label={`Merge ${branch.name} into current branch`}
            >
              <GitMerge size={14} />
            </button>
          )
        )}
        {branch.merged && !branch.current && !branch.isDefault && (
          mergedDeleteConfirm === branch.name ? (
            <div className="flex flex-wrap items-center gap-1">
              <button
                onClick={() => handleCleanupMerged(branch.name)}
                disabled={!!cleaningUp}
                title={`Deletes ${branch.name} locally and on the remote${branch.worktree ? ', with its worktree, unless it still has uncommitted or unmerged work or is in use' : ''}`}
                className={`px-2 py-1 ${touchBtnCls} text-xs bg-port-error/20 text-port-error rounded hover:bg-port-error/30 disabled:opacity-50 inline-flex items-center gap-1`}
              >
                {cleaningUp === branch.name ? <Loader2 size={12} className="animate-spin" /> : null}
                {cleaningUp === branch.name ? 'Deleting...' : branch.worktree ? 'Delete branch + worktree' : 'Delete branch'}
              </button>
              <button
                onClick={() => setMergedDeleteConfirm(null)}
                className={`px-2 py-1 ${touchBtnCls} text-xs text-gray-400 hover:text-white`}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setMergedDeleteConfirm(branch.name)}
              disabled={!!cleaningUp}
              className={`pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${iconBtnCls} text-gray-400 hover:text-port-error hover:bg-port-bg rounded disabled:opacity-50`}
              title={`Delete ${branch.name}${branch.worktree ? ' and its worktree' : ''}`} aria-label={`Delete ${branch.name}${branch.worktree ? ' and its worktree' : ''}`}
            >
              {cleaningUp === branch.name ? <RefreshCw size={14} className="animate-spin" /> : <Trash2 size={14} />}
            </button>
          )
        )}
      </div>
    </div>
  );
}

// Local branches with per-row checkout/push/sync/merge/delete, the bulk
// merged-branch cleanup, and the branch-reconcile agent. Row state comes from
// `useBranchActions` so it survives the reload spinner.
export default function LocalBranchesPanel({ appId, branches, branchesError, loading, onRetry, actions }) {
  const { reconciling, handleReconcileBranches, cleaningUp, cleanupConfirm, setCleanupConfirm, handleCleanupMerged } = actions;

  // Keep the action visible for every merged local branch so a worktree-held
  // branch does not make the cleanup affordance disappear. Cleanup now tears the
  // worktree down too, so a merged branch sitting in one is an ordinary target
  // rather than a permanent leftover — a worktree survives only when it still
  // holds uncommitted or unmerged work, or something (a running agent, a claim,
  // a lock) is still using it. The server names which, per branch, in `skipped`.
  const localMergedCount = branches.filter(b => b.merged).length;
  const localWorktreeMergedCount = branches.filter(b => b.merged && b.worktree).length;
  const localCleanupTitle = localWorktreeMergedCount > 0
    ? `Deletes merged branches locally and on the remote, removing the ${localWorktreeMergedCount} worktree${localWorktreeMergedCount === 1 ? '' : 's'} holding one — unless it still has uncommitted or unmerged work, or is in use`
    : 'Deletes merged branches both locally and on the remote';

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-medium text-gray-400">Local Branches</h3>
        <div className="flex flex-wrap items-center gap-2">
          {appId && (
            <button
              onClick={handleReconcileBranches}
              disabled={reconciling}
              title="Queue a branch-reconcile agent to merge, push, or retire this app's leftover branches"
              className={`flex items-center gap-1 text-xs ${touchBtnCls} text-port-accent hover:text-white disabled:opacity-50`}
            >
              <GitMerge size={12} />
              {reconciling ? 'Queuing...' : 'Reconcile'}
            </button>
          )}
          {localMergedCount > 0 && !cleanupConfirm && (
            <button
              onClick={() => setCleanupConfirm('local')}
              disabled={!!cleaningUp}
              title={localCleanupTitle}
              className={`flex items-center gap-1 text-xs ${touchBtnCls} text-port-warning hover:text-port-error disabled:opacity-50`}
            >
              <Trash2 size={12} />
              {cleaningUp === true ? 'Cleaning...' : `Clean ${localMergedCount} merged`}
            </button>
          )}
          {localWorktreeMergedCount > 0 && !cleanupConfirm && (
            <span className="text-xs text-gray-500" role="status">
              {localWorktreeMergedCount} worktree{localWorktreeMergedCount === 1 ? '' : 's'} removed too, except any still in use or holding uncommitted work
            </span>
          )}
          {cleanupConfirm === 'local' && (
            <div className="flex flex-wrap items-center gap-1">
              <button
                onClick={() => handleCleanupMerged()}
                disabled={!!cleaningUp}
                title={localCleanupTitle}
                className={`px-2 py-1 ${touchBtnCls} text-xs bg-port-error/20 text-port-error rounded hover:bg-port-error/30 disabled:opacity-50`}
              >
                {cleaningUp === true
                  ? 'Deleting...'
                  : localWorktreeMergedCount > 0
                    ? 'Delete all merged (local + remote + worktrees)'
                    : 'Delete all merged (local + remote)'}
              </button>
              <button
                onClick={() => setCleanupConfirm(false)}
                className={`px-2 py-1 ${touchBtnCls} text-xs text-gray-400 hover:text-white`}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="space-y-2 max-h-64 overflow-auto">
        {branches.map((branch) => (
          <LocalBranchRow key={branch.name} branch={branch} actions={actions} />
        ))}
        {branchesError && (
          <ListLoadError what="branches" error={branchesError} onRetry={onRetry} retrying={loading} />
        )}
        {!branchesError && branches.length === 0 && (
          <div className="text-gray-500 text-sm">No branches found</div>
        )}
      </div>
    </div>
  );
}
