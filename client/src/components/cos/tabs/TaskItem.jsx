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
  ChevronDown,
  ChevronUp,
  Scale
} from 'lucide-react';
import toast from '../../ui/Toast';
import * as api from '../../../services/api';
import { filterSelectableModels } from '../../../utils/providers';
import { formatDurationMin, formatBytes } from '../../../utils/formatters';
import ConfirmButtonPair from '../../ui/ConfirmButtonPair';
import { useConfirmDelete } from '../../../hooks/useConfirmDelete';
import Modal from '../../ui/Modal';

const statusIcons = {
  pending: <Clock size={16} aria-hidden="true" className="text-yellow-500" />,
  in_progress: <Activity size={16} aria-hidden="true" className="text-port-accent animate-pulse" />,
  completed: <CheckCircle size={16} aria-hidden="true" className="text-port-success" />,
  blocked: <Ban size={16} aria-hidden="true" className="text-port-error" />,
  // A sub-agent disputing a reviewer rejection (#2441) — awaiting resolution.
  challenged: <Scale size={16} aria-hidden="true" className="text-port-warning" />
};

// Extract task type from description for duration lookup (matches AgentCard logic)
function extractTaskType(description) {
  if (!description) return 'general';
  const d = description.toLowerCase();

  // Check for improvement task patterns first
  if (d.includes('[self-improvement]') || d.includes('[improvement]')) {
    if (d.includes('ui bug')) return 'task:ui-bugs';
    if (d.includes('mobile')) return 'task:mobile-responsive';
    if (d.includes('security')) return 'task:security';
    if (d.includes('code quality')) return 'task:code-quality';
    if (d.includes('console error')) return 'task:console-errors';
    if (d.includes('performance')) return 'task:performance';
    if (d.includes('test coverage')) return 'task:test-coverage';
    if (d.includes('documentation')) return 'task:documentation';
    if (d.includes('feature idea') || d.includes('brainstorm')) return 'task:feature-ideas';
    if (d.includes('accessibility')) return 'task:accessibility';
    if (d.includes('error handling')) return 'task:error-handling';
    if (d.includes('typing') || d.includes('typescript')) return 'task:typing';
    if (d.includes('release')) return 'task:release-check';
    if (d.includes('dependency')) return 'task:dependency-updates';
    if (d.includes('jira') && d.includes('report')) return 'task:jira-status-report';
    if (d.includes('jira') || d.includes('sprint')) return 'task:jira-sprint-manager';
    // plan-task matches before do-replan because both descriptions contain
    // "plan.md" — plan-task's "Execute next PLAN.md item" must win over
    // replan's "Audit plan.md" generic match.
    if (d.includes('plan-task') || (d.includes('execute next') && d.includes('plan.md'))) return 'task:plan-task';
    if (d.includes('replan') || d.includes('audit plan.md') || d.includes('plan.md')) return 'task:do-replan';
  }

  // claim-issue carries a "[Claim Issue: <app>]" prefix (not the [improvement]
  // marker), so classify it here before the generic "issue" → bug-fix fallback
  // below would otherwise mislabel it (and skew its historical duration lookup).
  if (d.includes('[claim issue:')) return 'task:claim-issue';

  // General task type classification
  if (d.includes('fix') || d.includes('bug') || d.includes('error') || d.includes('issue')) return 'bug-fix';
  if (d.includes('refactor') || d.includes('clean up') || d.includes('improve') || d.includes('optimize')) return 'refactor';
  if (d.includes('test')) return 'testing';
  if (d.includes('document') || d.includes('readme') || d.includes('docs')) return 'documentation';
  if (d.includes('review') || d.includes('audit')) return 'code-review';
  if (d.includes('mobile') || d.includes('responsive')) return 'mobile-responsive';
  if (d.includes('security') || d.includes('vulnerability')) return 'security';
  if (d.includes('performance') || d.includes('speed')) return 'performance';
  if (d.includes('ui') || d.includes('ux') || d.includes('design') || d.includes('style')) return 'ui-ux';
  if (d.includes('api') || d.includes('endpoint') || d.includes('route')) return 'api';
  if (d.includes('database') || d.includes('migration')) return 'database';
  if (d.includes('deploy') || d.includes('ci') || d.includes('cd')) return 'devops';
  if (d.includes('investigate') || d.includes('debug')) return 'investigation';
  return 'feature';
}

// Get success rate styling based on percentage
function getSuccessRateStyle(rate) {
  if (rate >= 70) return { bg: 'bg-port-success/15', text: 'text-port-success', label: 'high' };
  if (rate >= 40) return { bg: 'bg-port-warning/15', text: 'text-port-warning', label: 'moderate' };
  return { bg: 'bg-port-error/15', text: 'text-port-error', label: 'low' };
}

export default function TaskItem({ task, isSystem, awaitingApproval, onRefresh, providers, durations, dragHandleProps, apps, onEditingChange }) {
  // System and approval-gated tasks are persisted in COS-TASKS.md. Every task
  // mutation must name that source; otherwise the API's user-queue default
  // searches TASKS.md and reports the system task as missing.
  const taskSource = isSystem || awaitingApproval ? 'internal' : 'user';
  const [editing, setEditingInternal] = useState(false);
  const setEditing = useCallback((val) => {
    setEditingInternal(val);
    onEditingChange?.(val);
  }, [onEditingChange]);
  const [editData, setEditData] = useState({
    description: task.description,
    context: task.metadata?.context || '',
    model: task.metadata?.model || '',
    provider: task.metadata?.provider || ''
  });
  const [showBlockedModal, setShowBlockedModal] = useState(false);
  const [blockedReason, setBlockedReason] = useState('');
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();
  const blockedInputRef = useRef(null);

  // Collapse long task prompts to the first couple of lines with an expand
  // toggle. `isOverflowing` is measured against the clamped element so the
  // toggle only appears when the description actually spills past two lines.
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const descRef = useRef(null);

  // Focus input when modal opens
  useEffect(() => {
    if (showBlockedModal && blockedInputRef.current) {
      blockedInputRef.current.focus();
    }
  }, [showBlockedModal]);

  // Measure overflow while the prompt is collapsed. Kept sticky when expanded
  // (removing the clamp collapses scrollHeight, which would otherwise hide the
  // toggle mid-expand); recomputed only on the collapsed path when the text
  // changes so an edit that shortens the prompt clears a stale toggle. A
  // ResizeObserver re-measures on width changes (sidebar collapse, rotation,
  // window resize) so a prompt that wraps to a new line at a narrower width
  // still surfaces the toggle instead of silently clamping with no affordance.
  useEffect(() => {
    if (promptExpanded) return;
    const el = descRef.current;
    if (!el) return;
    const measure = () => setIsOverflowing(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [task.description, promptExpanded, editing]);

  // Get models for selected provider in edit mode
  const editProvider = providers?.find(p => p.id === editData.provider);
  const editModels = filterSelectableModels(editProvider?.models);

  // Calculate duration estimate for pending tasks
  // Uses P80 estimate when available for more realistic time predictions
  const durationEstimate = useMemo(() => {
    if (!durations || task.status !== 'pending') return null;

    const taskType = extractTaskType(task.description);
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
  }, [durations, task.description, task.status]);

  const handleStatusChange = async (newStatus, blockedReasonText = '') => {
    const updates = { status: newStatus, type: taskSource };
    if (newStatus === 'blocked' && blockedReasonText) {
      updates.blockedReason = blockedReasonText;
    }
    const result = await api.updateCosTask(task.id, updates, { silent: true }).catch(err => { toast.error(err.message); return null; });
    if (!result) return;
    toast.success(`Task marked as ${newStatus}`);
    onRefresh();
  };

  const handleMarkBlocked = () => {
    setBlockedReason(task.metadata?.blocker || '');
    setShowBlockedModal(true);
  };

  const handleConfirmBlocked = async () => {
    await handleStatusChange('blocked', blockedReason.trim());
    setShowBlockedModal(false);
    setBlockedReason('');
  };

  const handleSave = async () => {
    const result = await api.updateCosTask(task.id, { ...editData, type: taskSource }, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (!result) return;
    toast.success('Task updated');
    setEditing(false);
    onRefresh();
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
    const result = await api.approveCosTask(task.id, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (!result) return;
    toast.success('Task approved');
    onRefresh();
  };

  return (
    <div className={`bg-port-card border rounded-lg p-4 ${
      awaitingApproval ? 'border-yellow-500/50' : 'border-port-border'
    }`}>
      <div className="flex items-start gap-3">
        {/* Drag handle - only show for user tasks (not system or awaiting approval) */}
        {dragHandleProps && !isSystem && !awaitingApproval && (
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
          aria-label={`Status: ${task.status}. Click to mark as ${task.status === 'completed' || task.status === 'blocked' ? 'pending' : 'completed'}`}
        >
          {statusIcons[task.status]}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-sm font-mono text-gray-500">{task.id}</span>
            {task.metadata?.app && apps?.find(a => a.id === task.metadata.app)?.name && (
              <span className="px-1.5 py-0.5 text-xs bg-port-accent/20 text-port-accent rounded shrink-0" title={task.metadata.app}>
                {apps.find(a => a.id === task.metadata.app).name}
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
            {awaitingApproval && (
              <button
                onClick={handleApprove}
                className="px-2 py-0.5 rounded text-xs bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 transition-colors"
              >
                APPROVE
              </button>
            )}
          </div>

          {editing ? (
            <div className="space-y-2" onPointerDown={e => e.stopPropagation()}>
              <input
                type="text"
                value={editData.description}
                onChange={e => setEditData(d => ({ ...d, description: e.target.value }))}
                className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm"
              />
              <input
                type="text"
                placeholder="Context"
                value={editData.context}
                onChange={e => setEditData(d => ({ ...d, context: e.target.value }))}
                className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm"
              />
              <div className="flex gap-2">
                <select
                  value={editData.provider}
                  onChange={e => setEditData(d => ({ ...d, provider: e.target.value, model: '' }))}
                  className="w-36 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm"
                >
                  <option value="">Auto</option>
                  {providers?.filter(p => p.enabled).map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                {editModels.length > 0 && (
                  <select
                    value={editData.model}
                    onChange={e => setEditData(d => ({ ...d, model: e.target.value }))}
                    className="flex-1 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm"
                  >
                    <option value="">Auto</option>
                    {editModels.map(m => (
                      <option key={m} value={m}>{m.replace('claude-', '').replace(/-\d+$/, '')}</option>
                    ))}
                  </select>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleSave}
                  className="flex items-center gap-1 text-sm px-3 py-2 min-h-[40px] text-port-success hover:text-port-success/80 bg-port-success/10 hover:bg-port-success/20 rounded transition-colors"
                >
                  <Save size={14} aria-hidden="true" /> Save
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="flex items-center gap-1 text-sm px-3 py-2 min-h-[40px] text-gray-400 hover:text-white bg-port-bg hover:bg-port-border rounded transition-colors"
                >
                  <X size={14} aria-hidden="true" /> Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <p
                ref={descRef}
                id={`task-desc-${task.id}`}
                className={`text-white whitespace-pre-wrap break-words ${promptExpanded ? '' : 'line-clamp-2'}`}
              >
                {task.description}
              </p>
              {(isOverflowing || promptExpanded) && (
                <button
                  type="button"
                  onClick={() => setPromptExpanded(v => !v)}
                  className="flex items-center gap-0.5 mt-0.5 text-xs text-port-accent hover:text-port-accent/80 transition-colors"
                  aria-expanded={promptExpanded}
                  aria-controls={`task-desc-${task.id}`}
                >
                  {promptExpanded ? (
                    <><ChevronUp size={12} aria-hidden="true" /> Show less</>
                  ) : (
                    <><ChevronDown size={12} aria-hidden="true" /> Show more</>
                  )}
                </button>
              )}
              {task.metadata?.context && (
                <p className="text-sm text-gray-500 mt-1">{task.metadata.context}</p>
              )}
              {(task.metadata?.model || task.metadata?.provider) && (
                <div className="flex items-center gap-2 mt-1">
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
                  <span className="text-port-error/90">{task.metadata.blocker || task.metadata.blockedReason}</span>
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
                    <span className="font-medium">Challenge{task.metadata.challenge.reviewer ? ` (${task.metadata.challenge.reviewer})` : ''}:</span>{' '}
                    <span className="break-words">{task.metadata.challenge.reason}</span>
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
        <div className="flex items-center gap-1">
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
        onClose={() => setShowBlockedModal(false)}
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
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm mb-4"
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={() => setShowBlockedModal(false)}
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
