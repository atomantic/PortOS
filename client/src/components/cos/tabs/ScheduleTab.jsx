import { useState, useEffect, useCallback, useRef, memo } from 'react';
import { Play, RotateCcw, ChevronDown, ChevronRight, AlertCircle, RefreshCw, Package, Info, GitMerge } from 'lucide-react';
import toast from '../../ui/Toast';
import * as api from '../../../services/api';
import AppIcon from '../../AppIcon';
import CronInput from '../../CronInput';
import { AGENT_OPTIONS, toggleAppMetadataOverride, agentOptionButtonClass } from '../constants';
import { isCronExpression, describeCron } from '../../../utils/cronHelpers';
import ToggleSwitch from '../../ToggleSwitch';

const INTERVAL_LABELS = {
  rotation: 'Rotation',
  daily: 'Daily',
  weekly: 'Weekly',
  once: 'Once',
  'on-demand': 'On Demand',
  custom: 'Custom',
  cron: 'Cron'
};

const INTERVAL_DESCRIPTIONS = {
  rotation: 'Runs as part of normal task rotation',
  daily: 'Runs once per day',
  weekly: 'Runs once per week',
  once: 'Runs once then stops',
  'on-demand': 'Only runs when manually triggered',
  custom: 'Custom interval',
  cron: 'Cron expression schedule'
};

const BADGE_COLORS = {
  accent: 'bg-port-accent/15 text-port-accent border-port-accent/30',
  purple: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  warning: 'bg-port-warning/15 text-port-warning border-port-warning/30',
  gray: 'bg-gray-600/30 text-gray-400 border-gray-500/30',
  cyan: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
  success: 'bg-port-success/15 text-port-success border-port-success/30',
  error: 'bg-port-error/15 text-port-error border-port-error/30',
};

const badge = (variant) => `text-xs font-medium px-2.5 py-1 rounded-full border ${BADGE_COLORS[variant] || BADGE_COLORS.gray}`;

const INTERVAL_BADGE_VARIANT = {
  daily: 'accent',
  weekly: 'purple',
  once: 'warning',
  'on-demand': 'gray',
  cron: 'cyan',
};

// Toggle a global taskMetadata field, enforcing the openPR→useWorktree invariant.
// Persists both true and false values so explicit overrides survive the server-side
// merge with task-type defaults (e.g., feature-ideas defaults openPR to true).
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
  return newMeta;
}


function IntervalBadge({ type, cronExpression }) {
  const label = type === 'cron' && cronExpression
    ? describeCron(cronExpression) || cronExpression
    : INTERVAL_LABELS[type] || type;
  return (
    <span className={badge(INTERVAL_BADGE_VARIANT[type] || 'success')} title={type === 'cron' && cronExpression ? cronExpression : undefined}>
      {label}
    </span>
  );
}

function PromptEditor({ config, promptValue, setPromptValue, editingPrompt, setEditingPrompt, handleSavePrompt, updating, activeApps }) {
  const stages = config.taskMetadata?.pipeline?.stages;
  const stagePrompts = config.stagePrompts;
  const hasPipeline = stages?.length > 0 && stagePrompts?.length > 0;
  const [activeTab, setActiveTab] = useState(0);

  useEffect(() => {
    if (activeTab >= (stages?.length || 1)) setActiveTab(0);
  }, [stages?.length, activeTab]);

  if (!hasPipeline) {
    // Standard single prompt editor
    return (
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
              <button onClick={handleSavePrompt} disabled={updating} className="px-3 py-1.5 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded transition-colors">Save Prompt</button>
              <button onClick={() => { setPromptValue(config.prompt || ''); setEditingPrompt(false); }} disabled={updating} className="px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded transition-colors">Cancel</button>
            </div>
            {activeApps.length > 0 && (
              <p className="text-xs text-gray-500">
                Use <code className="bg-port-border px-1 rounded">{'{appName}'}</code> and <code className="bg-port-border px-1 rounded">{'{repoPath}'}</code> as placeholders.
              </p>
            )}
          </div>
        ) : (
          <div className="bg-port-bg border border-port-border rounded px-3 py-2 text-xs text-gray-400 font-mono max-h-32 overflow-y-auto cursor-pointer hover:border-port-accent/50" onClick={() => setEditingPrompt(true)} title="Click to edit prompt">
            <pre className="whitespace-pre-wrap">{promptValue || 'No prompt configured'}</pre>
          </div>
        )}
      </div>
    );
  }

  // Pipeline tabbed prompt viewer
  return (
    <div>
      <label className="text-sm text-gray-400 block mb-2">Stage Prompts</label>
      <div className="border border-port-border rounded-lg overflow-hidden">
        <div className="flex border-b border-port-border bg-port-card">
          {stages.map((stage, i) => (
            <button
              key={i}
              onClick={() => setActiveTab(i)}
              className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
                activeTab === i
                  ? 'text-purple-400 bg-purple-500/10 border-b-2 border-purple-400'
                  : 'text-gray-400 hover:text-gray-300 hover:bg-port-border/30'
              }`}
            >
              <span className="text-[10px] text-gray-500 mr-1">Stage {i + 1}</span>
              {stage.name}
              {stage.readOnly && <span className="ml-1 text-[10px] text-gray-500">(read-only)</span>}
            </button>
          ))}
        </div>
        <div className="bg-port-bg px-3 py-2 text-xs text-gray-400 font-mono max-h-64 overflow-y-auto">
          <pre className="whitespace-pre-wrap">{stagePrompts[activeTab] || 'No prompt configured'}</pre>
        </div>
      </div>
      <p className="text-xs text-gray-500 mt-2">Stage prompts use the default templates. Edit the main task prompt to override all stages with a single prompt.</p>
    </div>
  );
}

function PipelineStageConfig({ taskType, config, providers, onUpdate, updating, setUpdating }) {
  const stages = config.taskMetadata?.pipeline?.stages || [];

  const handleStageUpdate = async (stageIndex, field, value) => {
    setUpdating(true);
    const updatedStages = stages.map((stage, i) => {
      if (i !== stageIndex) return stage;
      const updated = { ...stage };
      if (value === '' || value === null) {
        delete updated[field];
      } else {
        updated[field] = value;
      }
      // When provider changes, clear model (it may not be valid for new provider)
      if (field === 'providerId') {
        delete updated.model;
      }
      return updated;
    });
    const updatedMeta = {
      ...config.taskMetadata,
      pipeline: { ...config.taskMetadata.pipeline, stages: updatedStages }
    };
    await onUpdate(taskType, { taskMetadata: updatedMeta }).catch(() => {});
    setUpdating(false);
  };

  return (
    <div>
      <h4 className="text-sm font-medium text-gray-400 mb-3">Pipeline Stages</h4>
      <div className="space-y-3">
        {stages.map((stage, i) => {
          const stageProvider = providers?.find(p => p.id === stage.providerId);
          const stageModels = stageProvider?.models || [];
          return (
            <div key={i} className="bg-port-card border border-port-border rounded-lg p-3">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs font-medium text-purple-400">Stage {i + 1}</span>
                {stage.readOnly && (
                  <span className="text-[10px] px-1 py-0.5 bg-gray-600/30 text-gray-400 rounded">read-only</span>
                )}
                <span className="text-sm text-white font-medium">{stage.name}</span>
                {i < stages.length - 1 && (
                  <span className="text-gray-500 ml-auto text-xs">→ Stage {i + 2}</span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Provider</label>
                  <select
                    value={stage.providerId || ''}
                    onChange={(e) => handleStageUpdate(i, 'providerId', e.target.value || null)}
                    disabled={updating}
                    className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-xs"
                  >
                    <option value="">Default (task-level)</option>
                    {providers?.map(provider => (
                      <option key={provider.id} value={provider.id}>{provider.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Model</label>
                  <select
                    value={stage.model || ''}
                    onChange={(e) => handleStageUpdate(i, 'model', e.target.value || null)}
                    disabled={updating}
                    className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-xs"
                  >
                    <option value="">Default (task-level)</option>
                    {stage.model && !stageModels.includes(stage.model) && (
                      <option value={stage.model}>{stage.model}</option>
                    )}
                    {stageModels.map(model => (
                      <option key={model} value={model}>{model}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-gray-500 mt-2">Each stage runs as a separate agent. Configure different providers per stage (e.g., Codex for review, Claude for implementation).</p>
    </div>
  );
}

function GlobalConfigControls({ taskType, config, onUpdate, onTrigger, onReset, category: _category, providers, apps, updating, setUpdating, allTaskTypes }) {
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

  const [cronEditing, setCronEditing] = useState(false);

  const handleTypeChange = async (newType) => {
    if (newType === 'cron') {
      setCronEditing(true);
      setSelectedType('cron');
      return;
    }
    setCronEditing(false);
    setUpdating(true);
    setSelectedType(newType);
    await onUpdate(taskType, { type: newType, cronExpression: null }).catch(() => {
      setSelectedType(config.type);
    });
    setUpdating(false);
  };

  const handleCronSave = async (expr) => {
    setUpdating(true);
    await onUpdate(taskType, { type: 'cron', cronExpression: expr }).catch(() => {
      setSelectedType(config.type);
    });
    setCronEditing(false);
    setUpdating(false);
  };

  const isPaused = !config.enabled;

  const handleToggleEnabled = async () => {
    setUpdating(true);
    await onUpdate(taskType, { enabled: isPaused });
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
        <div className="flex items-center gap-1.5">
          <label className="text-sm text-gray-400">Global Pause</label>
          <div className="group relative">
            <Info size={14} className="text-gray-500 cursor-help" />
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-3 py-2 bg-gray-800 border border-port-border text-xs text-gray-300 rounded-lg shadow-lg w-56 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity z-50">
              When paused, no scheduled runs will execute for this task — even if individual apps are enabled.
            </div>
          </div>
        </div>
        <ToggleSwitch
          enabled={isPaused}
          onChange={handleToggleEnabled}
          disabled={updating}
          ariaLabel={isPaused ? 'Resume runs' : 'Pause all runs'}
        />
      </div>
      {isPaused && (
        <div className="flex items-center gap-2 px-3 py-2 bg-port-warning/10 border border-port-warning/30 rounded text-xs text-port-warning">
          <AlertCircle size={14} className="shrink-0" />
          All scheduled runs are paused for this task
        </div>
      )}

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
          <option value="cron">Cron (custom schedule)</option>
        </select>
        {(selectedType === 'cron' && (cronEditing || config.type === 'cron')) ? (
          <CronInput
            value={config.cronExpression || '0 7 * * *'}
            onSave={handleCronSave}
            onCancel={() => { setCronEditing(false); setSelectedType(config.type); }}
            className="mt-2"
          />
        ) : (
          <p className="text-xs text-gray-500 mt-1">{INTERVAL_DESCRIPTIONS[selectedType]}</p>
        )}
      </div>

      {!config.taskMetadata?.pipeline?.stages?.length && (
        <>
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
        </>
      )}

      <PromptEditor
        config={config}
        promptValue={promptValue}
        setPromptValue={setPromptValue}
        editingPrompt={editingPrompt}
        setEditingPrompt={setEditingPrompt}
        handleSavePrompt={handleSavePrompt}
        updating={updating}
        activeApps={activeApps}
      />

      <div>
        <label className="text-sm text-gray-400 block mb-2">Agent Options</label>
        <div className="space-y-2">
          {AGENT_OPTIONS.map(({ field, label, description }) => {
            const enabled = config.taskMetadata?.[field] ?? false;
            const handleToggle = () => {
              if (!updating) onUpdate(taskType, { taskMetadata: toggleMetadataField(config.taskMetadata, field) });
            };
            return (
              <div
                key={field}
                role="button"
                tabIndex={updating ? -1 : 0}
                aria-disabled={updating}
                aria-pressed={enabled}
                aria-label={`${enabled ? 'Disable' : 'Enable'} ${label.toLowerCase()}`}
                className={`flex items-center justify-between gap-3 min-h-[44px] rounded px-2 -mx-2 ${updating ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:bg-port-card/30 active:bg-port-card/50'}`}
                onClick={handleToggle}
                onKeyDown={(e) => { if (!updating && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); handleToggle(); } }}
              >
                <div className="min-w-0 flex-1">
                  <span className="text-sm text-white">{label}</span>
                  <p className="text-xs text-gray-500">{description}</p>
                </div>
                <ToggleSwitch
                  enabled={enabled}
                  onChange={(e) => e.stopPropagation()}
                  disabled={updating}
                  tabIndex={-1}
                  ariaLabel={undefined}
                />
              </div>
            );
          })}
        </div>
      </div>

      {allTaskTypes?.length > 1 && (
        <div>
          <label className="text-sm text-gray-400 block mb-2">Run After (dependencies)</label>
          <div className="flex flex-wrap gap-2">
            {allTaskTypes.filter(t => t !== taskType).map(dep => {
              const isSelected = (config.runAfter || []).includes(dep);
              return (
                <button
                  key={dep}
                  onClick={() => {
                    const current = config.runAfter || [];
                    const updated = isSelected
                      ? current.filter(d => d !== dep)
                      : [...current, dep];
                    onUpdate(taskType, { runAfter: updated.length > 0 ? updated : null });
                  }}
                  disabled={updating}
                  className={`text-xs px-2 py-1 rounded border transition-colors ${
                    isSelected
                      ? 'bg-port-accent/20 border-port-accent/50 text-port-accent'
                      : 'bg-port-card border-port-border text-gray-400 hover:border-gray-500'
                  }`}
                >
                  {dep}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-gray-500 mt-1">This task will wait for selected tasks to complete first within the same cycle</p>
        </div>
      )}

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

const AppOverrideRow = memo(function AppOverrideRow({ app, taskType, globalIntervalType, globalTaskMetadata, override, onUpdate }) {
  const [updating, setUpdating] = useState(false);
  const [cronEditing, setCronEditing] = useState(false);
  const isEnabled = override?.enabled === true;
  const currentInterval = override?.interval || null;
  const hasCron = isCronExpression(currentInterval);

  const handleToggle = async () => {
    setUpdating(true);
    await onUpdate(app.id, taskType, { enabled: !isEnabled, interval: currentInterval }).catch(() => {});
    setUpdating(false);
  };

  const handleIntervalChange = async (newInterval) => {
    if (newInterval === 'cron') {
      setCronEditing(true);
      return;
    }
    setCronEditing(false);
    setUpdating(true);
    const interval = newInterval === '' ? null : newInterval;
    await onUpdate(app.id, taskType, { enabled: isEnabled, interval }).catch(() => {});
    setUpdating(false);
  };

  const handleCronSave = async (expr) => {
    setUpdating(true);
    await onUpdate(app.id, taskType, { enabled: isEnabled, interval: expr }).catch(() => {});
    setCronEditing(false);
    setUpdating(false);
  };

  const handleMetaToggle = async (field) => {
    setUpdating(true);
    const taskMetadata = toggleAppMetadataOverride(override?.taskMetadata, globalTaskMetadata, field);
    await onUpdate(app.id, taskType, { taskMetadata }).catch(() => {});
    setUpdating(false);
  };

  return (
    <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 sm:gap-3 py-2 px-3 rounded hover:bg-port-card/30">
      <div className="flex items-center gap-2 min-w-0 w-full sm:w-auto sm:flex-1">
        <AppIcon icon={app.icon || 'package'} appId={app.id} hasAppIcon={!!app.appIconPath} size={16} className="text-gray-400 shrink-0" />
        <span className="text-sm text-white truncate flex-1">{app.name}</span>
        <div className="sm:hidden">
          <ToggleSwitch
            enabled={isEnabled}
            onChange={handleToggle}
            disabled={updating}
            size="sm"
            ariaLabel={`${isEnabled ? 'Disable' : 'Enable'} ${taskType} for ${app.name}`}
          />
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          <select
            value={cronEditing || hasCron ? 'cron' : (currentInterval || '')}
            onChange={(e) => handleIntervalChange(e.target.value)}
            disabled={updating}
            className="bg-port-card border border-port-border rounded px-2 py-1.5 text-xs text-white min-w-[120px] min-h-[40px]"
          >
            <option value="">Inherit ({INTERVAL_LABELS[globalIntervalType] || globalIntervalType})</option>
            <option value="rotation">Rotation</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="once">Once</option>
            <option value="on-demand">On Demand</option>
            <option value="cron">Cron</option>
          </select>
          {cronEditing ? (
            <CronInput
              value={hasCron ? currentInterval : '0 7 * * *'}
              onSave={handleCronSave}
              onCancel={() => setCronEditing(false)}
            />
          ) : hasCron ? (
            <button
              onClick={() => setCronEditing(true)}
              className="px-2 py-1 text-xs text-gray-400 font-mono bg-port-bg border border-port-border rounded hover:border-port-accent cursor-pointer"
              title={describeCron(currentInterval)}
            >
              {currentInterval}
            </button>
          ) : null}
        </div>

        <div className="flex items-center gap-1">
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
                className={`text-xs px-2 py-1.5 rounded transition-colors shrink-0 min-h-[40px] min-w-[40px] border ${agentOptionButtonClass(effective, hasOverride)}`}
                title={`${label}: ${effective ? 'on' : 'off'}${hasOverride ? ' (app override)' : ' (inherited)'}`}
              >
                {shortLabel}
              </button>
            );
          })}
        </div>

        <div className="hidden sm:block">
          <ToggleSwitch
            enabled={isEnabled}
            onChange={handleToggle}
            disabled={updating}
            size="sm"
            ariaLabel={`${isEnabled ? 'Disable' : 'Enable'} ${taskType} for ${app.name}`}
          />
        </div>
      </div>
    </div>
  );
});

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

function AppTaskTypeRow({ taskType, config, onUpdate, onTrigger, onReset, providers, apps, onUpdateOverride, onBulkToggleOverride, allTaskTypes }) {
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
              <span className={badge('gray')}>Disabled</span>
            )}
            {config.status?.reason === 'waiting-on-dependencies' && (
              <span className={badge('warning')} title={`Waiting for: ${config.status.pendingDeps?.join(', ')}`}>
                Waiting on deps
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-500 flex-wrap">
            {config.globalLastRun && (
              <span>Last run: {new Date(config.globalLastRun).toLocaleDateString()} ({config.globalRunCount || 0} total)</span>
            )}
            {config.runAfter?.length > 0 && (
              <span className="text-gray-500">after: {config.runAfter.join(', ')}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {config.taskMetadata?.pipeline?.stages?.length > 0 && (
            <span className={badge('purple')} title={config.taskMetadata.pipeline.stages.map(s => s.name).join(' → ')}>
              <GitMerge size={11} className="inline mr-1" />
              {config.taskMetadata.pipeline.stages.length}-stage
            </span>
          )}
          {totalCount > 0 && (
            <span className={badge(
              enabledCount === totalCount ? 'success' :
              enabledCount === 0 ? 'error' : 'warning'
            )}>
              {enabledCount}/{totalCount} apps
            </span>
          )}
          <IntervalBadge type={config.type} cronExpression={config.cronExpression} />
        </div>
      </div>

      {expanded && (
        <div className="p-4 border-t border-port-border bg-port-bg/50 space-y-6">
          {config.taskMetadata?.pipeline?.stages?.length > 0 && (
            <PipelineStageConfig
              taskType={taskType}
              config={config}
              providers={providers}
              onUpdate={onUpdate}
              updating={updating}
              setUpdating={setUpdating}
            />
          )}

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
              allTaskTypes={allTaskTypes}
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
  const allTaskTypes = taskEntries.map(([taskType]) => taskType);

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
            allTaskTypes={allTaskTypes}
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
