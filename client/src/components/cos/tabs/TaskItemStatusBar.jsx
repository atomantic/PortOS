import { Activity, Ban, CheckCircle, Clock, Scale } from 'lucide-react';
import DeliveryStatus from '../DeliveryStatus';
import { isRetryHeld } from '../../../../../server/lib/taskRetryHold.js';

const statusIcons = {
  pending: <Clock size={16} aria-hidden="true" className="text-yellow-500" />,
  in_progress: <Activity size={16} aria-hidden="true" className="text-port-accent animate-pulse" />,
  finalizing: <Clock size={16} aria-hidden="true" className="text-gray-400" />,
  completed: <CheckCircle size={16} aria-hidden="true" className="text-port-success" />,
  blocked: <Ban size={16} aria-hidden="true" className="text-port-error" />,
  // A sub-agent disputing a reviewer rejection (#2441) — awaiting resolution.
  challenged: <Scale size={16} aria-hidden="true" className="text-port-warning" />
};

export default function TaskItemStatusBar({ task, displayStatus, statusLabel, statusProtected, protectedReason, handleStatusChange }) {
  return (
    <button
      disabled={statusProtected}
      onClick={() => {
        if (task.status === 'blocked') {
          // Clicking blocked status clears it back to pending
          handleStatusChange('pending');
        } else if (task.status === 'completed') {
          handleStatusChange('pending');
        } else {
          handleStatusChange('completed');
        }
      }}
      className="mt-0.5 hover:scale-110 transition-transform"
      aria-label={`Status: ${statusLabel}. ${statusProtected ? protectedReason : `Click to mark as ${task.status === 'completed' || task.status === 'blocked' ? 'pending' : 'completed'}`}`}
    >
      {statusIcons[displayStatus]}
    </button>
  );
}

export function TaskItemStatusNotices({ task, agent, onRefresh, finalizing, retryCleanupActive, unconfirmed, retryIdentity, retryIdentityLoading, waiting, statusProtected, protectedReason }) {
  return (
    <>
      {finalizing && !unconfirmed && <DeliveryStatus agent={agent} ownerId={task.metadata.deliveryRecoveryAgentId} taskId={task.id} onRefresh={onRefresh} />}
      {retryCleanupActive && !finalizing && <p className="mb-2 text-sm text-port-text-muted">{agent.deliveryActivity.label}</p>}
      {unconfirmed && <p className="mb-2 text-sm text-port-text-muted">{unconfirmed}</p>}
      {retryIdentity && <button type="button" onClick={retryIdentity} disabled={retryIdentityLoading}
        className="mb-2 min-h-[44px] rounded border border-port-border px-2 text-sm text-port-accent disabled:opacity-50">
        {retryIdentityLoading ? 'Checking instance identity…' : 'Retry instance identity'}
      </button>}
      {waiting && !finalizing && !task.metadata?.preflight && <p className="mb-2 text-sm text-port-text-muted">
        {isRetryHeld(task.metadata) ? 'Waiting for the previous run’s cleanup before retrying.' : 'Waiting for an agent or recovery; active execution is not confirmed.'}
      </p>}
      {statusProtected && <p className="mb-2 text-sm text-port-text-muted">{protectedReason}</p>}
    </>
  );
}
