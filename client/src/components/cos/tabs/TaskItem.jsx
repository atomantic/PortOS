import { useState } from 'react';
import {
  Clock,
  Activity,
  CheckCircle,
  Ban,
  Trash2,
  Edit3,
  Save,
  X,
  GripVertical
} from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../../services/api';

const statusIcons = {
  pending: <Clock size={16} className="text-yellow-500" />,
  in_progress: <Activity size={16} className="text-port-accent animate-pulse" />,
  completed: <CheckCircle size={16} className="text-port-success" />,
  blocked: <Ban size={16} className="text-port-error" />
};

export default function TaskItem({ task, isSystem, awaitingApproval, onRefresh, providers, dragHandleProps }) {
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
    await api.deleteCosTask(task.id).catch(err => toast.error(err.message));
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
          title={task.status === 'completed' ? 'Mark as pending' : 'Mark as completed'}
          aria-label={task.status === 'completed' ? 'Mark as pending' : 'Mark as completed'}
        >
          <span aria-hidden="true">{statusIcons[task.status]}</span>
          <span className="sr-only">Status: {task.status}</span>
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-sm font-mono text-gray-500">{task.id}</span>
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
                  <Save size={12} /> Save
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="flex items-center gap-1 text-xs text-gray-500 hover:text-white"
                >
                  <X size={12} /> Cancel
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
