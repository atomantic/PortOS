import { useState, useEffect, useRef } from 'react';
import { Play, RotateCcw, ChevronDown, AlertCircle, Package, Info } from 'lucide-react';
import CronInput from '../../../CronInput';
import { AGENT_OPTIONS, DEFAULT_REVIEW_STOP_MODE } from '../../constants';
import ReviewerPicker from '../../ReviewerPicker';
import Banner from '../../../ui/Banner';
import { useCodeReviewDefaults } from '../../../../hooks/useCodeReviewDefaults';
import ToggleSwitch from '../../../ToggleSwitch';
import { filterSelectableModels } from '../../../../utils/providers';
import PromptEditor from './PromptEditor';
import { INTERVAL_DESCRIPTIONS, IMPROVEMENT_DISABLED_TITLE, triggerButtonClass, toggleMetadataField } from './scheduleConstants';

export default function GlobalConfigControls({ taskType, config, onUpdate, onTrigger, onReset, category: _category, providers, apps, updating, setUpdating, allTaskTypes, improvementDisabled }) {
  const reviewDefaults = useCodeReviewDefaults();
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

  // Without this, an open dropdown survives a flip to disabled and pops back open when the master flag re-enables.
  useEffect(() => {
    if (improvementDisabled) setShowAppSelector(false);
  }, [improvementDisabled]);

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
  const availableModels = filterSelectableModels(selectedProvider?.models);
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
        <Banner icon={AlertCircle} align="center">
          All scheduled runs are paused for this task
        </Banner>
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
            const managed = config.managedAgentOptions?.includes(field);
            const lockedHint = `${label} is managed internally by this task — the agent's prompt handles it.`;
            return (
              <button
                key={field}
                type="button"
                disabled={updating || managed}
                aria-pressed={enabled}
                aria-label={managed
                  ? `${label} (managed by task)`
                  : `${enabled ? 'Disable' : 'Enable'} ${label.toLowerCase()}`}
                title={managed ? lockedHint : undefined}
                className={`w-full flex items-center justify-between gap-3 min-h-[44px] rounded px-2 -mx-2 text-left ${updating || managed ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:bg-port-card/30 active:bg-port-card/50'}`}
                onClick={() => onUpdate(taskType, { taskMetadata: toggleMetadataField(config.taskMetadata, field) })}
              >
                <div className="min-w-0 flex-1">
                  <span className="text-sm text-white flex items-center gap-2">
                    {label}
                    {managed && <span className="text-[10px] px-1 py-0.5 bg-gray-600/30 text-gray-400 rounded">managed</span>}
                  </span>
                  <p className="text-xs text-gray-500">{managed ? lockedHint : description}</p>
                </div>
                <ToggleSwitch
                  enabled={enabled}
                  disabled={updating || managed}
                  decorative
                />
              </button>
            );
          })}
        </div>
        {(config.taskMetadata?.reviewLoop || config.taskMetadata?.openPR) && (
          <div className="mt-3 pl-2">
            <ReviewerPicker
              reviewers={config.taskMetadata?.reviewers ?? (config.taskMetadata?.reviewer ? [config.taskMetadata.reviewer] : reviewDefaults.reviewers)}
              stopMode={config.taskMetadata?.reviewStopMode || reviewDefaults.stopMode || DEFAULT_REVIEW_STOP_MODE}
              reviewerApplies={config.taskMetadata?.reviewerApplies !== undefined
                ? (config.taskMetadata?.reviewerApplies === true || config.taskMetadata?.reviewerApplies === 'true')
                : reviewDefaults.reviewerApplies}
              disabled={updating}
              onChange={({ reviewers, stopMode, reviewerApplies }) => {
                // Drop the legacy single `reviewer` key so storage converges on `reviewers`.
                const { reviewer, ...rest } = config.taskMetadata || {};
                onUpdate(taskType, {
                  taskMetadata: { ...rest, reviewers, reviewStopMode: stopMode, reviewerApplies }
                });
              }}
            />
          </div>
        )}
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
            {/* Tooltip on the wrapper, not the button: most browsers skip hover events on disabled controls. */}
            <span title={improvementDisabled ? IMPROVEMENT_DISABLED_TITLE : 'Run this task on a specific app'} className="inline-block">
              <button
                onClick={() => !improvementDisabled && setShowAppSelector(!showAppSelector)}
                disabled={improvementDisabled}
                aria-disabled={improvementDisabled || undefined}
                className={triggerButtonClass(improvementDisabled)}
              >
                <Play size={14} />
                Run on App
                <ChevronDown size={12} className={`transition-transform ${showAppSelector ? 'rotate-180' : ''}`} />
              </button>
            </span>
            {showAppSelector && !improvementDisabled && (
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
          <span title={improvementDisabled ? IMPROVEMENT_DISABLED_TITLE : 'Run this task immediately (bypasses schedule)'} className="inline-block">
            <button
              onClick={() => onTrigger(taskType)}
              disabled={improvementDisabled}
              aria-disabled={improvementDisabled || undefined}
              className={triggerButtonClass(improvementDisabled)}
            >
              <Play size={14} />
              Run Now
            </button>
          </span>
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
