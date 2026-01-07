import { useState } from 'react';
import { Settings, Activity, CheckCircle, FileText } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../../services/api';
import ConfigRow from './ConfigRow';

export default function ConfigTab({ config, onUpdate, onEvaluate, avatarStyle, setAvatarStyle, evalCountdown }) {
  const [editing, setEditing] = useState(false);
  const [formData, setFormData] = useState({
    evaluationIntervalMs: config?.evaluationIntervalMs || 60000,
    healthCheckIntervalMs: config?.healthCheckIntervalMs || 900000,
    maxConcurrentAgents: config?.maxConcurrentAgents || 3,
    maxProcessMemoryMb: config?.maxProcessMemoryMb || 2048,
    autoStart: config?.autoStart || false
  });

  const handleSave = async () => {
    await api.updateCosConfig(formData).catch(err => toast.error(err.message));
    toast.success('Configuration updated');
    setEditing(false);
    onUpdate();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-white">Configuration</h3>
        <div className="flex gap-2">
          <button
            onClick={onEvaluate}
            className="flex items-center gap-2 px-3 py-1.5 text-sm bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg transition-colors"
            title="Immediately check for pending tasks and spawn agents to work on them (normally runs on the evaluation interval)"
          >
            <Activity size={14} />
            Force Evaluate
          </button>
          {!editing ? (
            <button
              onClick={() => setEditing(true)}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded-lg transition-colors"
            >
              <Settings size={14} />
              Edit
            </button>
          ) : (
            <button
              onClick={handleSave}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-port-success/20 hover:bg-port-success/30 text-port-success rounded-lg transition-colors"
            >
              <CheckCircle size={14} />
              Save
            </button>
          )}
        </div>
      </div>

      <div className="bg-port-card border border-port-border rounded-lg divide-y divide-port-border">
        <ConfigRow
          label="Evaluation Interval"
          value={`${formData.evaluationIntervalMs / 1000}s`}
          editing={editing}
          type="number"
          inputValue={formData.evaluationIntervalMs / 1000}
          onChange={v => setFormData(f => ({ ...f, evaluationIntervalMs: v * 1000 }))}
          suffix="seconds"
          tooltip="How often CoS checks for pending tasks and spawns agents to work on them"
        />
        {evalCountdown && (
          <div className="flex items-center justify-between p-4 bg-port-accent/5">
            <span className="text-gray-500 text-sm">Next evaluation in</span>
            <span className="font-mono text-port-accent">{evalCountdown.formatted}</span>
          </div>
        )}
        <ConfigRow
          label="Health Check Interval"
          value={`${formData.healthCheckIntervalMs / 60000}m`}
          editing={editing}
          type="number"
          inputValue={formData.healthCheckIntervalMs / 60000}
          onChange={v => setFormData(f => ({ ...f, healthCheckIntervalMs: v * 60000 }))}
          suffix="minutes"
          tooltip="How often CoS runs system health checks (PM2 processes, memory usage, etc.)"
        />
        <ConfigRow
          label="Max Concurrent Agents"
          value={formData.maxConcurrentAgents}
          editing={editing}
          type="number"
          inputValue={formData.maxConcurrentAgents}
          onChange={v => setFormData(f => ({ ...f, maxConcurrentAgents: v }))}
          tooltip="Maximum number of AI agents that can run simultaneously"
        />
        <ConfigRow
          label="Max Process Memory"
          value={`${formData.maxProcessMemoryMb} MB`}
          editing={editing}
          type="number"
          inputValue={formData.maxProcessMemoryMb}
          onChange={v => setFormData(f => ({ ...f, maxProcessMemoryMb: v }))}
          suffix="MB"
          tooltip="Memory threshold for health alerts - processes exceeding this will be flagged"
        />
        <ConfigRow
          label="Auto Start"
          value={formData.autoStart ? 'Enabled' : 'Disabled'}
          editing={editing}
          type="checkbox"
          inputValue={formData.autoStart}
          onChange={v => setFormData(f => ({ ...f, autoStart: v }))}
          tooltip="Automatically start the CoS daemon when the server starts"
        />
      </div>

      {/* Avatar Style */}
      <div>
        <h4 className="text-sm font-medium text-gray-400 mb-2">Appearance</h4>
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <div
            className="flex items-center justify-between"
            title="Choose the visual style for the CoS avatar in the sidebar panel"
          >
            <span className="text-gray-400 cursor-help">CoS Avatar Style</span>
            <select
              value={avatarStyle}
              onChange={async (e) => {
                const style = e.target.value;
                await setAvatarStyle(style);
                toast.success(`Avatar style changed to ${style === 'svg' ? 'Digital' : 'Minimalist'}`);
              }}
              className="bg-port-bg border border-port-border rounded px-3 py-1.5 text-white text-sm"
            >
              <option value="svg">Digital (SVG)</option>
              <option value="ascii">Minimalist (ASCII)</option>
            </select>
          </div>
        </div>
      </div>

      {/* MCP Servers */}
      <div>
        <h4 className="text-sm font-medium text-gray-400 mb-2">MCP Servers</h4>
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          {config?.mcpServers?.map((mcp, idx) => (
            <div key={idx} className="flex items-center gap-2 text-sm">
              <span className="text-port-accent font-mono">{mcp.name}</span>
              <span className="text-gray-500">:</span>
              <span className="text-gray-400">{mcp.command} {mcp.args?.join(' ')}</span>
            </div>
          )) || <span className="text-gray-500">No MCP servers configured</span>}
        </div>
      </div>

      {/* Task Files */}
      <div>
        <h4 className="text-sm font-medium text-gray-400 mb-2">Task Files</h4>
        <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <FileText size={14} className="text-gray-500" />
            <span className="text-gray-400">User Tasks:</span>
            <span className="text-white font-mono">{config?.userTasksFile || 'TASKS.md'}</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <FileText size={14} className="text-gray-500" />
            <span className="text-gray-400">System Tasks:</span>
            <span className="text-white font-mono">{config?.cosTasksFile || 'COS-TASKS.md'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
