import { useState } from 'react';
import { Settings, Activity, CheckCircle, FileText } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../../services/api';
import ConfigRow from './ConfigRow';
import { AUTONOMY_LEVELS, detectAutonomyLevel, formatInterval } from '../constants';

// Color classes for autonomy level buttons
const LEVEL_COLORS = {
  green: {
    base: 'border-green-500/30 bg-green-500/10 text-green-400 hover:bg-green-500/20',
    active: 'ring-2 ring-green-500 border-green-500 bg-green-500/20'
  },
  blue: {
    base: 'border-blue-500/30 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20',
    active: 'ring-2 ring-blue-500 border-blue-500 bg-blue-500/20'
  },
  yellow: {
    base: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20',
    active: 'ring-2 ring-yellow-500 border-yellow-500 bg-yellow-500/20'
  },
  red: {
    base: 'border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20',
    active: 'ring-2 ring-red-500 border-red-500 bg-red-500/20'
  }
};

// Parameter labels for display
const PARAM_LABELS = {
  evaluationIntervalMs: 'Eval',
  maxConcurrentAgents: 'Agents',
  selfImprovementEnabled: 'Self',
  appImprovementEnabled: 'App',
  proactiveMode: 'Proactive',
  idleReviewEnabled: 'Idle',
  immediateExecution: 'Immediate',
  comprehensiveAppImprovement: 'Comprehensive'
};

// Format param value for display
const formatParamValue = (key, value) => {
  if (key === 'evaluationIntervalMs') return formatInterval(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
};

// AutonomyControl component
function AutonomyControl({ config, onLevelChange }) {
  const [hoveredLevel, setHoveredLevel] = useState(null);
  const currentLevel = detectAutonomyLevel(config);
  const isCustom = currentLevel === null;

  const handleLevelClick = async (level) => {
    await onLevelChange(level.params);
    toast.success(`Autonomy level set to ${level.label}`);
  };

  // Get the level to show in preview (hovered or current)
  const previewLevel = hoveredLevel
    ? AUTONOMY_LEVELS.find(l => l.id === hoveredLevel)
    : currentLevel
      ? AUTONOMY_LEVELS.find(l => l.id === currentLevel)
      : null;

  // Get current params for comparison
  const currentParams = previewLevel?.params || {};

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4 mb-6">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-medium text-gray-400">Autonomy Level</h4>
        {isCustom && (
          <span className="px-2 py-0.5 text-xs bg-gray-500/20 text-gray-400 rounded border border-gray-500/30">
            Custom
          </span>
        )}
      </div>

      {/* Level buttons */}
      <div className="grid grid-cols-4 gap-2 mb-3">
        {AUTONOMY_LEVELS.map((level) => {
          const isActive = currentLevel === level.id;
          const colorClasses = LEVEL_COLORS[level.color];

          return (
            <button
              key={level.id}
              onClick={() => handleLevelClick(level)}
              onMouseEnter={() => setHoveredLevel(level.id)}
              onMouseLeave={() => setHoveredLevel(null)}
              className={`
                px-3 py-2 text-sm font-medium rounded-lg border transition-all
                ${isActive ? colorClasses.active : colorClasses.base}
              `}
            >
              {level.label}
            </button>
          );
        })}
      </div>

      {/* Description */}
      {previewLevel && (
        <p className="text-sm text-gray-500 mb-3">
          {previewLevel.description}
        </p>
      )}

      {/* Parameters preview - always visible */}
      {previewLevel && (
        <div className="grid grid-cols-4 gap-2 text-xs">
          {Object.entries(previewLevel.params).map(([key, value]) => {
            const isDifferent = hoveredLevel && config && config[key] !== value;
            return (
              <div
                key={key}
                className={`
                  px-2 py-1 rounded
                  ${isDifferent
                    ? 'bg-yellow-500/20 text-yellow-400'
                    : 'bg-port-bg text-gray-400'
                  }
                `}
              >
                <span className="font-medium">{PARAM_LABELS[key]}:</span>{' '}
                {formatParamValue(key, value)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function ConfigTab({ config, onUpdate, onEvaluate, avatarStyle, setAvatarStyle, evalCountdown }) {
  const [editing, setEditing] = useState(false);
  const [formData, setFormData] = useState({
    evaluationIntervalMs: config?.evaluationIntervalMs || 60000,
    healthCheckIntervalMs: config?.healthCheckIntervalMs || 900000,
    maxConcurrentAgents: config?.maxConcurrentAgents || 3,
    maxProcessMemoryMb: config?.maxProcessMemoryMb || 2048,
    autoStart: config?.autoStart || false,
    selfImprovementEnabled: config?.selfImprovementEnabled ?? true,
    appImprovementEnabled: config?.appImprovementEnabled ?? true,
    proactiveMode: config?.proactiveMode ?? true,
    idleReviewEnabled: config?.idleReviewEnabled ?? true,
    immediateExecution: config?.immediateExecution ?? true,
    comprehensiveAppImprovement: config?.comprehensiveAppImprovement ?? true
  });

  const handleLevelChange = async (params) => {
    const updatedData = { ...formData, ...params };
    setFormData(updatedData);
    await api.updateCosConfig(params).catch(err => toast.error(err.message));
    onUpdate();
  };

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

      {/* Autonomy Level Control */}
      <AutonomyControl config={config} onLevelChange={handleLevelChange} />

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
        <ConfigRow
          label="Self-Improvement"
          value={formData.selfImprovementEnabled ? 'Enabled' : 'Disabled'}
          editing={editing}
          type="checkbox"
          inputValue={formData.selfImprovementEnabled}
          onChange={v => setFormData(f => ({ ...f, selfImprovementEnabled: v }))}
          tooltip="Allow CoS to improve the PortOS codebase (security audits, code quality, etc.)"
        />
        <ConfigRow
          label="App Improvement"
          value={formData.appImprovementEnabled ? 'Enabled' : 'Disabled'}
          editing={editing}
          type="checkbox"
          inputValue={formData.appImprovementEnabled}
          onChange={v => setFormData(f => ({ ...f, appImprovementEnabled: v }))}
          tooltip="Allow CoS to improve managed apps (code review, testing, documentation, etc.)"
        />
        <ConfigRow
          label="Proactive Mode"
          value={formData.proactiveMode ? 'Enabled' : 'Disabled'}
          editing={editing}
          type="checkbox"
          inputValue={formData.proactiveMode}
          onChange={v => setFormData(f => ({ ...f, proactiveMode: v }))}
          tooltip="Proactively find and create tasks based on mission goals"
        />
        <ConfigRow
          label="Idle Review"
          value={formData.idleReviewEnabled ? 'Enabled' : 'Disabled'}
          editing={editing}
          type="checkbox"
          inputValue={formData.idleReviewEnabled}
          onChange={v => setFormData(f => ({ ...f, idleReviewEnabled: v }))}
          tooltip="Review apps for improvements when no user tasks are pending"
        />
        <ConfigRow
          label="Immediate Execution"
          value={formData.immediateExecution ? 'Enabled' : 'Disabled'}
          editing={editing}
          type="checkbox"
          inputValue={formData.immediateExecution}
          onChange={v => setFormData(f => ({ ...f, immediateExecution: v }))}
          tooltip="Execute new tasks immediately instead of waiting for evaluation interval"
        />
        <ConfigRow
          label="Comprehensive App Analysis"
          value={formData.comprehensiveAppImprovement ? 'Enabled' : 'Disabled'}
          editing={editing}
          type="checkbox"
          inputValue={formData.comprehensiveAppImprovement}
          onChange={v => setFormData(f => ({ ...f, comprehensiveAppImprovement: v }))}
          tooltip="Use comprehensive analysis for managed apps (same as PortOS self-improvement)"
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
                const labels = { svg: 'Digital', ascii: 'Minimalist', cyber: 'Cyberpunk 3D' };
                toast.success(`Avatar style changed to ${labels[style] || style}`);
              }}
              className="bg-port-bg border border-port-border rounded px-3 py-1.5 text-white text-sm"
            >
              <option value="svg">Digital (SVG)</option>
              <option value="cyber">Cyberpunk (3D)</option>
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
