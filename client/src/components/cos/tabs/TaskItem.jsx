import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import {
  Clock,
  Activity,
  CheckCircle,
  Ban,
  Trash2,
  Edit3,
  Save,
  X,
  GripVertical,
  Timer,
  Paperclip,
  FileText,
  ExternalLink,
  AlertCircle,
  TrendingUp,
  Play,
  Scale,
  Unlock,
  Server
} from 'lucide-react';
import toast from '../../ui/Toast';
import AutoSizeTextarea from '../../ui/AutoSizeTextarea';
import * as api from '../../../services/api';
import { effectiveModelFor, effortAwareModelOptions, effortSurvivingModel, seedModelEffort } from '../../../utils/providers';
import { formatDurationMin, formatBytes } from '../../../utils/formatters';
import ConfirmButtonPair from '../../ui/ConfirmButtonPair';
import { useConfirmDelete } from '../../../hooks/useConfirmDelete';
import Modal from '../../ui/Modal';
import CollapsibleText from '../../ui/CollapsibleText';
import { extractCosTaskType } from '../../../lib/cosTaskType';
import InstancePicker from '../InstancePicker';
import EffortSelect from '../EffortSelect';

const statusIcons = {
  pending: <Clock size={16} aria-hidden="true" className="text-yellow-500" />,
  in_progress: <Activity size={16} aria-hidden="true" className="text-port-accent animate-pulse" />,
  completed: <CheckCircle size={16} aria-hidden="true" className="text-port-success" />,
  blocked: <Ban size={16} aria-hidden="true" className="text-port-error" />,
  // A sub-agent disputing a reviewer rejection (#2441) — awaiting resolution.
  challenged: <Scale size={16} aria-hidden="true" className="text-port-warning" />
};

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

const getTaskEditData = (task, providers) => {
  const provider = task.metadata?.provider || '';
  // Tasks saved before Antigravity split model from effort carry a suffixed
  // model id (`gemini-3.6-flash-high`). Seed both controls together so editing
  // any other field cannot silently replace that tier with the provider default.
  const seeded = seedModelEffort(
    providers?.find(candidate => candidate.id === provider) || { id: provider },
    task.metadata?.model,
    task.metadata?.effort,
  );
  return {
    description: task.description,
    prompt: task.metadata?.prompt || '',
    context: task.metadata?.context || '',
    model: seeded.model,
    provider,
    effort: seeded.effort,
    // '' = "Any instance" (#4520) — no pin, the opportunistic default.
    targetInstanceId: task.metadata?.targetInstanceId || ''
  };
};

export const taskRowId = (taskId, source) => `cos-task-${source}-${encodeURIComponent(taskId)}`;

function SecurityScanReport({ scan, idScope, taskId }) {
  const reports = Array.isArray(scan?.reports) ? scan.reports : [];
  if (!reports.length || !['findings', 'unavailable'].includes(scan?.status)) return null;
  const incomplete = scan.status === 'unavailable';

  return (
    <section
      className="mt-2 px-2 py-2 bg-port-error/10 border border-port-error/20 rounded text-sm"
      aria-label="Security scan report"
    >
      <div className="flex items-center gap-2 text-port-error/90">
        <AlertCircle size={14} aria-hidden="true" />
        <span className="font-medium">{incomplete ? 'Security scan report' : 'Security scan findings'}</span>
        <span className="text-xs text-gray-400">read-only report · no PR actions taken</span>
      </div>
      <p className="mt-1 text-xs text-gray-400">
        {incomplete
          ? 'Stage 1 could not complete safely. Any collected report remains human-only and no PR actions have been taken.'
          : 'Stage 1 flagged possible model-abuse content. The flagged diff and report are withheld from the Stage 2 model; no PR actions have been taken.'}
      </p>
      <div className="space-y-2 mt-2">
        {reports.map((report) => {
          const number = String(report?.number ?? 'unknown');
          const url = typeof report?.url === 'string' && /^https?:\/\//i.test(report.url) ? report.url : null;
          return (
            <div key={`${taskId}-security-report-${number}`} className="pl-2 border-l border-port-error/30">
              <div className="flex items-center gap-2 flex-wrap text-xs text-gray-300">
                <span className="font-medium">PR #{number}</span>
                {url && (
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-port-accent hover:text-port-accent/80"
                  >
                    Open PR
                  </a>
                )}
                {report?.passed === true && <span className="text-port-success">clean</span>}
              </div>
              <CollapsibleText
                id={`security-report-${idScope}-${taskId}-${number}`}
                text={typeof report?.findings === 'string' && report.findings ? report.findings : 'No findings.'}
                className="mt-1 text-gray-300 whitespace-pre-wrap"
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}

// Get success rate styling based on percentage
function getSuccessRateStyle(rate) {
  if (rate >= 70) return { bg: 'bg-port-success/15', text: 'text-port-success', label: 'high' };
  if (rate >= 40) return { bg: 'bg-port-warning/15', text: 'text-port-warning', label: 'moderate' };
  return { bg: 'bg-port-error/15', text: 'text-port-error', label: 'low' };
}

export default function TaskItem({ task, isSystem, spawning = false, selected = false, onRefresh, providers, durations, dragHandleProps, apps, instances = null, onEditingChange }) {
  // System tasks are persisted in COS-TASKS.md. Every task
  // mutation must name that source; otherwise the API's user-queue default
  // searches TASKS.md and reports the system task as missing.
  const taskSource = isSystem ? 'internal' : 'user';
  // A spawning task is still persisted as 'pending' but is already running —
  // show the running glyph, not the queued clock. See spawnAgentForTask's
  // registration ordering for why the two disagree.
  const displayStatus = spawning ? 'in_progress' : task.status;
  const idScope = isSystem ? 'sys' : 'user';
  const requiresApproval = isSystem && task.approvalRequired;
  // Name the hold's reason on the APPROVE button so "why is this one waiting on
  // me?" is answerable without opening the body (#3714). Undefined for producers
  // that stamp no reason, which leaves the button's plain label untouched.
  const approvalHint = APPROVAL_REASON_HINTS[task.metadata?.approvalReason] || undefined;
  const [editing, setEditingInternal] = useState(false);
  const setEditing = useCallback((val) => {
    setEditingInternal(val);
    onEditingChange?.(val);
  }, [onEditingChange]);
  // A task written since the #4153 split keeps its full agent-facing payload in
  // `metadata.prompt` and only a short human note in `metadata.context`. Legacy
  // tasks (and peers still on the old code) have no `prompt` at all — their
  // payload is still in `context` — so the Prompt field is offered ONLY when the
  // task actually carries one, and is omitted from the PATCH otherwise rather
  // than writing an empty `prompt` key onto every task the user edits.
  const hasPromptField = typeof task.metadata?.prompt === 'string';
  // `null` means the registry has not been read yet — distinct from a read that
  // found nothing — so a row never flashes "unknown instance" before the list lands,
  // and the editor never offers a picker built from a list it does not have.
  const registryLoaded = instances !== null;
  const knownInstances = instances || [];
  const targetInstanceId = task.metadata?.targetInstanceId || '';
  // Instance pinning (#4520) is only meaningful once this install federates.
  // Below that the picker is hidden AND the field is withheld from the PATCH, so
  // editing a task here can never silently clear a pin another machine set — with
  // one exception: a task that ALREADY carries a pin always gets the picker, or
  // removing the last peer would leave that pin permanently unclearable and the
  // task unrunnable on every instance.
  const canPinInstance = registryLoaded && (knownInstances.length > 1 || Boolean(targetInstanceId));
  // A pin naming an instance that has left the registry still renders — silently
  // dropping the badge would hide exactly the task nothing will ever run.
  const targetInstanceName = targetInstanceId && registryLoaded
    ? (knownInstances.find(i => i.instanceId === targetInstanceId)?.name || 'unknown instance')
    : '';
  const taskPrompt = task.metadata?.prompt || '';
  const taskContext = task.metadata?.context || '';
  const taskModel = task.metadata?.model || '';
  const taskProvider = task.metadata?.provider || '';
  const taskEffort = task.metadata?.effort || '';
  const savedEditData = getTaskEditData(task, providers);
  const [editData, setEditData] = useState(() => savedEditData);
  const [showBlockedModal, setShowBlockedModal] = useState(false);
  const [blockedReason, setBlockedReason] = useState('');
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();
  // Independent armed-state from the delete confirm above — a second instance
  // of the same single-at-a-time hook, keyed on the same task id, gates
  // discarding an in-progress edit (#4037) behind the same inline two-click-arm
  // pattern rather than silently dropping the draft on Cancel.
  const { isConfirming: isConfirmingDiscard, requestDelete: requestDiscardConfirm, cancelDelete: cancelDiscardConfirm, confirmDelete: confirmDiscard } = useConfirmDelete();
  const blockedInputRef = useRef(null);

  // Focus input when modal opens
  useEffect(() => {
    if (showBlockedModal && blockedInputRef.current) {
      blockedInputRef.current.focus();
    }
  }, [showBlockedModal]);

  // Queue refreshes can replace a legacy task with its split form while this
  // component stays mounted under the same task id. Keep the draft current
  // whenever it is safe to do so, but never overwrite an active edit.
  useEffect(() => {
    if (!editing) setEditData(getTaskEditData(task, providers));
  }, [editing, task.id, task.description, taskPrompt, taskContext, taskModel, taskProvider, taskEffort, task, providers]);

  // Get models for selected provider in edit mode
  const editProvider = providers?.find(p => p.id === editData.provider);
  const editModels = effortAwareModelOptions(editProvider, editData.model);

  // Calculate duration estimate for pending tasks
  // Uses P80 estimate when available for more realistic time predictions
  const durationEstimate = useMemo(() => {
    if (!durations || displayStatus !== 'pending') return null;

    // Queue reads return raw parsed tasks without taskType. Supply the queue
    // source so this estimate stays in the same bucket the server records.
    const taskType = extractCosTaskType({ ...task, taskType: task.taskType || taskSource });
    const typeData = durations[taskType];
    const overallData = durations._overall;

    if (typeData && typeData.avgDurationMin) {
      const p80Min = typeData.p80DurationMs ? Math.round(typeData.p80DurationMs / 60000) : typeData.avgDurationMin;
      return {
        estimatedMin: p80Min,
        avgMin: typeData.avgDurationMin,
        basedOn: typeData.completed,
        taskType,
        successRate: typeData.successRate,
        isTypeSpecific: true
      };
    }

    if (overallData && overallData.avgDurationMin) {
      const p80Min = overallData.p80DurationMs ? Math.round(overallData.p80DurationMs / 60000) : overallData.avgDurationMin;
      return {
        estimatedMin: p80Min,
        avgMin: overallData.avgDurationMin,
        basedOn: overallData.completed,
        taskType: 'all tasks',
        successRate: overallData.successRate,
        isTypeSpecific: false
      };
    }

    return null;
  }, [durations, task, displayStatus]);

  const handleStatusChange = async (newStatus, blockedReasonText = '', successMessage = `Task marked as ${newStatus}`) => {
    const updates = { status: newStatus, type: taskSource };
    if (newStatus === 'blocked' && blockedReasonText) {
      updates.blockedReason = blockedReasonText;
    }
    const result = await api.updateCosTask(task.id, updates, { silent: true }).catch(err => { toast.error(err.message); return null; });
    if (!result) return false;
    toast.success(successMessage);
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

  const handleSave = async () => {
    const { prompt, targetInstanceId: draftInstanceId, ...rest } = editData;
    const payload = {
      ...rest,
      type: taskSource,
      ...(hasPromptField ? { prompt } : {}),
      // '' is the picker's "Any instance" → null, the explicit unpin the update
      // schema preserves (absent would leave the pin untouched).
      ...(canPinInstance ? { targetInstanceId: draftInstanceId || null } : {})
    };
    const result = await api.updateCosTask(task.id, payload, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (!result) return;
    toast.success('Task updated');
    setEditing(false);
    onRefresh();
  };

  // Compares the draft against the same task fields editData was seeded from
  // (see the useState initializer above) — true only when the user actually
  // changed something, so an unmodified Cancel still discards with no friction.
  const hasUnsavedEdits =
    editData.description !== savedEditData.description ||
    (hasPromptField && editData.prompt !== savedEditData.prompt) ||
    editData.context !== savedEditData.context ||
    editData.model !== savedEditData.model ||
    editData.provider !== savedEditData.provider ||
    editData.effort !== savedEditData.effort ||
    editData.targetInstanceId !== savedEditData.targetInstanceId;

  const handleCancelEdit = () => {
    if (hasUnsavedEdits) {
      requestDiscardConfirm(task.id);
    } else {
      setEditing(false);
    }
  };

  // Discarding must actually revert the draft, not just hide it — without this,
  // reopening Edit after a confirmed discard would show the just-discarded text
  // again instead of the task's real values.
  const handleConfirmDiscard = () => {
    confirmDiscard(() => {
      setEditData(getTaskEditData(task, providers));
      setEditing(false);
    });
  };

  const handleDelete = async () => {
    const result = await api.deleteCosTask(task.id, taskSource, { silent: true }).catch(err => { toast.error(err.message); return null; });
    if (!result) return;
    toast.success('Task deleted');
    onRefresh();
  };

  // Resolve a parked challenge inline (#2471). `upheld` overturns the reviewer
  // rejection and re-queues the work (→ pending); `escalated` surfaces the dispute
  // for arbitration (→ blocked + an approval-required task). Gated while a resolve
  // is in flight so a double-click can't fire two verdicts.
  const [resolvingChallenge, setResolvingChallenge] = useState(false);
  const [approving, setApproving] = useState(false);
  const handleResolveChallenge = async (outcome) => {
    setResolvingChallenge(true);
    const result = await api.resolveCosTaskChallenge(task.id, { outcome, resolvedBy: 'user' }, { silent: true })
      .catch(err => { toast.error(err.message); return null; });
    setResolvingChallenge(false);
    if (!result) return;
    toast.success(outcome === 'upheld' ? 'Challenge upheld — task re-queued' : 'Challenge escalated for arbitration');
    onRefresh();
  };

  const handleApprove = async () => {
    setApproving(true);
    const result = await api.approveCosTask(task.id, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    setApproving(false);
    if (!result) return;
    toast.success('Task approved');
    onRefresh();
  };

  return (
    <div
      id={taskRowId(task.id, taskSource)}
      tabIndex={selected ? -1 : undefined}
      aria-current={selected ? 'true' : undefined}
      className={`bg-port-card border rounded-lg p-4 ${
        selected
          ? 'border-port-accent ring-2 ring-port-accent/30'
          : requiresApproval ? 'border-yellow-500/50' : 'border-port-border'
      }`}
    >
      <div className="flex items-start gap-3">
        {/* Drag handle - only show for user tasks. */}
        {dragHandleProps && !isSystem && (
          <button
            {...dragHandleProps}
            className="mt-0.5 cursor-grab active:cursor-grabbing text-gray-500 hover:text-gray-300 transition-colors touch-none"
            title="Drag to reorder"
            aria-label="Drag to reorder"
          >
            <GripVertical size={16} aria-hidden="true" />
          </button>
        )}
        <button
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
          aria-label={`Status: ${displayStatus}. Click to mark as ${task.status === 'completed' || task.status === 'blocked' ? 'pending' : 'completed'}`}
        >
          {statusIcons[displayStatus]}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-sm font-mono text-gray-500">{task.id}</span>
            {task.metadata?.app && apps?.find(a => a.id === task.metadata.app)?.name && (
              <span className="px-1.5 py-0.5 text-xs bg-port-accent/20 text-port-accent rounded shrink-0" title={task.metadata.app}>
                {apps.find(a => a.id === task.metadata.app).name}
              </span>
            )}
            {targetInstanceName && (
              <span
                className="flex items-center gap-1 px-1.5 py-0.5 text-xs bg-port-accent-2/20 text-port-accent-2 rounded shrink-0"
                title={`Pinned to instance ${targetInstanceId} — only that instance runs this task`}
              >
                <Server size={10} aria-hidden="true" />
                {targetInstanceName}
              </span>
            )}
            {/* Duration estimate for pending tasks */}
            {durationEstimate && (
              <span
                className="flex items-center gap-1 px-1.5 py-0.5 text-xs bg-port-accent/10 text-port-accent/80 rounded"
                title={`Based on ${durationEstimate.basedOn} completed ${durationEstimate.taskType} tasks`}
              >
                <Timer size={10} aria-hidden="true" />
                {formatDurationMin(durationEstimate.estimatedMin, { approximate: true })}
              </span>
            )}
            {/* Success rate indicator for pending tasks */}
            {durationEstimate && durationEstimate.successRate !== undefined && durationEstimate.isTypeSpecific && (
              (() => {
                const style = getSuccessRateStyle(durationEstimate.successRate);
                return (
                  <span
                    className={`flex items-center gap-1 px-1.5 py-0.5 text-xs rounded ${style.bg} ${style.text}`}
                    title={`${style.label} success rate: ${durationEstimate.successRate}% of ${durationEstimate.basedOn} similar tasks succeeded`}
                  >
                    <TrendingUp size={10} aria-hidden="true" />
                    {durationEstimate.successRate}%
                  </span>
                );
              })()
            )}
            {isSystem && task.autoApproved && (
              <span className="px-2 py-0.5 rounded text-xs bg-port-success/20 text-port-success">AUTO</span>
            )}
            {requiresApproval && (
              <button
                onClick={handleApprove}
                disabled={approving}
                className="px-2 py-0.5 rounded text-xs bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 transition-colors disabled:opacity-50"
                title={approvalHint}
                aria-label={approvalHint ? `Approve task ${task.id} — ${approvalHint}` : `Approve task ${task.id}`}
              >
                {approving ? 'APPROVING…' : 'APPROVE'}
              </button>
            )}
          </div>

          {editing ? (
            <div className="space-y-2" onPointerDown={e => e.stopPropagation()}>
              <AutoSizeTextarea
                value={editData.description}
                aria-label="Task description"
                onChange={e => setEditData(d => ({ ...d, description: e.target.value }))}
                className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm min-h-[34px]"
              />
              {/* A textarea, not an input: for orchestrator tasks this holds the
                  task's entire multi-line prompt, which is unreadable and
                  unnavigable in a single-line field. Bounded rows + its own
                  scroll so editing a long prompt doesn't stretch the card. */}
              {hasPromptField && (
                <textarea
                  rows={4}
                  placeholder="Prompt"
                  aria-label="Task prompt"
                  value={editData.prompt}
                  onChange={e => setEditData(d => ({ ...d, prompt: e.target.value }))}
                  className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm font-mono resize-y overflow-auto"
                />
              )}
              <textarea
                rows={4}
                placeholder="Context"
                aria-label="Task context"
                value={editData.context}
                onChange={e => setEditData(d => ({ ...d, context: e.target.value }))}
                className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm font-mono resize-y overflow-auto"
              />
              <div className="flex flex-col sm:flex-row gap-2">
                <select
                  aria-label="Provider"
                  value={editData.provider}
                  onChange={e => setEditData(d => ({ ...d, provider: e.target.value, model: '', effort: '' }))}
                  className="w-full sm:w-36 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm"
                >
                  <option value="">Auto</option>
                  {providers?.filter(p => p.enabled !== false || p.id === editData.provider).map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                {editModels.length > 0 && (
                  <select
                    aria-label="Model"
                    value={editData.model}
                    onChange={e => setEditData(d => ({
                      ...d,
                      model: e.target.value,
                      effort: effortSurvivingModel(editProvider, e.target.value, d.effort)
                    }))}
                    className="flex-1 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm"
                  >
                    <option value="">Auto</option>
                    {editModels.map(m => (
                      <option key={m} value={m}>{m.replace('claude-', '').replace(/-\d+$/, '')}</option>
                    ))}
                  </select>
                )}
                <EffortSelect
                  provider={editProvider}
                  model={effectiveModelFor(editProvider, editData.model)}
                  value={editData.effort}
                  onChange={effort => setEditData(d => ({ ...d, effort }))}
                  className="w-full sm:w-36 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm"
                />
              </div>
              {canPinInstance && (
                <InstancePicker
                  id={`task-target-instance-${idScope}-${task.id}`}
                  value={editData.targetInstanceId}
                  onChange={(next) => setEditData(d => ({ ...d, targetInstanceId: next }))}
                  instances={knownInstances}
                />
              )}
              {isConfirmingDiscard(task.id) ? (
                <ConfirmButtonPair
                  prompt="Discard unsaved changes?"
                  confirmText="Discard"
                  ariaLabel="Confirm discard task edits"
                  tone="warning"
                  onConfirm={handleConfirmDiscard}
                  onCancel={cancelDiscardConfirm}
                />
              ) : (
                <div className="flex gap-2">
                  <button
                    onClick={handleSave}
                    className="flex items-center gap-1 text-sm px-3 py-2 min-h-[40px] text-port-success hover:text-port-success/80 bg-port-success/10 hover:bg-port-success/20 rounded transition-colors"
                  >
                    <Save size={14} aria-hidden="true" /> Save
                  </button>
                  <button
                    onClick={handleCancelEdit}
                    className="flex items-center gap-1 text-sm px-3 py-2 min-h-[40px] text-gray-400 hover:text-white bg-port-bg hover:bg-port-border rounded transition-colors"
                  >
                    <X size={14} aria-hidden="true" /> Cancel
                  </button>
                </div>
              )}
            </div>
          ) : (
            <>
              <CollapsibleText
                id={`task-desc-${idScope}-${task.id}`}
                text={task.description}
                className="text-white"
              />
              {/* The prompt runs to hundreds of lines for orchestrator tasks, so
                  it gets the same clamp as the description — an unclamped one
                  turns the pending list into a wall of text the user has to
                  scroll past. The note below it gets the same treatment, since a
                  legacy task still carries its payload there. */}
              {task.metadata?.prompt && (
                <CollapsibleText
                  id={`task-prompt-${idScope}-${task.id}`}
                  text={task.metadata.prompt}
                  className="text-sm text-gray-500 mt-1"
                />
              )}
              {task.metadata?.context && (
                <CollapsibleText
                  id={`task-context-${idScope}-${task.id}`}
                  text={task.metadata.context}
                  className="text-sm text-gray-500 mt-1"
                />
              )}
              <SecurityScanReport
                scan={task.metadata?.pipeline?.securityScan}
                idScope={idScope}
                taskId={task.id}
              />
              {(task.metadata?.model || task.metadata?.provider || task.metadata?.effort) && (
                <div className="flex flex-wrap items-center gap-2 mt-1">
                  {task.metadata?.model && (
                    <span className="px-1.5 py-0.5 text-xs bg-port-accent-2/20 text-port-accent-2 rounded font-mono">
                      {task.metadata.model}
                    </span>
                  )}
                  {task.metadata?.provider && (
                    <span className="px-1.5 py-0.5 text-xs bg-port-accent/20 text-port-accent rounded">
                      {task.metadata.provider}
                    </span>
                  )}
                  {task.metadata?.effort && (
                    <span className="px-1.5 py-0.5 text-xs bg-port-warning/20 text-port-warning rounded">
                      {task.metadata.effort} effort
                    </span>
                  )}
                </div>
              )}
              {/* Attachments display */}
              {task.metadata?.attachments?.length > 0 && (
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <Paperclip size={12} className="text-gray-500" aria-hidden="true" />
                  {task.metadata.attachments.map((att, idx) => (
                    <a
                      key={idx}
                      href={`/api/attachments/${encodeURIComponent(att.filename)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 px-2 py-0.5 text-xs bg-port-accent/10 text-port-accent hover:bg-port-accent/20 rounded transition-colors"
                      title={`${att.originalName || att.filename}${att.size ? ` (${formatBytes(att.size)})` : ''}`}
                    >
                      <FileText size={10} aria-hidden="true" />
                      <span className="truncate max-w-[100px]">{att.originalName || att.filename}</span>
                      <ExternalLink size={10} aria-hidden="true" />
                    </a>
                  ))}
                </div>
              )}
              {/* Blocker reason display. Prefer the user-set `blocker`, but fall
                  back to `blockedReason` — the field every server-side block
                  writes (max-spawns, retries, provider-config, terminated, …), so
                  without this fallback an auto-blocked task shows no reason at all. */}
              {task.status === 'blocked' && (task.metadata?.blocker || task.metadata?.blockedReason) && (
                <div className="flex items-start gap-2 mt-2 px-2 py-1.5 bg-port-error/10 border border-port-error/20 rounded text-sm">
                  <AlertCircle size={14} className="text-port-error shrink-0 mt-0.5" aria-hidden="true" />
                  {/* Clamped: server-side auto-blocks write `blockedReason` from
                      LLM error analysis / raw stderr, which can run very long. */}
                  <div className="min-w-0 flex-1">
                    <CollapsibleText
                      id={`task-blocker-${idScope}-${task.id}`}
                      text={task.metadata.blocker || task.metadata.blockedReason}
                      className="text-port-error/90"
                    />
                  </div>
                </div>
              )}
              {/* Challenge case + resolution (#2441). Both sides of a disputed
                  rejection are logged on the task metadata so the outcome is
                  auditable here: the worker's case while parked in `challenged`,
                  and the resolver's verdict once it settles. */}
              {task.metadata?.challenge?.reason && (
                <div className="flex items-start gap-2 mt-2 px-2 py-1.5 bg-port-warning/10 border border-port-warning/20 rounded text-sm">
                  <Scale size={14} className="text-port-warning shrink-0 mt-0.5" aria-hidden="true" />
                  <div className="text-port-warning/90 min-w-0">
                    <span className="font-medium">Challenge{task.metadata.challenge.reviewer ? ` (${task.metadata.challenge.reviewer})` : ''}:</span>
                    {/* Clamped: the reason is free text a worker agent writes to
                        argue its case, so multi-paragraph is the expected shape. */}
                    <CollapsibleText
                      id={`task-challenge-${idScope}-${task.id}`}
                      text={task.metadata.challenge.reason}
                    />
                    {task.metadata.challengeResolution?.outcome && (
                      <div className="mt-1 text-gray-400">
                        Resolved: {task.metadata.challengeResolution.outcome}
                        {task.metadata.challengeResolution.note ? ` — ${task.metadata.challengeResolution.note}` : ''}
                      </div>
                    )}
                    {/* Inline resolve controls while parked in `challenged` and not
                        yet settled (#2471) — Uphold overturns the rejection and
                        re-queues the work, Escalate surfaces it for arbitration. */}
                    {task.status === 'challenged' && !task.metadata.challengeResolution?.outcome && (
                      <div className="flex items-center gap-2 mt-2">
                        <button
                          type="button"
                          onClick={() => handleResolveChallenge('upheld')}
                          disabled={resolvingChallenge}
                          className="flex items-center gap-1 px-2.5 py-1 min-h-[32px] text-xs text-port-success bg-port-success/10 hover:bg-port-success/20 rounded transition-colors disabled:opacity-50"
                          title="Overturn the rejection and re-queue this task"
                        >
                          <CheckCircle size={12} aria-hidden="true" /> Uphold
                        </button>
                        <button
                          type="button"
                          onClick={() => handleResolveChallenge('escalated')}
                          disabled={resolvingChallenge}
                          className="flex items-center gap-1 px-2.5 py-1 min-h-[32px] text-xs text-port-error bg-port-error/10 hover:bg-port-error/20 rounded transition-colors disabled:opacity-50"
                          title="Let the rejection stand and file an arbitration task"
                        >
                          <Ban size={12} aria-hidden="true" /> Escalate
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Action buttons. Keep the delete confirmation here, next to the trash
            icon, rather than at the bottom of the card — a task with a lot of
            context would otherwise push the confirm row far below the fold. */}
        <div className="flex items-center gap-1 shrink-0">
          {!editing && (
            isConfirming(task.id) ? (
              <ConfirmButtonPair
                prompt="Delete?"
                confirmText="Delete"
                ariaLabel="Confirm delete task"
                onConfirm={() => confirmDelete(handleDelete)}
                onCancel={cancelDelete}
              />
            ) : (
              <>
                {/* Deliberately gated on the PERSISTED status, not `displayStatus`:
                    an agent record stuck at `running` (the zombie state
                    cleanupZombieAgents exists to clear) would otherwise take this
                    row's only recovery affordance away with it. forceSpawnTask
                    refuses a task a live agent already holds, so a click during a
                    real spawn gets an honest error rather than a duplicate run. */}
                {task.status === 'pending' && !task.approvalRequired && (
                  <button
                    onClick={async () => {
                      const result = await api.forceSpawnTask(task.id, { silent: true }).catch(err => { toast.error(err.message); return null; });
                      if (result?.success) toast.success(`Spawning ${task.id}`);
                      if (onRefresh) onRefresh();
                    }}
                    className="p-1 text-gray-500 hover:text-port-success transition-colors"
                    title="Process now"
                    aria-label="Process task now"
                  >
                    <Play size={14} aria-hidden="true" />
                  </button>
                )}
                {/* Labeled, not icon-only: this is the primary next action for a
                    blocked task, and the icon-only affordance (clicking the status
                    glyph) wasn't discoverable — the user had to go find the banner
                    at the top of the page instead. */}
                {task.status === 'blocked' && (
                  <button
                    type="button"
                    onClick={handleUnblock}
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
                    onClick={handleMarkBlocked}
                    className="p-1 text-gray-500 hover:text-port-error transition-colors"
                    title="Mark as blocked"
                    aria-label="Mark task as blocked"
                  >
                    <Ban size={14} aria-hidden="true" />
                  </button>
                )}
                <button
                  onClick={() => setEditing(true)}
                  className="p-1 text-gray-500 hover:text-white transition-colors"
                  title="Edit"
                  aria-label="Edit task"
                >
                  <Edit3 size={14} aria-hidden="true" />
                </button>
                <button
                  onClick={() => requestDelete(task.id)}
                  className="p-1 text-gray-500 hover:text-port-error transition-colors"
                  title="Delete"
                  aria-label="Delete task"
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </>
            )
          )}
        </div>
      </div>

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
