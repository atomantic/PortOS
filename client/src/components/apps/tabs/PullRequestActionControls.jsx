import { FileSearch, GitMerge, ScanSearch } from 'lucide-react';
import ConfirmButtonPair from '../../ui/ConfirmButtonPair';
import RunActionButton from './RunActionButton';
import { PULL_REQUEST_ACTION_LABELS } from '../../../../../lib/pullRequestActions.js';

// The direct merge's methods, in the order the forges list them.
export const MERGE_METHOD_LABELS = { merge: 'Merge commit', squash: 'Squash', rebase: 'Rebase' };
export const DEFAULT_MERGE_METHOD = 'merge';
export const ACTION_STATUS_LABEL = {
  queued: 'Queued — view', active: 'Active — view', completed: 'Completed — view', blocked: 'Blocked — view', failed: 'Failed — view',
};
export const actionStatusForTask = status => ({ pending: 'queued', in_progress: 'active', completed: 'completed', blocked: 'blocked', failed: 'failed' }[status] || null);

export function MergeOptions({ idPrefix, subject, method, onMethodChange, deleteBranch, onDeleteBranchChange, disabled = false }) {
  return <>
      <label htmlFor={`${idPrefix}-method-${subject}`} className="sr-only">
        Merge method for {subject}
      </label>
      <select
        id={`${idPrefix}-method-${subject}`}
        disabled={disabled}
        value={method}
        onChange={event => onMethodChange(event.target.value)}
        className="px-2 py-1 bg-port-card border border-port-border rounded-lg text-white text-xs focus:border-port-accent focus:outline-hidden"
      >
        {Object.entries(MERGE_METHOD_LABELS).map(([value, methodLabel]) => (
          <option key={value} value={value}>{methodLabel}</option>
        ))}
      </select>
      <input
        id={`${idPrefix}-delete-${subject}`}
        type="checkbox"
        disabled={disabled}
        checked={deleteBranch}
        onChange={event => onDeleteBranchChange(event.target.checked)}
      />
      <label htmlFor={`${idPrefix}-delete-${subject}`} className="text-xs text-gray-400">
        Delete branch
      </label>
  </>;
}

/**
 * The one row action that runs no agent. Armed into an inline confirm rather
 * than merging on the first click: the forge merge is irreversible, and the
 * method and branch deletion are choices the user should see before it happens.
 */
export function MergeAction({
  pullRequest, idPrefix, title, armed, merging, method, onMethodChange,
  deleteBranch, onDeleteBranchChange, onArm, onCancel, onConfirm, disabled = false,
}) {
  if (!armed) {
    return (
      <button
        type="button"
        onClick={onArm}
        disabled={disabled}
        title={title}
        className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-white border border-port-border rounded-lg text-xs flex items-center gap-1.5 whitespace-nowrap transition-colors"
      >
        <GitMerge size={14} /> Merge
      </button>
    );
  }
  return (
    <fieldset disabled={disabled || merging} className="flex min-w-0 flex-wrap items-center gap-2 px-2 py-1.5 bg-port-bg border border-port-border rounded-lg">
      <MergeOptions idPrefix={idPrefix} subject={`#${pullRequest.number}`} method={method} onMethodChange={onMethodChange}
        deleteBranch={deleteBranch} onDeleteBranchChange={onDeleteBranchChange} disabled={disabled || merging} />
      <ConfirmButtonPair
        tone="success"
        confirmText={`Merge #${pullRequest.number}`}
        confirmIcon={GitMerge}
        busy={merging}
        busyText="Merging…"
        ariaLabel={`Confirm merging #${pullRequest.number}`}
        onConfirm={() => { if (!disabled && !merging) onConfirm(); }}
        onCancel={onCancel}
      />
    </fieldset>
  );
}


const REVIEW_ICONS = { 'do-review': FileSearch, 'untrusted-review': ScanSearch };

export function PullRequestReviewButton({ action, ...props }) {
  return (
    <RunActionButton
      {...props}
      icon={REVIEW_ICONS[action]}
      className="px-3 py-1.5 bg-port-accent/20 text-port-accent enabled:hover:bg-port-accent/30 border border-port-border rounded-lg text-xs whitespace-nowrap"
    >
      {PULL_REQUEST_ACTION_LABELS[action]}
    </RunActionButton>
  );
}
