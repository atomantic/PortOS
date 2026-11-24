import { GitBranch, RefreshCw, Download, Trash2, GitMerge, Globe } from 'lucide-react';
import BrailleSpinner from '../../../BrailleSpinner';
import ListLoadError from '../../../ui/ListLoadError';
import { formatDateNumeric } from '../../../../utils/formatters';
import { iconBtnCls, touchBtnCls } from './gitButtonClasses';

function RemoteBranchRow({ rb, actions }) {
  const { checkingOutRemote, handleCheckoutRemote, deleting, deleteConfirm, setDeleteConfirm, handleDeleteBranch } = actions;
  const deletable = !rb.isDefault && !rb.isProtected;
  return (
    <div
      className={`py-2 px-2 rounded-lg hover:bg-port-bg ${rb.isDefault ? 'bg-port-accent/5' : ''}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <GitBranch size={14} className={rb.isDefault ? 'text-port-accent shrink-0' : 'text-gray-500 shrink-0'} />
          <span className={`text-sm truncate ${rb.isDefault ? 'text-port-accent font-medium' : 'text-gray-300'}`}>
            {rb.name}
          </span>
          {rb.merged && !rb.isDefault && (
            <span className="flex items-center gap-1 text-xs text-port-success px-1.5 py-0.5 bg-port-success/10 rounded shrink-0">
              <GitMerge size={10} />
              merged
            </span>
          )}
          {rb.hasLocal && (
            <span className="text-xs text-gray-500 shrink-0">local</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {rb.lastCommitDate && (
            <span className="text-xs text-gray-500 hidden sm:inline">
              {formatDateNumeric(rb.lastCommitDate)}
            </span>
          )}
          {!rb.hasLocal && (
            <button
              onClick={() => handleCheckoutRemote(rb.name)}
              disabled={checkingOutRemote === rb.name}
              className={`${iconBtnCls} text-gray-400 hover:text-port-success hover:bg-port-bg rounded disabled:opacity-50`}
              title="Checkout locally"
            >
              {checkingOutRemote === rb.name ? (
                <RefreshCw size={14} className="animate-spin" />
              ) : (
                <Download size={14} />
              )}
            </button>
          )}
          {deletable && deleteConfirm !== rb.name && (
            <button
              onClick={() => setDeleteConfirm(rb.name)}
              className={`pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${iconBtnCls} text-gray-500 hover:text-port-error hover:bg-port-bg rounded`}
              title="Delete branch" aria-label="Delete branch"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
      {deletable && deleteConfirm === rb.name && (
        <div className="flex flex-wrap items-center gap-1 mt-2 pl-6">
          <button
            onClick={() => handleDeleteBranch(rb.name, { local: rb.hasLocal, remote: true })}
            disabled={deleting === rb.name}
            className={`px-2 py-1 ${touchBtnCls} text-xs bg-port-error/20 text-port-error rounded hover:bg-port-error/30 disabled:opacity-50`}
          >
            {deleting === rb.name ? 'Deleting...' : rb.hasLocal ? 'Delete both' : 'Delete remote'}
          </button>
          {rb.hasLocal && (
            <button
              onClick={() => handleDeleteBranch(rb.name, { local: false, remote: true })}
              disabled={deleting === rb.name}
              className={`px-2 py-1 ${touchBtnCls} text-xs bg-port-warning/20 text-port-warning rounded hover:bg-port-warning/30 disabled:opacity-50`}
            >
              Remote only
            </button>
          )}
          <button
            onClick={() => setDeleteConfirm(null)}
            className={`px-2 py-1 ${touchBtnCls} text-xs text-gray-400 hover:text-white`}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// Remote branches with checkout-locally and delete, plus the remote side of
// the shared merged-branch cleanup (only one cleanup confirm shows at a time).
export default function RemoteBranchesPanel({ remoteBranches, remoteBranchesError, loadingRemote, onRefresh, localWorktreeMergedCount = 0, actions }) {
  const { cleaningUp, cleanupConfirm, setCleanupConfirm, handleCleanupMerged } = actions;
  const mergedBranchCount = remoteBranches.filter(rb => rb.merged && !rb.isDefault && !rb.isProtected).length;
  const cleanupTitle = localWorktreeMergedCount > 0
    ? `Deletes merged branches locally and on the remote, removing the ${localWorktreeMergedCount} worktree${localWorktreeMergedCount === 1 ? '' : 's'} holding one — unless it still has uncommitted or unmerged work, or is in use`
    : 'Deletes merged branches both locally and on the remote';

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <Globe size={16} className="text-gray-400" />
          <h3 className="text-sm font-medium text-gray-400">Remote Branches</h3>
          {remoteBranches.length > 0 && (
            <span className="text-xs text-gray-500">({remoteBranches.length})</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {mergedBranchCount > 0 && !cleanupConfirm && (
            <button
              onClick={() => setCleanupConfirm('remote')}
              disabled={!!cleaningUp}
              title={cleanupTitle}
              className={`flex items-center gap-1 text-xs ${touchBtnCls} text-port-warning hover:text-port-error disabled:opacity-50`}
            >
              <Trash2 size={12} />
              {cleaningUp === true ? 'Cleaning...' : `Clean ${mergedBranchCount} merged`}
            </button>
          )}
          {cleanupConfirm === 'remote' && (
            <div className="flex flex-wrap items-center gap-1">
              <button
                onClick={() => handleCleanupMerged()}
                disabled={!!cleaningUp}
                title={cleanupTitle}
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
          <button
            onClick={onRefresh}
            disabled={loadingRemote}
            className={`text-xs ${touchBtnCls} text-port-accent hover:underline disabled:opacity-50`}
          >
            {loadingRemote ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>
      {loadingRemote && remoteBranches.length === 0 ? (
        <div className="text-center py-4"><BrailleSpinner text="Loading remote branches" /></div>
      ) : (
        <div className="space-y-1.5 max-h-80 overflow-auto">
          {remoteBranches.map((rb) => (
            <RemoteBranchRow key={rb.fullRef} rb={rb} actions={actions} />
          ))}
          {remoteBranchesError && (
            <ListLoadError
              what="remote branches"
              error={remoteBranchesError}
              onRetry={onRefresh}
              retrying={loadingRemote}
            />
          )}
          {!remoteBranchesError && remoteBranches.length === 0 && !loadingRemote && (
            <div className="text-gray-500 text-sm">No remote branches found</div>
          )}
        </div>
      )}
    </div>
  );
}
