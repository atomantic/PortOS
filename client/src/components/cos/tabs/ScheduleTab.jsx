import { useState, useEffect, useCallback, useRef } from 'react';
import { Play, RotateCcw, ChevronDown, ChevronRight, AlertCircle, RefreshCw, Package } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../../services/api';
import AppIcon from '../../AppIcon';
import { AGENT_OPTIONS, toggleAppMetadataOverride } from '../constants';

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

// Toggle a global taskMetadata field, enforcing the openPR→useWorktree invariant.
function toggleMetadataField(metadata, field) {
  const current = metadata || {};
  const newMeta = { ...current, [field]: !current[field] };
  // openPR requires useWorktree
  if (newMeta.openPR && !newMeta.useWorktree) {
    newMeta.useWorktree = true;
  }
  // useWorktree off means openPR must be off
  if (newMeta.useWorktree === false && newMeta.openPR) {
    newMeta.openPR = false;
  }
  const active = Object.fromEntries(Object.entries(newMeta).filter(([, v]) => v));
  return Object.keys(active).length ? active : null;
}


function IntervalBadge({ type }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded ${
      type === 'daily' ? 'bg-port-accent/20 text-port-accent' :
      type === 'weekly' ? 'bg-purple-500/20 text-purple-400' :
      type === 'once' ? 'bg-port-warning/20 text-port-warning' :
      type === 'on-demand' ? 'bg-gray-500/20 text-gray-400' :
      'bg-port-success/20 text-port-success'
    }`}>
      {INTERVAL_LABELS[type]}
    </span>
  );
}

function GlobalConfigControls({ taskType, config, onUpdate, onTrigger, onReset, category: _category, providers, apps, updating, setUpdating }) {
  const [selectedType, setSelectedType] = useState(config.type);
  const [selectedProviderId, setSelectedProviderId] = useState(config.providerId || '');
  const [selectedModel, setSelectedModel] = useState(config.model || '');
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptValue, setPromptValue] = useState(config.prompt || '');
  const [showAppSelector, setShowAppSelector] = useState(false);
  const appSelectorRef = useRef(null);

  useEffect(() => {
    setSelectedType(config.type);
    setSelectedProviderId(config.providerId || '');
    setSelectedModel(config.model || '');
    if (!editingPrompt) {
      setPromptValue(config.prompt || '');
    }
  }, [config.type, config.providerId, config.model, config.prompt, editingPrompt]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (appSelectorRef.current && !appSelectorRef.current.contains(event.target)) {
        setShowAppSelector(false);
      }
    };
    if (showAppSelector) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showAppSelector]);

  const activeApps = apps?.filter(app => !app.archived) || [];

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

  const selectedProvider = providers?.find(p => p.id === (selectedProviderId || ''));
  const availableModels = selectedProvider?.models || [];
  const status = config.status || {};

  return (
    <div className="space-y-4">
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
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            config.enabled ? 'translate-x-6' : 'translate-x-1'
          }`} />
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
            <option key={provider.id} value={provider.id}>{provider.name}</option>
          ))}
        </select>
        <p className="text-xs text-gray-500 mt-1">Leave as default to use the currently active provider</p>
      </div>

      <div>
        <label className="text-sm text-gray-400 block mb-2">Model (optional)</label>
        <select
          value={selectedModel}
          onChange={(e) => handleModelChange(e.target.value)}
          disabled={updating}
          className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
        >
          <option value="">Default model</option>
          {selectedModel && !availableModels.includes(selectedModel) && (
            <option value={selectedModel}>{selectedModel}</option>
          )}
          {availableModels.map(model => (
            <option key={model} value={model}>{model}</option>
          ))}
        </select>
        <p className="text-xs text-gray-500 mt-1">Leave as default to use the provider's default model</p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm text-gray-400">Task Prompt</label>
          {!editingPrompt && (
            <button onClick={() => setEditingPrompt(true)} className="text-xs text-port-accent hover:text-port-accent/80">Edit</button>
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
                onClick={() => { setPromptValue(config.prompt || ''); setEditingPrompt(false); }}
                disabled={updating}
                className="px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded transition-colors"
              >
                Cancel
              </button>
            </div>
            {activeApps.length > 0 && (
              <p className="text-xs text-gray-500">
                Use <code className="bg-port-border px-1 rounded">{'{appName}'}</code> and <code className="bg-port-border px-1 rounded">{'{repoPath}'}</code> as placeholders.
              </p>
            )}
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

      <div>
        <label className="text-sm text-gray-400 block mb-2">Agent Options</label>
        <div className="space-y-2">
          {AGENT_OPTIONS.map(({ field, label, description }) => {
            const enabled = config.taskMetadata?.[field] ?? false;
            return (
              <div key={field} className="flex items-center justify-between">
                <div>
                  <span className="text-sm text-white">{label}</span>
                  <p className="text-xs text-gray-500">{description}</p>
                </div>
                <button
                  onClick={() => onUpdate(taskType, { taskMetadata: toggleMetadataField(config.taskMetadata, field) })}
                  disabled={updating}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    enabled ? 'bg-port-accent' : 'bg-gray-600'
                  }`}
                  aria-label={`${enabled ? 'Disable' : 'Enable'} ${label.toLowerCase()}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    enabled ? 'translate-x-6' : 'translate-x-1'
                  }`} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex gap-2">
        {activeApps.length > 0 ? (
          <div className="relative" ref={appSelectorRef}>
            <button
              onClick={() => setShowAppSelector(!showAppSelector)}
              className="flex items-center gap-1 px-3 py-1.5 text-sm bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded transition-colors"
              title="Run this task on a specific app"
            >
              <Play size={14} />
              Run on App
              <ChevronDown size={12} className={`transition-transform ${showAppSelector ? 'rotate-180' : ''}`} />
            </button>
            {showAppSelector && (
              <div className="absolute bottom-full left-0 mb-1 z-50 w-64 max-w-[calc(100vw-2rem)] max-h-64 overflow-y-auto bg-port-card border border-port-border rounded-lg shadow-lg">
                <div className="p-2 border-b border-port-border">
                  <span className="text-xs text-gray-400">Select an app to run {taskType} on:</span>
                </div>
                <div className="py-1">
                  {activeApps.map(app => (
                    <button
                      key={app.id}
                      onClick={() => { onTrigger(taskType, app.id); setShowAppSelector(false); }}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-port-border/50 flex items-center gap-2 min-h-[40px]"
                    >
                      <Package size={14} className="text-gray-400 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-white truncate">{app.name}</div>
                        {app.repoPath && <div className="text-xs text-gray-500 truncate">{app.repoPath}</div>}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <button
            onClick={() => onTrigger(taskType)}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded transition-colors"
            title="Run this task immediately (bypasses schedule)"
          >
            <Play size={14} />
            Run Now
          </button>
        )}
        {config.type === 'once' && status.reason === 'once-completed' && (
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
  );
}

function AppOverrideRow({ app, taskType, globalIntervalType, globalTaskMetadata, override, onUpdate }) {
  const [updating, setUpdating] = useState(false);
  const isEnabled = override?.enabled === true;
  const currentInterval = override?.interval || null;

  const handleToggle = async () => {
    setUpdating(true);
    await onUpdate(app.id, taskType, { enabled: !isEnabled, interval: currentInterval }).catch(() => {});
    setUpdating(false);
  };

  const handleIntervalChange = async (newInterval) => {
    setUpdating(true);
    const interval = newInterval === '' ? null : newInterval;
    await onUpdate(app.id, taskType, { enabled: isEnabled, interval }).catch(() => {});
    setUpdating(false);
  };

  const handleMetaToggle = async (field) => {
    setUpdating(true);
    const taskMetadata = toggleAppMetadataOverride(override?.taskMetadata, globalTaskMetadata, field);
    await onUpdate(app.id, taskType, { taskMetadata }).catch(() => {});
    setUpdating(false);
  };

  return (
    <div className="flex items-center gap-3 py-2 px-3 rounded hover:bg-port-card/30">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <AppIcon icon={app.icon || 'package'} appId={app.id} hasAppIcon={!!app.appIconPath} size={16} className="text-gray-400 shrink-0" />
        <span className="text-sm text-white truncate">{app.name}</span>
      </div>

      <select
        value={currentInterval || ''}
        onChange={(e) => handleIntervalChange(e.target.value)}
        disabled={updating}
        className="bg-port-card border border-port-border rounded px-2 py-1 text-xs text-white min-w-[140px]"
      >
        <option value="">Inherit ({INTERVAL_LABELS[globalIntervalType]})</option>
        <option value="rotation">Rotation</option>
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
        <option value="once">Once</option>
        <option value="on-demand">On Demand</option>
      </select>

      {AGENT_OPTIONS.map(({ field, label, shortLabel }) => {
        const effective = override?.taskMetadata?.[field] ?? globalTaskMetadata?.[field] ?? false;
        const hasOverride = override?.taskMetadata?.[field] !== undefined;
        return (
          <button
            key={field}
            onClick={() => handleMetaToggle(field)}
            disabled={updating}
            aria-pressed={effective}
            aria-label={`${label}: ${effective ? 'on' : 'off'}${hasOverride ? ' (app override)' : ' (inherited)'}`}
            className={`text-xs px-1.5 py-0.5 rounded transition-colors shrink-0 ${
              effective
                ? hasOverride ? 'bg-port-accent/30 text-port-accent' : 'bg-port-accent/15 text-port-accent/60'
                : hasOverride ? 'bg-gray-600/50 text-gray-400' : 'bg-gray-600/25 text-gray-500'
            }`}
            title={`${label}: ${effective ? 'on' : 'off'}${hasOverride ? ' (app override)' : ' (inherited)'}`}
          >
            {shortLabel}
          </button>
        );
      })}

      <button
        onClick={handleToggle}
        disabled={updating}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
          isEnabled ? 'bg-port-accent' : 'bg-gray-600'
        } ${updating ? 'opacity-50' : ''}`}
        aria-label={`${isEnabled ? 'Disable' : 'Enable'} ${taskType} for ${app.name}`}
      >
        <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
          isEnabled ? 'translate-x-5' : 'translate-x-1'
        }`} />
      </button>
    </div>
  );
}

function PerAppOverrideList({ taskType, config, apps, onUpdateOverride, onBulkToggleOverride }) {
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const activeApps = apps?.filter(app => !app.archived) || [];
  const appOverrides = config.appOverrides || {};

  if (activeApps.length === 0) return null;

  const allEnabled = activeApps.every(app => appOverrides[app.id]?.enabled === true);
  const allDisabled = activeApps.every(app => appOverrides[app.id]?.enabled !== true);

  const handleBulkToggle = async () => {
    setBulkUpdating(true);
    const newEnabled = !allEnabled;
    await onBulkToggleOverride(taskType, newEnabled);
    setBulkUpdating(false);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-medium text-gray-400">Per-App Overrides</h4>
        <button
          onClick={handleBulkToggle}
          disabled={bulkUpdating}
          className={`text-xs px-2 py-1 rounded transition-colors ${
            bulkUpdating ? 'opacity-50 cursor-not-allowed' : ''
          } ${
            allEnabled
              ? 'text-port-error hover:bg-port-error/10'
              : allDisabled
                ? 'text-port-success hover:bg-port-success/10'
                : 'text-port-accent hover:bg-port-accent/10'
          }`}
        >
          {allEnabled ? 'Disable All' : 'Enable All'}
        </button>
      </div>
      <div className="border border-port-border rounded-lg divide-y divide-port-border/50">
        {activeApps.map(app => (
          <AppOverrideRow
            key={app.id}
            app={app}
            taskType={taskType}
            globalIntervalType={config.type}
            globalTaskMetadata={config.taskMetadata}
            override={appOverrides[app.id]}
            onUpdate={onUpdateOverride}
          />
        ))}
      </div>
    </div>
  );
}

function AppTaskTypeRow({ taskType, config, onUpdate, onTrigger, onReset, providers, apps, onUpdateOverride, onBulkToggleOverride }) {
  const [expanded, setExpanded] = useState(false);
  const [updating, setUpdating] = useState(false);

  const enabledCount = config.enabledAppCount ?? 0;
  const totalCount = config.totalAppCount ?? 0;

  return (
    <div className="border border-port-border rounded-lg">
      <div
        className={`flex items-center gap-3 p-3 bg-port-card hover:bg-port-card/80 cursor-pointer ${expanded ? 'rounded-t-lg' : 'rounded-lg'}`}
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
          {config.globalLastRun && (
            <div className="text-xs text-gray-500">
              Last run: {new Date(config.globalLastRun).toLocaleDateString()} ({config.globalRunCount || 0} total)
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {totalCount > 0 && (
            <span className={`text-xs px-2 py-0.5 rounded ${
              enabledCount === totalCount ? 'bg-port-success/20 text-port-success' :
              enabledCount === 0 ? 'bg-port-error/20 text-port-error' :
              'bg-port-warning/20 text-port-warning'
            }`}>
              {enabledCount}/{totalCount} apps
            </span>
          )}
          <IntervalBadge type={config.type} />
        </div>
      </div>

      {expanded && (
        <div className="p-4 border-t border-port-border bg-port-bg/50 space-y-6">
          <div>
            <h4 className="text-sm font-medium text-gray-400 mb-3">Global Defaults</h4>
            <GlobalConfigControls
              taskType={taskType}
              config={config}
              onUpdate={onUpdate}
              onTrigger={onTrigger}
              onReset={onReset}
              category="appImprovement"
              providers={providers}
              apps={apps}
              updating={updating}
              setUpdating={setUpdating}
            />
          </div>

          <PerAppOverrideList
            taskType={taskType}
            config={config}
            apps={apps}
            onUpdateOverride={onUpdateOverride}
            onBulkToggleOverride={onBulkToggleOverride}
          />
        </div>
      )}
    </div>
  );
}

function AppTaskTypeSection({ tasks, onUpdate, onTrigger, onReset, providers, apps, onUpdateOverride, onBulkToggleOverride }) {
  const taskEntries = Object.entries(tasks || {});
  if (taskEntries.length === 0) return null;

  const enabledCount = taskEntries.filter(([, config]) => config.enabled).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-lg font-semibold text-white">Improvement Tasks</h3>
        <span className="text-xs text-gray-500">
          {enabledCount} enabled
        </span>
      </div>
      <p className="text-sm text-gray-400">
        Tasks that analyze and improve PortOS and managed apps. Expand a task to configure per-app overrides.
      </p>
      <div className="space-y-2">
        {taskEntries.map(([taskType, config]) => (
          <AppTaskTypeRow
            key={taskType}
            taskType={taskType}
            config={config}
            onUpdate={onUpdate}
            onTrigger={onTrigger}
            onReset={onReset}
            providers={providers}
            apps={apps}
            onUpdateOverride={onUpdateOverride}
            onBulkToggleOverride={onBulkToggleOverride}
          />
        ))}
      </div>
    </div>
  );
}

export default function ScheduleTab({ apps }) {
  // searchParams no longer used — unified task list
  const [schedule, setSchedule] = useState(null);
  const [providers, setProviders] = useState(null);
  const [loading, setLoading] = useState(true);

  // View state removed — unified task list replaces segmented self/app views

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

  const handleUpdateTask = async (taskType, settings) => {
    const result = await api.updateCosTaskInterval(taskType, settings).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result?.success) {
      toast.success(`Updated ${taskType} interval`);
      fetchSchedule();
    }
  };

  const handleTriggerTask = async (taskType, appId = null) => {
    const result = await api.triggerCosOnDemandTask(taskType, appId).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result?.success) {
      toast.success(`Triggered ${taskType} task${appId ? ' for app' : ''} - will run on next evaluation`);
      fetchSchedule();
    }
  };

  const handleResetTask = async (taskType) => {
    const result = await api.resetCosTaskHistory(taskType).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result?.success) {
      toast.success(`Reset execution history for ${taskType}`);
      fetchSchedule();
    }
  };

  const handleTriggerAppImprovement = (taskType, appId) => handleTriggerTask(taskType, appId);

  const handleUpdateAppOverride = async (appId, taskType, { enabled, interval, taskMetadata }) => {
    const result = await api.updateAppTaskTypeOverride(appId, taskType, { enabled, interval, taskMetadata }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result?.success) {
      const appName = apps?.find(a => a.id === appId)?.name || appId;
      toast.success(`Updated ${taskType} override for ${appName}`);
      fetchSchedule();
    }
  };

  const handleBulkToggleOverride = async (taskType, enabled) => {
    const result = await api.bulkUpdateAppTaskTypeOverride(taskType, { enabled }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result?.success) {
      toast.success(`${enabled ? 'Enabled' : 'Disabled'} ${taskType} for all apps`);
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">Task Schedule</h2>
          <p className="text-sm text-gray-400 mt-1">
            Configure how often each task type runs.
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
                {req.taskType}{req.appId ? ` (${req.appId})` : ''} - requested {new Date(req.requestedAt).toLocaleTimeString()}
              </div>
            ))}
          </div>
        </div>
      )}

      <AppTaskTypeSection
        tasks={schedule.tasks || schedule.appImprovement || schedule.selfImprovement}
        onUpdate={handleUpdateTask}
        onTrigger={handleTriggerAppImprovement}
        onReset={handleResetTask}
        providers={providers}
        apps={apps}
        onUpdateOverride={handleUpdateAppOverride}
        onBulkToggleOverride={handleBulkToggleOverride}
      />

      {schedule.lastUpdated && (
        <div className="text-xs text-gray-500 text-right">
          Schedule last updated: {new Date(schedule.lastUpdated).toLocaleString()}
        </div>
      )}
    </div>
  );
}
