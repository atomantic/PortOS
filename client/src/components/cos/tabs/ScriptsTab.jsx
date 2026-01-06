import { useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../../services/api';
import ScriptCard from './ScriptCard';

export default function ScriptsTab({ scripts, onRefresh }) {
  const [showCreate, setShowCreate] = useState(false);
  const [newScript, setNewScript] = useState({
    name: '',
    description: '',
    command: '',
    schedule: 'on-demand',
    cronExpression: '',
    triggerAction: 'log-only',
    triggerPrompt: '',
    triggerPriority: 'MEDIUM'
  });

  const handleCreate = async () => {
    if (!newScript.name.trim() || !newScript.command.trim()) {
      toast.error('Name and command are required');
      return;
    }

    await api.createCosScript(newScript).catch(err => {
      toast.error(err.message);
      return;
    });

    toast.success('Script created');
    setNewScript({
      name: '',
      description: '',
      command: '',
      schedule: 'on-demand',
      cronExpression: '',
      triggerAction: 'log-only',
      triggerPrompt: '',
      triggerPriority: 'MEDIUM'
    });
    setShowCreate(false);
    onRefresh();
  };

  const handleRun = async (id) => {
    toast.loading('Running script...', { id: 'script-run' });
    const result = await api.runCosScript(id).catch(err => {
      toast.error(err.message, { id: 'script-run' });
      return null;
    });
    if (result) {
      if (result.success) {
        toast.success('Script completed', { id: 'script-run' });
      } else {
        toast.error(`Script failed: ${result.error || 'Unknown error'}`, { id: 'script-run' });
      }
      onRefresh();
    }
  };

  const handleToggle = async (script) => {
    await api.updateCosScript(script.id, { enabled: !script.enabled }).catch(err => toast.error(err.message));
    toast.success(script.enabled ? 'Script disabled' : 'Script enabled');
    onRefresh();
  };

  const handleDelete = async (id) => {
    await api.deleteCosScript(id).catch(err => toast.error(err.message));
    toast.success('Script deleted');
    onRefresh();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold text-white">Scheduled Scripts</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="flex items-center gap-1 text-sm text-port-accent hover:text-port-accent/80 transition-colors"
          >
            <Plus size={16} />
            New Script
          </button>
          <button
            onClick={onRefresh}
            className="text-gray-500 hover:text-white transition-colors"
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {/* Create Script Form */}
      {showCreate && (
        <div className="bg-port-card border border-port-accent/50 rounded-lg p-4 mb-4">
          <div className="space-y-3">
            <div className="flex gap-3">
              <input
                type="text"
                placeholder="Script name *"
                value={newScript.name}
                onChange={e => setNewScript(s => ({ ...s, name: e.target.value }))}
                className="flex-1 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              />
              <select
                value={newScript.schedule}
                onChange={e => setNewScript(s => ({ ...s, schedule: e.target.value }))}
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
              value={newScript.description}
              onChange={e => setNewScript(s => ({ ...s, description: e.target.value }))}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
            />
            <textarea
              placeholder="Shell command *"
              value={newScript.command}
              onChange={e => setNewScript(s => ({ ...s, command: e.target.value }))}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm font-mono h-20"
            />
            <div className="flex gap-3">
              <select
                value={newScript.triggerAction}
                onChange={e => setNewScript(s => ({ ...s, triggerAction: e.target.value }))}
                className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              >
                <option value="log-only">Log Only</option>
                <option value="spawn-agent">Spawn Agent</option>
              </select>
              <select
                value={newScript.triggerPriority}
                onChange={e => setNewScript(s => ({ ...s, triggerPriority: e.target.value }))}
                className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              >
                <option value="LOW">LOW</option>
                <option value="MEDIUM">MEDIUM</option>
                <option value="HIGH">HIGH</option>
                <option value="CRITICAL">CRITICAL</option>
              </select>
            </div>
            {newScript.triggerAction === 'spawn-agent' && (
              <textarea
                placeholder="Prompt for agent when triggered"
                value={newScript.triggerPrompt}
                onChange={e => setNewScript(s => ({ ...s, triggerPrompt: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm h-16"
              />
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowCreate(false)}
                className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                className="flex items-center gap-1 px-3 py-1.5 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors"
              >
                <Plus size={14} />
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Scripts List */}
      {scripts.length === 0 ? (
        <div className="bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-500">
          No scripts configured. Create a script to automate tasks.
        </div>
      ) : (
        <div className="space-y-2">
          {scripts.map(script => (
            <ScriptCard
              key={script.id}
              script={script}
              onRun={handleRun}
              onToggle={handleToggle}
              onDelete={handleDelete}
              onUpdate={onRefresh}
            />
          ))}
        </div>
      )}
    </div>
  );
}
