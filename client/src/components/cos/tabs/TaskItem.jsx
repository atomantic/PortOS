import { taskCardLabel } from '../cardRecordLabels';
import { useState, useMemo, useRef, useEffect } from 'react';
import { Ban, GripVertical } from 'lucide-react';
import toast from '../../ui/Toast';
import { updateCosTask, deleteCosTask, resolveCosTaskChallenge, approveCosTask } from '../../../services/apiAgents.js';
import useTaskItemEditor from './useTaskItemEditor.js';
import { useConfirmDelete } from '../../../hooks/useConfirmDelete';
import Modal from '../../ui/Modal';
import { estimateCosDuration } from '../../../lib/cosDurationEstimate';
import RelaunchAgentModal from './RelaunchAgentModal';
import AgentCard from './AgentCard';
import TaskItemHeader from './TaskItemHeader.jsx';
import TaskItemInlineEditor from './TaskItemInlineEditor.jsx';
import TaskItemDetails from './TaskItemDetails.jsx';
import TaskItemActions from './TaskItemActions.jsx';
import TaskItemStatusBar, { TaskItemStatusNotices } from './TaskItemStatusBar.jsx';
import { isDeliveryCleanupHeld, isRetryHeld } from '../../../../../server/lib/taskRetryHold.js';

// Why an approval-required task is waiting on the user, keyed by the namespaced
// `metadata.approvalReason` token its producer stamped. Every failure-driven
// investigation producer writes one through the same policy (server:
// agentErrorAnalysis.resolveInvestigationApproval / resolveAutoInvestigationApproval
// — agent failures, AI-provider failures, critical crashes, repeated orphaning),
// so the two tokens below cover all of them. Other producers that hold a task add
// their own entries here rather than a parallel field.
const APPROVAL_REASON_HINTS = {
  'investigation-loop:repeat-fingerprint': 'Held for you: this same failure cause was investigated within the last 24 hours and came back.',
  'investigation-loop:failure-storm': 'Held for you: this hour is nearly out of investigation budget — failures are cascading, not isolated.',
  'config:requireApproval': 'Held for you: this scheduled task type has Require approval turned on.'
};

export const taskRowId = (taskId, source) => `cos-task-${source}-${encodeURIComponent(taskId)}`;

export default function TaskItem({ task, recordLabel = taskCardLabel(task), agent = null, liveOutput, isSystem, spawning = false, waiting = false, unconfirmed = null, retryIdentity, retryIdentityLoading = false, selected = false, onRefresh, onTaskUnblocked, onTaskDeleted, providers, providersLoaded, durations, dragHandleProps, apps, instances = null, onEditingChange }) {
  // System tasks live in the internal queue. Every task mutation must name that
  // source; otherwise the API's user-queue default searches the user queue and
  // reports the system task as missing.
  const taskSource = isSystem ? 'internal' : 'user';
  // A spawning task is still persisted as 'pending' but is already running —
  // show the running glyph, not the queued clock. See spawnAgentForTask's
  // registration ordering for why the two disagree.
  const finalizing = task.status === 'in_progress' && isDeliveryCleanupHeld(task.metadata) && agent?.status !== 'running';
  const retryCleanupActive = task.status === 'in_progress' && isRetryHeld(task.metadata)
    && agent?.taskId === task.id && Boolean(agent.deliveryActivity) && agent.status !== 'running';
  const statusProtected = isDeliveryCleanupHeld(task.metadata) || isRetryHeld(task.metadata) || Boolean(task.metadata?.preflight?.requestId) || Boolean(unconfirmed);
  const protectedReason = unconfirmed ? 'Confirm current activity before changing this task’s status.'
    : task.metadata?.preflight?.requestId ? 'Pre-agent progress is updated by the scheduler.'
      : 'Cleanup must finish or be recovered before this task can be marked complete.';
  const displayStatus = waiting || unconfirmed ? 'pending' : finalizing ? 'finalizing' : spawning ? 'in_progress' : task.status;
  const statusLabel = unconfirmed ? 'activity unconfirmed' : finalizing ? (waiting ? 'cleanup pending' : 'cleanup in progress')
    : retryCleanupActive ? 'retry cleanup in progress' : waiting ? 'waiting' : displayStatus;
  const idScope = isSystem ? 'sys' : 'user';
  // Either queue. A USER row can hold too: a row the importer had to RECOVER is
  // withheld from the unattended spawn and keeps that hold (#7300, #7367). Gating the button on `isSystem` would leave it pending with
  // no way for the human it is waiting on to release it.
  const requiresApproval = Boolean(task.approvalRequired);
  // Name the hold's reason on the APPROVE button so "why is this one waiting on
  // me?" is answerable without opening the body (#3714). Undefined for producers
  // that stamp no reason, which leaves the button's plain label untouched.
  const approvalHint = APPROVAL_REASON_HINTS[task.metadata?.approvalReason] || undefined;
  const {
    editing, setEditing, hasPromptField, canPinInstance, knownInstances, targetInstanceId, targetInstanceName,
    taskModel, taskProvider, taskEffort, editData, setEditData, isConfirmingDiscard,
    handleConfirmDiscard, cancelDiscardConfirm, handleSave, handleCancelEdit,
  } = useTaskItemEditor({ task, taskSource, providers, instances, onEditingChange, onRefresh });
  const [showBlockedModal, setShowBlockedModal] = useState(false);
  const [relaunching, setRelaunching] = useState(false);
  const [blockedReason, setBlockedReason] = useState('');
  const [budgetResetConfirm, setBudgetResetConfirm] = useState(false);
  const [budgetResetAvailable, setBudgetResetAvailable] = useState(false);
  const [budgetResetting, setBudgetResetting] = useState(false);
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();
  const blockedInputRef = useRef(null);

  // Focus input when modal opens
  useEffect(() => {
    if (showBlockedModal && blockedInputRef.current) {
      blockedInputRef.current.focus();
    }
  }, [showBlockedModal]);

  // Calculate duration estimate for pending tasks
  // Uses P80 estimate when available for more realistic time predictions
  const durationEstimate = useMemo(() => {
    if (task.status !== 'pending' || spawning) return null;

    // The shared 4-rung cascade (#8001) — the same module `AgentCard` estimates
    // through, so a pending task and the agent it becomes agree. Queue reads
    // return raw parsed tasks without taskType, so supply the queue source to keep
    // this estimate in the same bucket the server records.
    //
    // A pending task already names the provider/model/effort it will run at, so
    // the estimate can be execution-scoped before the agent ever spawns.
    const estimate = estimateCosDuration({
      durations,
      task: { ...task, taskType: task.taskType || taskSource },
      agentMetadata: { providerId: taskProvider, model: taskModel, effort: taskEffort || null }
    });
    if (!estimate) return null;
    // This card renders whole minutes; the shared estimator answers in ms.
    return { ...estimate, estimatedMin: Math.round(estimate.estimatedMs / 60000) };
  }, [durations, task, taskSource, taskProvider, taskModel, taskEffort, spawning]);

  const handleStatusChange = async (newStatus, blockedReasonText = '', successMessage = `Task marked as ${newStatus}`) => {
    const updates = { status: newStatus, type: taskSource };
    if (newStatus === 'blocked' && blockedReasonText) {
      updates.blockedReason = blockedReasonText;
    }
    const result = await updateCosTask(task.id, updates, { silent: true }).catch(err => { toast.error(err.message); return null; });
    if (!result) return false;
    toast.success(successMessage);
    if (task.status === 'blocked' && newStatus === 'pending') onTaskUnblocked?.(task.id);
    onRefresh();
    return true;
  };

  // Unblocking is the same status write the actionable-insights banner performs,
  // offered here on the card itself so clearing a blocker doesn't require
  // scrolling back to the banner at the top of the page. Gated while in flight so
  // a double-click can't fire two writes.
  const [unblocking, setUnblocking] = useState(false);
  const handleUnblock = async () => {
    setUnblocking(true);
    await handleStatusChange('pending', '', 'Task unblocked and moved to pending');
    setUnblocking(false);
  };

  const handleMarkBlocked = () => {
    // Server-side auto-blocks write `blockedReason`; a manual block writes
    // `blocker` — seed from whichever the task carries, same as the badge below.
    setBlockedReason(task.metadata?.blocker || task.metadata?.blockedReason || '');
    setShowBlockedModal(true);
  };

  // Closing drops the typed reason rather than leaving it in state. handleMarkBlocked
  // re-seeds from the task on every open, so nothing leaks through the UI today —
  // this keeps that true for any future opener that doesn't re-seed.
  const closeBlockedModal = () => {
    setShowBlockedModal(false);
    setBlockedReason('');
  };

  const handleConfirmBlocked = async () => {
    // Keep the modal (and the typed reason) open when the update fails, so a
    // transient API error doesn't discard what the user wrote.
    if (!(await handleStatusChange('blocked', blockedReason.trim()))) return;
    closeBlockedModal();
  };

  // Optimistic: drop the row immediately and reconcile with the server after.
  // On success the server's tasks:changed event refreshes the queue, so no
  // extra full refetch is needed; on failure refetch to restore the row.
  const handleDelete = async () => {
    onTaskDeleted?.(task.id, taskSource);
    const result = await deleteCosTask(task.id, taskSource, { silent: true }).catch(err => { toast.error(err.message); return null; });
    if (!result) {
      onRefresh();
      return;
    }
    toast.success('Task deleted');
  };

  // Resolve a parked challenge inline (#2471). `upheld` overturns the reviewer
  // rejection and re-queues the work (→ pending); `escalated` surfaces the dispute
  // for arbitration (→ blocked + an approval-required task). Gated while a resolve
  // is in flight so a double-click can't fire two verdicts.
  const [resolvingChallenge, setResolvingChallenge] = useState(false);
  const [approving, setApproving] = useState(false);
  const handleResolveChallenge = async (outcome) => {
    setResolvingChallenge(true);
    const result = await resolveCosTaskChallenge(task.id, { outcome, resolvedBy: 'user' }, { silent: true })
      .catch(err => { toast.error(err.message); return null; });
    setResolvingChallenge(false);
    if (!result) return;
    toast.success(outcome === 'upheld' ? 'Challenge upheld — task re-queued' : 'Challenge escalated for arbitration');
    onRefresh();
  };

  const handleApprove = async () => {
    setApproving(true);
    const result = await approveCosTask(task.id, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    setApproving(false);
    if (!result) return;
    toast.success('Task approved');
    onRefresh();
  };

  const showAgent = agent?.status === 'running' && (task.status === 'in_progress' || spawning);
  const TaskDetails = showAgent ? 'details' : 'div';

  return (
    <div
      role="group"
      aria-label={`Task: ${recordLabel}`}
      id={taskRowId(task.id, taskSource)}
      tabIndex={selected ? -1 : undefined}
      aria-current={selected ? 'true' : undefined}
      className={`bg-port-card border rounded-lg p-4 ${
        selected
          ? 'border-port-accent ring-2 ring-port-accent/30'
          : requiresApproval ? 'border-yellow-500/50' : 'border-port-border'
      }`}
    >
      {showAgent && <AgentCard agent={agent} liveOutput={liveOutput} durations={durations}
        onRelaunch={() => setRelaunching(true)} />}
      <TaskDetails className={showAgent ? 'mt-3' : undefined}>
        {showAgent && <summary className="cursor-pointer text-sm text-gray-400">Task details and actions</summary>}
      {/* The icon rail and the task body cannot share a row on a phone: up to
          five 44px targets leave the body ~120px wide, so the task id breaks a
          few characters per line and every badge lands on its own row. The
          rail's `basis-full` under `sm` is what drops it onto its own wrapped
          line, leaving the handle, the status glyph and the body together on the
          first; `sm:basis-auto` + `sm:flex-nowrap` put them back on one row above
          it. Sizing the BODY instead (a `basis-64` that pushes the rail off the
          line) reads the same at 390px but strands the two 16px glyphs alone on
          row 1 once they no longer fit beside it — at 360px and below, and at
          390px on any row that also carries a drag handle. */}
      <div className="flex items-start gap-3 flex-wrap sm:flex-nowrap">
        {/* Drag handle - only show for user tasks. */}
        {dragHandleProps && !isSystem && (
          <button
            {...dragHandleProps}
            className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 mt-0.5 cursor-grab active:cursor-grabbing text-gray-500 hover:text-gray-300 transition-colors touch-none"
            title="Drag to reorder"
            aria-label={`Drag to reorder task ${task.id}`}
          >
            <GripVertical size={16} aria-hidden="true" />
          </button>
        )}
        <TaskItemStatusBar
          task={task}
          displayStatus={displayStatus}
          statusLabel={statusLabel}
          statusProtected={statusProtected}
          protectedReason={protectedReason}
          handleStatusChange={handleStatusChange}
        />
        <div className="flex-1 min-w-0">
          <TaskItemStatusNotices
            task={task} agent={agent} onRefresh={onRefresh} finalizing={finalizing}
            retryCleanupActive={retryCleanupActive} unconfirmed={unconfirmed}
            retryIdentity={retryIdentity} retryIdentityLoading={retryIdentityLoading}
            waiting={waiting} statusProtected={statusProtected} protectedReason={protectedReason}
          />
          <TaskItemHeader
            task={task} apps={apps} targetInstanceId={targetInstanceId} targetInstanceName={targetInstanceName}
            durationEstimate={durationEstimate} isSystem={isSystem} requiresApproval={requiresApproval}
            approving={approving} handleApprove={handleApprove} approvalHint={approvalHint}
          />
          {editing ? (
            <TaskItemInlineEditor
              task={task} idScope={idScope} editData={editData} setEditData={setEditData}
              hasPromptField={hasPromptField} canPinInstance={canPinInstance} knownInstances={knownInstances}
              providers={providers} isConfirmingDiscard={isConfirmingDiscard}
              handleConfirmDiscard={handleConfirmDiscard} cancelDiscardConfirm={cancelDiscardConfirm}
              handleSave={handleSave} handleCancelEdit={handleCancelEdit}
            />
          ) : (
            <TaskItemDetails
              task={task} idScope={idScope} unconfirmed={unconfirmed}
              handleResolveChallenge={handleResolveChallenge} resolvingChallenge={resolvingChallenge}
            />
          )}
        </div>

        {/* Action buttons. Keep the delete confirmation here, next to the trash
            icon, rather than at the bottom of the card — a task with a lot of
            context would otherwise push the confirm row far below the fold. */}
        <TaskItemActions
          task={task} agent={agent} unconfirmed={unconfirmed} editing={editing} onRefresh={onRefresh}
          deleteConfirmation={{
            confirming: !editing && isConfirming(task.id),
            onConfirmDelete: () => confirmDelete(handleDelete),
            onCancelDelete: cancelDelete,
            onRequestDelete: () => requestDelete(task.id),
          }}
          budget={{
            budgetResetAvailable, budgetResetConfirm, budgetResetting,
            setBudgetResetAvailable, setBudgetResetConfirm, setBudgetResetting,
          }}
          onRelaunch={() => setRelaunching(true)} onUnblock={handleUnblock} unblocking={unblocking}
          onMarkBlocked={handleMarkBlocked} onEdit={() => setEditing(true)}
        />
      </div>

      </TaskDetails>

      {relaunching && agent && (
        <RelaunchAgentModal
          agent={agent}
          providers={providers}
          providersLoaded={providersLoaded}
          apps={apps}
          onDone={onRefresh}
          onClose={() => setRelaunching(false)}
        />
      )}

      {/* Blocked Reason Modal */}
      <Modal
        open={showBlockedModal}
        onClose={closeBlockedModal}
        size="sm"
        ariaLabelledBy="blocked-modal-title"
        panelClassName="bg-port-card border border-port-border rounded-lg p-4"
      >
        <h3 id="blocked-modal-title" className="text-white font-medium mb-3 flex items-center gap-2">
          <Ban size={18} className="text-port-error" aria-hidden="true" />
          Mark Task as Blocked
        </h3>
        <p className="text-sm text-gray-400 mb-3">
          What&apos;s blocking this task? This helps track dependencies and unblock work.
        </p>
        <input
          ref={blockedInputRef}
          type="text"
          value={blockedReason}
          onChange={e => setBlockedReason(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') handleConfirmBlocked();
          }}
          placeholder="e.g., Waiting for API access, Needs design review..."
          aria-label="Reason this task is blocked"
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm mb-4"
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={closeBlockedModal}
            className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirmBlocked}
            className="px-3 py-1.5 bg-port-error/20 hover:bg-port-error/30 text-port-error rounded-lg text-sm transition-colors min-h-[40px]"
          >
            Mark Blocked
          </button>
        </div>
      </Modal>
    </div>
  );
}
