import { useState, useEffect, useCallback } from 'react';
import { Clock, Play, RotateCcw, ChevronDown, ChevronRight, CheckCircle, XCircle, AlertCircle, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../../services/api';

const INTERVAL_LABELS = {
  rotation: 'Rotation',
  daily: 'Daily',
  weekly: 'Weekly',
  once: 'Once',
  'on-demand': 'On Demand',
  custom: 'Custom'
};

const INTERVAL_DESCRIPTIONS = {
  rotation: 'Runs as part of normal task rotation',
  daily: 'Runs once per day',
  weekly: 'Runs once per week',
  once: 'Runs once then stops',
  'on-demand': 'Only runs when manually triggered',
  custom: 'Custom interval'
};

function formatTimeRemaining(ms) {
  if (!ms || ms <= 0) return 'now';
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function TaskTypeRow({ taskType, config, onUpdate, onTrigger, onReset, category, providers }) {
  const [expanded, setExpanded] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [selectedType, setSelectedType] = useState(config.type);
  const [selectedProviderId, setSelectedProviderId] = useState(config.providerId || '');
  const [selectedModel, setSelectedModel] = useState(config.model || '');
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptValue, setPromptValue] = useState(config.prompt || '');

  const handleTypeChange = async (newType) => {
    setUpdating(true);
    setSelectedType(newType);
    await onUpdate(taskType, { type: newType }).catch(() => {
      setSelectedType(config.type);
    });
    setUpdating(false);
  };

  const handleToggleEnabled = async () => {
    setUpdating(true);
    await onUpdate(taskType, { enabled: !config.enabled });
    setUpdating(false);
  };

  const handleProviderChange = async (newProviderId) => {
    setUpdating(true);
    setSelectedProviderId(newProviderId);
    // Reset model when provider changes to avoid stale/invalid model selection
    setSelectedModel('');
    const providerId = newProviderId === '' ? null : newProviderId;
    await onUpdate(taskType, { providerId, model: null }).catch(() => {
      setSelectedProviderId(config.providerId || '');
      setSelectedModel(config.model || '');
    });
    setUpdating(false);
  };

  const handleModelChange = async (newModel) => {
    setUpdating(true);
    setSelectedModel(newModel);
    const model = newModel === '' ? null : newModel;
    await onUpdate(taskType, { model }).catch(() => {
      setSelectedModel(config.model || '');
    });
    setUpdating(false);
  };

  const handleSavePrompt = async () => {
    setUpdating(true);
    const prompt = promptValue.trim() === '' ? null : promptValue;
    await onUpdate(taskType, { prompt }).catch(() => {
      setPromptValue(config.prompt || '');
    });
    setEditingPrompt(false);
    setUpdating(false);
  };

  const handleCancelPromptEdit = () => {
    setPromptValue(config.prompt || '');
    setEditingPrompt(false);
  };

  const selectedProvider = providers?.find(p => p.id === (selectedProviderId || ''));
  const availableModels = selectedProvider?.models || [];

  const status = config.status || {};
  const isEligible = status.shouldRun;
  const nextRunText = status.nextRunAt
    ? formatTimeRemaining(new Date(status.nextRunAt).getTime() - Date.now())
    : null;

  return (
    <div className="border border-port-border rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-3 p-3 bg-port-card hover:bg-port-card/80 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <button
          className="text-gray-500 hover:text-white"
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-white">{taskType}</span>
            {!config.enabled && (
              <span className="text-xs px-2 py-0.5 bg-gray-600/50 text-gray-400 rounded">Disabled</span>
            )}
          </div>
          {config.lastRun && (
            <div className="text-xs text-gray-500">
              Last run: {new Date(config.lastRun).toLocaleDateString()} ({config.runCount || 0} total)
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {isEligible ? (
            <span className="flex items-center gap-1 text-xs text-port-success">
              <CheckCircle size={12} />
              Ready
            </span>
          ) : status.reason === 'disabled' ? (
            <span className="flex items-center gap-1 text-xs text-gray-500">
              <XCircle size={12} />
              Disabled
            </span>
          ) : status.reason === 'on-demand-only' ? (
            <span className="flex items-center gap-1 text-xs text-port-accent">
              <Clock size={12} />
              On Demand
            </span>
          ) : status.reason === 'once-completed' ? (
            <span className="flex items-center gap-1 text-xs text-port-warning">
              <CheckCircle size={12} />
              Completed
            </span>
          ) : nextRunText ? (
            <span className="flex items-center gap-1 text-xs text-gray-400">
              <Clock size={12} />
              {nextRunText}
            </span>
          ) : null}

          <span className={`text-xs px-2 py-0.5 rounded ${
            config.type === 'daily' ? 'bg-port-accent/20 text-port-accent' :
            config.type === 'weekly' ? 'bg-purple-500/20 text-purple-400' :
            config.type === 'once' ? 'bg-port-warning/20 text-port-warning' :
            config.type === 'on-demand' ? 'bg-gray-500/20 text-gray-400' :
            'bg-port-success/20 text-port-success'
          }`}>
            {INTERVAL_LABELS[config.type]}
          </span>
        </div>
      </div>

      {expanded && (
        <div className="p-4 border-t border-port-border bg-port-bg/50 space-y-4">
          <div className="flex items-center justify-between">
            <label className="text-sm text-gray-400">Enabled</label>
            <button
              onClick={handleToggleEnabled}
              disabled={updating}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                config.enabled ? 'bg-port-accent' : 'bg-gray-600'
              }`}
              aria-label={config.enabled ? 'Disable task' : 'Enable task'}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  config.enabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          <div>
            <label className="text-sm text-gray-400 block mb-2">Interval Type</label>
            <select
              value={selectedType}
              onChange={(e) => handleTypeChange(e.target.value)}
              disabled={updating}
              className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
            >
              <option value="rotation">Rotation (runs in task queue)</option>
              <option value="daily">Daily (once per day)</option>
              <option value="weekly">Weekly (once per week)</option>
              <option value="once">Once (run once then stop)</option>
              <option value="on-demand">On Demand (manual trigger only)</option>
            </select>
            <p className="text-xs text-gray-500 mt-1">{INTERVAL_DESCRIPTIONS[selectedType]}</p>
          </div>

          <div>
            <label className="text-sm text-gray-400 block mb-2">Provider (optional)</label>
            <select
              value={selectedProviderId}
              onChange={(e) => handleProviderChange(e.target.value)}
              disabled={updating}
              className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
            >
              <option value="">Default (active provider)</option>
              {providers?.map(provider => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">
              Leave as default to use the currently active provider
            </p>
          </div>

          <div>
            <label className="text-sm text-gray-400 block mb-2">Model (optional)</label>
            <select
              value={selectedModel}
              onChange={(e) => handleModelChange(e.target.value)}
              disabled={updating || (!selectedProviderId && !selectedModel)}
              className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
            >
              <option value="">Default model</option>
              {/* Show current model even if not in availableModels (e.g., provider not loaded yet) */}
              {selectedModel && !availableModels.includes(selectedModel) && (
                <option value={selectedModel}>{selectedModel}</option>
              )}
              {availableModels.map(model => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">
              Leave as default to use the provider's default model
            </p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm text-gray-400">Task Prompt</label>
              {!editingPrompt && (
                <button
                  onClick={() => setEditingPrompt(true)}
                  className="text-xs text-port-accent hover:text-port-accent/80"
                >
                  Edit
                </button>
              )}
            </div>
            {editingPrompt ? (
              <div className="space-y-2">
                <textarea
                  value={promptValue}
                  onChange={(e) => setPromptValue(e.target.value)}
                  disabled={updating}
                  rows={12}
                  className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-white text-sm font-mono"
                  placeholder="Enter task prompt"
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleSavePrompt}
                    disabled={updating}
                    className="px-3 py-1.5 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded transition-colors"
                  >
                    Save Prompt
                  </button>
                  <button
                    onClick={handleCancelPromptEdit}
                    disabled={updating}
                    className="px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded transition-colors"
                  >
                    Cancel
                  </button>
                </div>
                <p className="text-xs text-gray-500">
                  For app improvement tasks, use <code className="bg-port-border px-1 rounded">{'{appName}'}</code> and <code className="bg-port-border px-1 rounded">{'{repoPath}'}</code> as placeholders.
                </p>
              </div>
            ) : (
              <div
                className="bg-port-bg border border-port-border rounded px-3 py-2 text-xs text-gray-400 font-mono max-h-32 overflow-y-auto cursor-pointer hover:border-port-accent/50"
                onClick={() => setEditingPrompt(true)}
                title="Click to edit prompt"
              >
                <pre className="whitespace-pre-wrap">{promptValue || 'No prompt configured'}</pre>
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => onTrigger(taskType)}
              className="flex items-center gap-1 px-3 py-1.5 text-sm bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded transition-colors"
              title="Run this task immediately (bypasses schedule)"
            >
              <Play size={14} />
              Run Now
            </button>
            {(config.type === 'once' && status.reason === 'once-completed') && (
              <button
                onClick={() => onReset(taskType)}
                className="flex items-center gap-1 px-3 py-1.5 text-sm bg-port-warning/20 hover:bg-port-warning/30 text-port-warning rounded transition-colors"
                title="Reset execution history to run this task again"
              >
                <RotateCcw size={14} />
                Reset
              </button>
            )}
          </div>

          {status.completedAt && (
            <div className="text-xs text-gray-500">
              Completed: {new Date(status.completedAt).toLocaleString()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TaskTypeSection({ title, description, tasks, onUpdate, onTrigger, onReset, category, providers }) {
  const [collapsed, setCollapsed] = useState(false);
  const taskEntries = Object.entries(tasks || {});

  if (taskEntries.length === 0) return null;

  const enabledCount = taskEntries.filter(([, config]) => config.enabled).length;
  const readyCount = taskEntries.filter(([, config]) => config.status?.shouldRun).length;

  return (
    <div className="space-y-3">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-2 w-full text-left"
      >
        {collapsed ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
        <h3 className="text-lg font-semibold text-white">{title}</h3>
        <span className="text-xs text-gray-500">
          {enabledCount} enabled, {readyCount} ready
        </span>
      </button>
      {description && !collapsed && (
        <p className="text-sm text-gray-400 ml-6">{description}</p>
      )}
      {!collapsed && (
        <div className="space-y-2 ml-6">
          {taskEntries.map(([taskType, config]) => (
            <TaskTypeRow
              key={taskType}
              taskType={taskType}
              config={config}
              onUpdate={onUpdate}
              onTrigger={onTrigger}
              onReset={onReset}
              category={category}
              providers={providers}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function ScheduleTab({ apps }) {
  const [schedule, setSchedule] = useState(null);
  const [providers, setProviders] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchSchedule = useCallback(async () => {
    const data = await api.getCosSchedule().catch(() => null);
    setSchedule(data);
    setLoading(false);
  }, []);

  const fetchProviders = useCallback(async () => {
    const data = await api.getProviders().catch(() => null);
    setProviders(data?.providers || []);
  }, []);

  useEffect(() => {
    fetchSchedule();
    fetchProviders();
  }, [fetchSchedule, fetchProviders]);

  const handleUpdateSelfImprovement = async (taskType, settings) => {
    const result = await api.updateCosSelfImprovementInterval(taskType, settings).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result?.success) {
      toast.success(`Updated ${taskType} interval`);
      fetchSchedule();
    }
  };

  const handleUpdateAppImprovement = async (taskType, settings) => {
    const result = await api.updateCosAppImprovementInterval(taskType, settings).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result?.success) {
      toast.success(`Updated ${taskType} interval`);
      fetchSchedule();
    }
  };

  const handleTriggerSelfImprovement = async (taskType) => {
    const result = await api.triggerCosOnDemandTask(taskType, 'selfImprovement').catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result?.success) {
      toast.success(`Triggered ${taskType} task - will run on next evaluation`);
      fetchSchedule();
    }
  };

  const handleTriggerAppImprovement = async (taskType, appId) => {
    const result = await api.triggerCosOnDemandTask(taskType, 'appImprovement', appId).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result?.success) {
      toast.success(`Triggered ${taskType} task for app`);
      fetchSchedule();
    }
  };

  const handleResetSelfImprovement = async (taskType) => {
    const result = await api.resetCosTaskHistory(taskType, 'selfImprovement').catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result?.success) {
      toast.success(`Reset execution history for ${taskType}`);
      fetchSchedule();
    }
  };

  const handleResetAppImprovement = async (taskType, appId) => {
    const result = await api.resetCosTaskHistory(taskType, 'appImprovement', appId).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result?.success) {
      toast.success(`Reset execution history for ${taskType}`);
      fetchSchedule();
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading schedule...</div>
      </div>
    );
  }

  if (!schedule) {
    return (
      <div className="text-center py-8 text-gray-500">
        <AlertCircle className="w-12 h-12 mx-auto mb-3 opacity-50" />
        <p>Failed to load task schedule</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">Task Schedule</h2>
          <p className="text-sm text-gray-400 mt-1">
            Configure how often each task type runs. Set intervals to daily, weekly, once, or on-demand.
          </p>
        </div>
        <button
          onClick={fetchSchedule}
          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded transition-colors"
          title="Refresh schedule"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      {schedule.onDemandRequests?.length > 0 && (
        <div className="bg-port-accent/10 border border-port-accent/30 rounded-lg p-4">
          <h4 className="text-sm font-medium text-port-accent mb-2">Pending On-Demand Tasks</h4>
          <div className="space-y-1">
            {schedule.onDemandRequests.map(req => (
              <div key={req.id} className="text-sm text-gray-300">
                {req.taskType} ({req.category}) - requested {new Date(req.requestedAt).toLocaleTimeString()}
              </div>
            ))}
          </div>
        </div>
      )}

      <TaskTypeSection
        title="Self-Improvement Tasks"
        description="Tasks that analyze and improve PortOS itself"
        tasks={schedule.selfImprovement}
        onUpdate={handleUpdateSelfImprovement}
        onTrigger={handleTriggerSelfImprovement}
        onReset={handleResetSelfImprovement}
        category="selfImprovement"
        providers={providers}
      />

      <TaskTypeSection
        title="App Improvement Tasks"
        description="Tasks that analyze and improve managed applications"
        tasks={schedule.appImprovement}
        onUpdate={handleUpdateAppImprovement}
        onTrigger={(taskType) => {
          // For app improvement, we need to select an app first
          // For now, just trigger without app (will apply to next eligible app)
          handleTriggerAppImprovement(taskType, null);
        }}
        onReset={(taskType) => handleResetAppImprovement(taskType, null)}
        category="appImprovement"
        providers={providers}
      />

      {schedule.lastUpdated && (
        <div className="text-xs text-gray-500 text-right">
          Schedule last updated: {new Date(schedule.lastUpdated).toLocaleString()}
        </div>
      )}
    </div>
  );
}
