import { useState, useMemo } from 'react';
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
  ExternalLink
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

export default function TaskItem({ task, isSystem, awaitingApproval, onRefresh, providers, durations, dragHandleProps }) {
  const [editing, setEditing] = useState(false);
  const [editData, setEditData] = useState({
    description: task.description,
    context: task.metadata?.context || '',
    model: task.metadata?.model || '',
    provider: task.metadata?.provider || ''
  });

  // Get models for selected provider in edit mode
  const editProvider = providers?.find(p => p.id === editData.provider);
  const editModels = editProvider?.models || [];

  // Calculate duration estimate for pending tasks
  const durationEstimate = useMemo(() => {
    if (!durations || task.status !== 'pending') return null;

    const taskType = extractTaskType(task.description);
    const typeData = durations[taskType];
    const overallData = durations._overall;

    if (typeData && typeData.avgDurationMin) {
      return {
        estimatedMin: typeData.avgDurationMin,
        basedOn: typeData.completed,
        taskType,
        successRate: typeData.successRate,
        isTypeSpecific: true
      };
    }

    if (overallData && overallData.avgDurationMin) {
      return {
        estimatedMin: overallData.avgDurationMin,
        basedOn: overallData.completed,
        taskType: 'all tasks',
        successRate: overallData.successRate,
        isTypeSpecific: false
      };
    }

    return null;
  }, [durations, task.description, task.status]);

  const handleStatusChange = async (newStatus) => {
    await api.updateCosTask(task.id, { status: newStatus }).catch(err => toast.error(err.message));
    toast.success(`Task marked as ${newStatus}`);
    onRefresh();
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
          onClick={() => handleStatusChange(task.status === 'completed' ? 'pending' : 'completed')}
          className="mt-0.5 hover:scale-110 transition-transform"
          aria-label={`Status: ${task.status}. Click to mark as ${task.status === 'completed' ? 'pending' : 'completed'}`}
        >
          {statusIcons[task.status]}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-sm font-mono text-gray-500">{task.id}</span>
            {/* Duration estimate for pending tasks */}
            {durationEstimate && (
              <span
                className="flex items-center gap-1 px-1.5 py-0.5 text-xs bg-port-accent/10 text-port-accent/80 rounded"
                title={`Based on ${durationEstimate.basedOn} completed ${durationEstimate.taskType} tasks (${durationEstimate.successRate}% success rate)`}
              >
                <Timer size={10} aria-hidden="true" />
                {formatDurationMin(durationEstimate.estimatedMin)}
              </span>
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
                <select
                  value={editData.model}
                  onChange={e => setEditData(d => ({ ...d, model: e.target.value }))}
                  className="flex-1 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm"
                  disabled={!editData.provider}
                >
                  <option value="">{editData.provider ? 'Auto' : 'Select provider'}</option>
                  {editModels.map(m => (
                    <option key={m} value={m}>{m.replace('claude-', '').replace(/-\d+$/, '')}</option>
                  ))}
                </select>
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
            </>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {!editing && (
            <>
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
    </div>
  );
}
