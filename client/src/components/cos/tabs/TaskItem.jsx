import { useState, useMemo, useRef, useEffect } from 'react';
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
  TrendingUp
} from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../../services/api';

const statusIcons = {
  pending: <Clock size={16} aria-hidden="true" className="text-yellow-500" />,
  in_progress: <Activity size={16} aria-hidden="true" className="text-port-accent animate-pulse" />,
  completed: <CheckCircle size={16} aria-hidden="true" className="text-port-success" />,
  blocked: <Ban size={16} aria-hidden="true" className="text-port-error" />
};

// Extract task type from description for duration lookup (matches AgentCard logic)
function extractTaskType(description) {
  if (!description) return 'general';
  const d = description.toLowerCase();

  // Check for self-improvement task patterns first
  if (d.includes('[self-improvement]')) {
    if (d.includes('ui bug')) return 'self-improve:ui-bugs';
    if (d.includes('mobile')) return 'self-improve:mobile-responsive';
    if (d.includes('security')) return 'self-improve:security';
    if (d.includes('code quality')) return 'self-improve:code-quality';
    if (d.includes('console error')) return 'self-improve:console-errors';
    if (d.includes('performance')) return 'self-improve:performance';
    if (d.includes('enhance cos') || d.includes('cos capabilities')) return 'self-improve:cos-enhancement';
    if (d.includes('test coverage')) return 'self-improve:test-coverage';
    if (d.includes('documentation')) return 'self-improve:documentation';
    if (d.includes('feature idea') || d.includes('brainstorm')) return 'self-improve:feature-ideas';
    if (d.includes('accessibility')) return 'self-improve:accessibility';
  }

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

// Format duration in minutes
function formatDurationMin(mins) {
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    const remainingMins = mins % 60;
    return remainingMins > 0 ? `~${hours}h ${remainingMins}m` : `~${hours}h`;
  }
  return `~${mins}m`;
}

// Format file size for display
function formatAttachmentSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Get success rate styling based on percentage
function getSuccessRateStyle(rate) {
  if (rate >= 70) return { bg: 'bg-port-success/15', text: 'text-port-success', label: 'high' };
  if (rate >= 40) return { bg: 'bg-port-warning/15', text: 'text-port-warning', label: 'moderate' };
  return { bg: 'bg-port-error/15', text: 'text-port-error', label: 'low' };
}

export default function TaskItem({ task, isSystem, awaitingApproval, onRefresh, providers, durations, dragHandleProps, apps }) {
  const [editing, setEditing] = useState(false);
  const [editData, setEditData] = useState({
    description: task.description,
    context: task.metadata?.context || '',
    model: task.metadata?.model || '',
    provider: task.metadata?.provider || ''
  });
  const [showBlockedModal, setShowBlockedModal] = useState(false);
  const [blockedReason, setBlockedReason] = useState('');
  const blockedInputRef = useRef(null);

  // Focus input when modal opens
  useEffect(() => {
    if (showBlockedModal && blockedInputRef.current) {
      blockedInputRef.current.focus();
    }
  }, [showBlockedModal]);

  // Get models for selected provider in edit mode
  const editProvider = providers?.find(p => p.id === editData.provider);
  const editModels = editProvider?.models || [];

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
    const updates = { status: newStatus };
    if (newStatus === 'blocked' && blockedReasonText) {
      updates.blockedReason = blockedReasonText;
    }
    await api.updateCosTask(task.id, updates).catch(err => toast.error(err.message));
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
    await api.updateCosTask(task.id, editData).catch(err => toast.error(err.message));
    toast.success('Task updated');
    setEditing(false);
    onRefresh();
  };

  const handleDelete = async () => {
    const taskType = isSystem ? 'internal' : 'user';
    await api.deleteCosTask(task.id, taskType).catch(err => toast.error(err.message));
    toast.success('Task deleted');
    onRefresh();
  };

  const handleApprove = async () => {
    await api.approveCosTask(task.id).catch(err => toast.error(err.message));
    toast.success('Task approved');
    onRefresh();
  };

  return (
    <div className={`bg-port-card border rounded-lg p-4 group ${
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
              <span className="px-1.5 py-0.5 text-xs bg-cyan-500/20 text-cyan-400 rounded flex-shrink-0" title={task.metadata.app}>
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
                {formatDurationMin(durationEstimate.estimatedMin)}
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
            <div className="space-y-2">
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
                  className="flex items-center gap-1 text-xs text-port-success hover:text-port-success/80"
                >
                  <Save size={12} aria-hidden="true" /> Save
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="flex items-center gap-1 text-xs text-gray-500 hover:text-white"
                >
                  <X size={12} aria-hidden="true" /> Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="text-white">{task.description}</p>
              {task.metadata?.context && (
                <p className="text-sm text-gray-500 mt-1">{task.metadata.context}</p>
              )}
              {(task.metadata?.model || task.metadata?.provider) && (
                <div className="flex items-center gap-2 mt-1">
                  {task.metadata?.model && (
                    <span className="px-1.5 py-0.5 text-xs bg-purple-500/20 text-purple-400 rounded font-mono">
                      {task.metadata.model}
                    </span>
                  )}
                  {task.metadata?.provider && (
                    <span className="px-1.5 py-0.5 text-xs bg-cyan-500/20 text-cyan-400 rounded">
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
                      title={`${att.originalName || att.filename} (${formatAttachmentSize(att.size)})`}
                    >
                      <FileText size={10} aria-hidden="true" />
                      <span className="truncate max-w-[100px]">{att.originalName || att.filename}</span>
                      <ExternalLink size={10} aria-hidden="true" />
                    </a>
                  ))}
                </div>
              )}
              {/* Blocker reason display */}
              {task.status === 'blocked' && task.metadata?.blocker && (
                <div className="flex items-start gap-2 mt-2 px-2 py-1.5 bg-port-error/10 border border-port-error/20 rounded text-sm">
                  <AlertCircle size={14} className="text-port-error flex-shrink-0 mt-0.5" aria-hidden="true" />
                  <span className="text-port-error/90">{task.metadata.blocker}</span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {!editing && (
            <>
              {/* Mark as Blocked button - only show for non-blocked, non-completed tasks */}
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
                onClick={handleDelete}
                className="p-1 text-gray-500 hover:text-port-error transition-colors"
                title="Delete"
                aria-label="Delete task"
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Blocked Reason Modal */}
      {showBlockedModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowBlockedModal(false)}>
          <div
            className="bg-port-card border border-port-border rounded-lg p-4 w-full max-w-md mx-4"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-labelledby="blocked-modal-title"
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
                if (e.key === 'Escape') setShowBlockedModal(false);
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
          </div>
        </div>
      )}
    </div>
  );
}
