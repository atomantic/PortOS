import { Ban, Edit3, Play, RefreshCw, Trash2, Unlock } from 'lucide-react';
import ConfirmButtonPair from '../../ui/ConfirmButtonPair';
import toast from '../../ui/Toast';
import { forceSpawnTask, resetSpawnBudgetAndRun } from '../../../services/apiAgents.js';
import { isDeliveryCleanupHeld, isRetryHeld } from '../../../../../server/lib/taskRetryHold.js';
import { MAX_SPAWNS_BLOCKED_CATEGORY, hasSpawnBudgetResetPrerequisite } from '../../../../../server/lib/taskBlockCategories.js';

export default function TaskItemActions({ task, agent, unconfirmed, editing, deleteConfirmation, budget, onRefresh, onRelaunch, onUnblock, unblocking, onMarkBlocked, onEdit }) {
  const { confirming, onConfirmDelete, onCancelDelete, onRequestDelete } = deleteConfirmation;
  const { budgetResetAvailable, budgetResetConfirm, budgetResetting, setBudgetResetAvailable, setBudgetResetConfirm, setBudgetResetting } = budget;
  return (
    <div className="flex flex-wrap items-center justify-end gap-1 sm:gap-2 shrink-0 ml-auto basis-full sm:basis-auto">
      {!editing && (
        confirming ? (
          <ConfirmButtonPair
            prompt="Delete?"
            confirmText="Delete"
            ariaLabel="Confirm delete task"
            onConfirm={onConfirmDelete}
            onCancel={onCancelDelete}
          />
        ) : (
          <>
            {/* Deliberately gated on the PERSISTED status, not `displayStatus`:
                an agent record stuck at `running` (the dead-process state
                the orphan sweep exists to clear) would otherwise take this
                row's only recovery affordance away with it. forceSpawnTask
                refuses a task a live agent already holds, so a click during a
                real spawn gets an honest error rather than a duplicate run. */}
            {task.status === 'pending' && !task.approvalRequired && !task.metadata?.preflight?.requestId && (
              <button
                onClick={async () => {
                  const result = await forceSpawnTask(task.id, { silent: true }).catch(err => {
                    if (err.code === 'SPAWN_BUDGET_EXHAUSTED') setBudgetResetAvailable(true);
                    toast.error(err.message); return null;
                  });
                  if (result?.success) toast.success(`Spawning ${task.id}`);
                  if (onRefresh) onRefresh();
                }}
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-port-success transition-colors"
                title="Process now"
                aria-label="Process task now"
              >
                <Play size={14} aria-hidden="true" />
              </button>
            )}
            {(task.status === 'pending' || task.status === 'blocked' || (task.status === 'in_progress' && agent?.status !== 'running')) && !task.approvalRequired
              && !unconfirmed
              && !task.metadata?.preflight?.requestId
              && !hasSpawnBudgetResetPrerequisite(task.metadata) && !isDeliveryCleanupHeld(task.metadata) && !isRetryHeld(task.metadata)
              && (task.status === 'in_progress' || task.metadata?.blockedCategory === MAX_SPAWNS_BLOCKED_CATEGORY || budgetResetAvailable)
              && (budgetResetConfirm ? (
                <ConfirmButtonPair prompt="Reset spawn count to zero and run? Failure count stays." confirmText="Reset and run"
                  ariaLabel="Confirm reset spawn budget and run" busy={budgetResetting} tone="warning" largeTouchTargets
                  onCancel={() => setBudgetResetConfirm(false)} onConfirm={async () => {
                    setBudgetResetting(true);
                    const result = await resetSpawnBudgetAndRun(task.id, { silent: true }).catch(err => { toast.error(err.message); return null; });
                    setBudgetResetting(false);
                    if (result?.success) { setBudgetResetConfirm(false); setBudgetResetAvailable(false); toast.success(`Spawning ${task.id}`); }
                    if (onRefresh) onRefresh();
                  }} />
              ) : (
                <button type="button" onClick={() => setBudgetResetConfirm(true)}
                  className="min-h-[44px] rounded border border-port-border px-2 text-xs text-port-warning hover:bg-port-border">
                  Reset spawn budget and run
                </button>
              ))}
            {/* Only when a live agent holds this task — relaunching pauses that
                agent (see relaunchAgent in agentManagement.js). */}
            {agent?.status === 'running' && (
              <button
                type="button"
                onClick={onRelaunch}
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-port-accent transition-colors"
                title="Relaunch on a different provider or model"
                aria-label={`Relaunch task ${task.id} on a different provider or model`}
              >
                <RefreshCw size={14} aria-hidden="true" />
              </button>
            )}
            {/* Labeled, not icon-only: this is the primary next action for a
                blocked task, and the icon-only affordance (clicking the status
                glyph) wasn't discoverable — the user had to go find the banner
                at the top of the page instead. */}
            {task.status === 'blocked' && (
              <button
                type="button"
                onClick={onUnblock}
                disabled={unblocking}
                className="flex items-center gap-1 px-2 py-1 min-h-[32px] text-xs font-medium text-port-success bg-port-success/10 hover:bg-port-success/20 rounded transition-colors disabled:opacity-50"
                title="Unblock and move to pending"
                aria-label={`Unblock task ${task.id} and move it to pending`}
              >
                <Unlock size={12} aria-hidden="true" />
                {unblocking ? 'Unblocking…' : 'Unblock'}
              </button>
            )}
            {task.status !== 'blocked' && task.status !== 'completed' && (
              <button
                onClick={onMarkBlocked}
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-port-error transition-colors"
                title="Mark as blocked"
                aria-label="Mark task as blocked"
              >
                <Ban size={14} aria-hidden="true" />
              </button>
            )}
            <button
              onClick={onEdit}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-white transition-colors"
              title="Edit"
              aria-label="Edit task"
            >
              <Edit3 size={14} aria-hidden="true" />
            </button>
            <button
              onClick={onRequestDelete}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-port-error transition-colors"
              title="Delete"
              aria-label="Delete task"
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </>
        )
      )}
    </div>
  );
}
