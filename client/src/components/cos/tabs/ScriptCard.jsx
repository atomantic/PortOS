import { useState } from 'react';
import {
  Terminal,
  Play,
  Edit3,
  CheckCircle,
  Ban,
  Trash2,
  Save,
  Zap
} from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../../services/api';

const scheduleLabels = {
  'on-demand': 'On Demand',
  'every-5-min': 'Every 5 min',
  'every-15-min': 'Every 15 min',
  'every-30-min': 'Every 30 min',
  'hourly': 'Hourly',
  'every-6-hours': 'Every 6 hours',
  'daily': 'Daily',
  'weekly': 'Weekly'
};

export default function ScriptCard({ script, onRun, onToggle, onDelete, onUpdate }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editData, setEditData] = useState({
    name: script.name,
    description: script.description || '',
    command: script.command,
    schedule: script.schedule || 'on-demand',
    triggerAction: script.triggerAction || 'log-only',
    triggerPrompt: script.triggerPrompt || '',
    triggerPriority: script.triggerPriority || 'MEDIUM'
  });

  const handleSave = async () => {
    if (!editData.name.trim() || !editData.command.trim()) {
      toast.error('Name and command are required');
      return;
    }
    await api.updateCosScript(script.id, editData).catch(err => toast.error(err.message));
    toast.success('Script updated');
    setEditing(false);
    onUpdate?.();
  };

  const formatTime = (timestamp) => {
    if (!timestamp) return 'Never';
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return date.toLocaleDateString();
  };

  return (
    <div className={`bg-port-card border rounded-lg overflow-hidden ${
      script.enabled ? 'border-port-border' : 'border-port-border opacity-60'
    }`}>
      <div className="p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Terminal size={16} className={script.enabled ? 'text-port-accent' : 'text-gray-500'} />
            <span className="font-medium text-white">{script.name}</span>
            <span className={`px-2 py-0.5 text-xs rounded ${
              script.schedule === 'on-demand' ? 'bg-gray-500/20 text-gray-400' : 'bg-port-accent/20 text-port-accent'
            }`}>
              {scheduleLabels[script.schedule] || script.schedule}
            </span>
            {script.triggerAction === 'spawn-agent' && (
              <span className="px-2 py-0.5 text-xs bg-purple-500/20 text-purple-400 rounded">
                <Zap size={10} className="inline mr-1" />
                Triggers Agent
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onRun(script.id)}
              className="p-1.5 text-gray-500 hover:text-port-success transition-colors"
              title="Run now"
            >
              <Play size={14} />
            </button>
            <button
              onClick={() => setEditing(true)}
              className="p-1.5 text-gray-500 hover:text-white transition-colors"
              title="Edit"
            >
              <Edit3 size={14} />
            </button>
            <button
              onClick={() => onToggle(script)}
              className={`p-1.5 transition-colors ${
                script.enabled ? 'text-port-success hover:text-gray-500' : 'text-gray-500 hover:text-port-success'
              }`}
              title={script.enabled ? 'Disable' : 'Enable'}
            >
              {script.enabled ? <CheckCircle size={14} /> : <Ban size={14} />}
            </button>
            <button
              onClick={() => onDelete(script.id)}
              className="p-1.5 text-gray-500 hover:text-port-error transition-colors"
              title="Delete"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        {/* Edit Form */}
        {editing ? (
          <div className="space-y-3 mt-3">
            <div className="flex gap-3">
              <input
                type="text"
                placeholder="Script name *"
                value={editData.name}
                onChange={e => setEditData(d => ({ ...d, name: e.target.value }))}
                className="flex-1 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              />
              <select
                value={editData.schedule}
                onChange={e => setEditData(d => ({ ...d, schedule: e.target.value }))}
                className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              >
                <option value="on-demand">On Demand</option>
                <option value="every-5-min">Every 5 min</option>
                <option value="every-15-min">Every 15 min</option>
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>
            <input
              type="text"
              placeholder="Description"
              value={editData.description}
              onChange={e => setEditData(d => ({ ...d, description: e.target.value }))}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
            />
            <textarea
              placeholder="Shell command *"
              value={editData.command}
              onChange={e => setEditData(d => ({ ...d, command: e.target.value }))}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm font-mono h-20"
            />
            <div className="flex gap-3">
              <select
                value={editData.triggerAction}
                onChange={e => setEditData(d => ({ ...d, triggerAction: e.target.value }))}
                className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              >
                <option value="log-only">Log Only</option>
                <option value="spawn-agent">Spawn Agent</option>
              </select>
              <select
                value={editData.triggerPriority}
                onChange={e => setEditData(d => ({ ...d, triggerPriority: e.target.value }))}
                className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              >
                <option value="LOW">LOW</option>
                <option value="MEDIUM">MEDIUM</option>
                <option value="HIGH">HIGH</option>
                <option value="CRITICAL">CRITICAL</option>
              </select>
            </div>
            {editData.triggerAction === 'spawn-agent' && (
              <textarea
                placeholder="Prompt for agent when triggered"
                value={editData.triggerPrompt}
                onChange={e => setEditData(d => ({ ...d, triggerPrompt: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm h-16"
              />
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setEditing(false)}
                className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                className="flex items-center gap-1 px-3 py-1.5 bg-port-success/20 hover:bg-port-success/30 text-port-success rounded-lg text-sm transition-colors"
              >
                <Save size={14} />
                Save
              </button>
            </div>
          </div>
        ) : (
          <>
            {script.description && (
              <p className="text-sm text-gray-400 mb-2">{script.description}</p>
            )}

            <div className="flex items-center gap-4 text-xs text-gray-500">
              <span>Last run: {formatTime(script.lastRun)}</span>
              {script.lastExitCode !== null && (
                <span className={script.lastExitCode === 0 ? 'text-port-success' : 'text-port-error'}>
                  Exit: {script.lastExitCode}
                </span>
              )}
              <span>Runs: {script.runCount || 0}</span>
              {script.lastOutput && (
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="text-port-accent hover:text-port-accent/80"
                >
                  {expanded ? 'Hide' : 'Show'} output
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {/* Command preview */}
      {!editing && (
        <div className="px-4 pb-3">
          <code className="text-xs text-gray-500 font-mono bg-port-bg/50 px-2 py-1 rounded block truncate">
            {script.command}
          </code>
        </div>
      )}

      {/* Expanded output */}
      {expanded && script.lastOutput && (
        <div className="border-t border-port-border bg-port-bg/50 p-3 max-h-48 overflow-y-auto">
          <pre className="text-xs font-mono text-gray-400 whitespace-pre-wrap">
            {script.lastOutput}
          </pre>
        </div>
      )}
    </div>
  );
}
