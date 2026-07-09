import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Play, PauseCircle, Settings, ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import toast from '../../ui/Toast';
import BrailleSpinner from '../../BrailleSpinner';
import CronInput from '../../CronInput';
import ToggleSwitch from '../../ToggleSwitch';
import ProviderModelSelector from '../../ProviderModelSelector';
import * as api from '../../../services/api';
import { AGENT_OPTIONS, toggleAppMetadataOverride, agentOptionButtonClass } from '../../cos/constants';
import { isCronExpression, describeCron } from '../../../utils/cronHelpers';
import { PROVIDER_TYPES, filterSelectableModels } from '../../../utils/providers';
import CustomTasksSection from './CustomTasksSection';

const RUNNABLE_PROVIDER_TYPES = Object.values(PROVIDER_TYPES);

const INTERVAL_OPTIONS = [
  { value: null, label: 'Inherit Global' },
  { value: 'rotation', label: 'Rotation' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'once', label: 'Once' },
  { value: 'on-demand', label: 'On-demand' },
  { value: 'cron', label: 'Cron' }
];

export default function AutomationTab({ appId, appName }) {
  const navigate = useNavigate();
  const [overrides, setOverrides] = useState({});
  const [schedule, setSchedule] = useState(null);
  const [providers, setProviders] = useState([]);
  const [paused, setPaused] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(null);
  const [cronEditing, setCronEditing] = useState({});
  // Only one Configure panel open at a time — a per-task disclosure holding the
  // per-app provider/model override (and, for layered-intelligence, a link to
  // the behavior config on the Edit App → Intelligence tab).
  const [expandedTaskType, setExpandedTaskType] = useState(null);

  const fetchData = useCallback(async () => {
    const [taskTypesData, scheduleData, statusData, providersData] = await Promise.all([
      api.getAppTaskTypes(appId).catch(() => ({ taskTypeOverrides: {} })),
      api.getCosSchedule().catch(() => null),
      api.getCosStatus().catch(() => null),
      api.getProviders({ silent: true }).catch(() => ({ providers: [] }))
    ]);
    setOverrides(taskTypesData.taskTypeOverrides || {});
    setSchedule(scheduleData);
    setPaused(statusData?.paused === true);
    // Every ENABLED provider of a runnable type (cli/tui/api) — handler-backed
    // tasks dispatch on provider.type, so any of them is a valid override.
    setProviders((providersData?.providers || []).filter(
      p => RUNNABLE_PROVIDER_TYPES.includes(p.type) && p.enabled !== false
    ));
    setLoading(false);
  }, [appId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleResume = async () => {
    setResuming(true);
    const result = await api.resumeCos({ silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    setResuming(false);
    if (result?.success) {
      setPaused(false);
      toast.success('Scheduled automation resumed');
    }
  };

  const handleToggle = async (taskType, isEnabled) => {
    const newEnabled = !isEnabled;
    await api.updateAppTaskTypeOverride(appId, taskType, { enabled: newEnabled }, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    setOverrides(prev => ({
      ...prev,
      [taskType]: { ...prev[taskType], enabled: newEnabled }
    }));
  };

  const handleIntervalChange = async (taskType, interval) => {
    if (interval === 'cron') {
      // Open cron editor — don't save until user enters expression
      const existing = overrides[taskType]?.interval;
      setCronEditing(prev => ({ ...prev, [taskType]: isCronExpression(existing) ? existing : '0 7 * * *' }));
      return;
    }
    setCronEditing(prev => { const n = { ...prev }; delete n[taskType]; return n; });
    const value = interval === 'null' ? null : interval;
    await api.updateAppTaskTypeOverride(appId, taskType, { interval: value }, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    setOverrides(prev => ({
      ...prev,
      [taskType]: { ...prev[taskType], interval: value }
    }));
  };

  const handleCronSave = async (taskType, expr) => {
    await api.updateAppTaskTypeOverride(appId, taskType, { interval: expr }, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    setOverrides(prev => ({
      ...prev,
      [taskType]: { ...prev[taskType], interval: expr }
    }));
    setCronEditing(prev => { const n = { ...prev }; delete n[taskType]; return n; });
  };

  const handleMetaToggle = async (taskType, field, globalTaskMetadata) => {
    const taskMetadata = toggleAppMetadataOverride(overrides[taskType]?.taskMetadata, globalTaskMetadata, field);
    await api.updateAppTaskTypeOverride(appId, taskType, { taskMetadata }, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    setOverrides(prev => ({
      ...prev,
      [taskType]: { ...prev[taskType], taskMetadata }
    }));
  };

  const handleProviderChange = async (taskType, newProviderId) => {
    // Picking a new provider clears any pinned model so a stale model from the
    // previous provider can't leak through. Empty → inherit the default.
    const providerId = newProviderId || null;
    await api.updateAppTaskTypeOverride(appId, taskType, { providerId, model: '' }, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    setOverrides(prev => ({
      ...prev,
      [taskType]: { ...prev[taskType], providerId, model: '' }
    }));
  };

  const handleModelChange = async (taskType, newModel) => {
    const model = newModel || '';
    await api.updateAppTaskTypeOverride(appId, taskType, { model }, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    setOverrides(prev => ({
      ...prev,
      [taskType]: { ...prev[taskType], model }
    }));
  };

  const handleTrigger = async (taskType) => {
    setTriggering(taskType);
    const result = await api.triggerCosOnDemandTask(taskType, appId, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    setTriggering(null);
    if (result?.success) {
      toast.success(`Triggered ${taskType} for ${appName}`);
    }
  };

  if (loading) {
    return <BrailleSpinner text="Loading automation settings" />;
  }

  const taskTypes = schedule?.tasks ? Object.keys(schedule.tasks).sort() : [];
  const allEnabled = taskTypes.length > 0 && taskTypes.every(t => (overrides[t] || {}).enabled === true);

  const handleToggleAll = async () => {
    const newEnabled = !allEnabled;
    const result = await api.toggleAllAppTaskTypes(appId, newEnabled, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (!result) return;
    setOverrides(prev => {
      const updated = { ...prev };
      for (const t of taskTypes) {
        updated[t] = { ...updated[t], enabled: newEnabled };
      }
      return updated;
    });
  };

  return (
    <div className="max-w-5xl space-y-4">
      {paused && (
        <div className="bg-port-warning/10 border border-port-warning/40 rounded-lg p-3 flex items-start gap-3">
          <PauseCircle size={18} className="text-port-warning shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-port-warning">Scheduled automation is globally paused</p>
            <p className="text-xs text-gray-400 mt-0.5">
              Scheduled and autonomous tasks won&apos;t run until resumed. You can still trigger an enabled task manually with <span className="text-gray-300">Run</span>.
            </p>
          </div>
          <button
            onClick={handleResume}
            disabled={resuming}
            className="px-3 py-1.5 bg-port-warning/20 text-port-warning hover:bg-port-warning/30 rounded-lg text-xs font-medium flex items-center gap-1 disabled:opacity-50 shrink-0"
          >
            <Play size={14} />
            {resuming ? 'Resuming…' : 'Resume'}
          </button>
        </div>
      )}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div>
            <h3 className="text-lg font-semibold text-white">Task Type Overrides</h3>
            <p className="text-sm text-gray-500">Per-app automation preferences for CoS task scheduling</p>
          </div>
          <ToggleSwitch enabled={allEnabled} onChange={handleToggleAll} size="sm" activeColor="bg-port-success" ariaLabel={allEnabled ? 'Disable all automations' : 'Enable all automations'} />
        </div>
        <button
          onClick={fetchData}
          className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-xs flex items-center gap-1"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {taskTypes.length === 0 ? (
        <div className="bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-500">
          No task types configured in the schedule
        </div>
      ) : (
        <div className="space-y-2">
          {taskTypes.map(taskType => {
            const override = overrides[taskType] || {};
            const globalConfig = schedule.tasks[taskType] || {};
            const isEnabled = override.enabled === true;
            const overrideInterval = override.interval || null;
            const effectiveLabel = isCronExpression(overrideInterval)
              ? describeCron(overrideInterval) || 'cron'
              : overrideInterval || (globalConfig.type || 'rotation');
            const intervalSuffix = !overrideInterval && globalConfig.intervalMs ? ` (${Math.round(globalConfig.intervalMs / 3600000)}h)` : '';
            const isExpanded = expandedTaskType === taskType;
            const overrideProviderId = override.providerId || '';
            const overrideModel = override.model || '';
            const selectedProvider = providers.find(p => p.id === overrideProviderId);
            const availableModels = filterSelectableModels(selectedProvider?.models);
            // Keep a pinned model visible even when it's not in the provider's
            // fetched list (avoids a blanked select on a stale/custom model).
            const modelOptions = overrideModel && !availableModels.includes(overrideModel)
              ? [overrideModel, ...availableModels]
              : availableModels;
            const effectiveProviderId = override.providerId || globalConfig.providerId || null;
            const effectiveProviderName = effectiveProviderId
              ? (providers.find(p => p.id === effectiveProviderId)?.name || effectiveProviderId)
              : 'default (active provider)';
            const isLayeredIntelligence = taskType === 'layered-intelligence';

            return (
              <div key={taskType} className="bg-port-card border border-port-border rounded-lg p-3 space-y-2">
                {/* Row 1: name + toggle + configure + run now */}
                <div className="flex items-center gap-3">
                  <ToggleSwitch enabled={isEnabled} onChange={() => handleToggle(taskType, isEnabled)} size="sm" activeColor="bg-port-success" />
                  <div className="flex-1 min-w-0">
                    <span className="text-white font-mono text-xs">{taskType}</span>
                    <div className="text-xs text-gray-500">{effectiveLabel}{intervalSuffix}</div>
                  </div>
                  <button
                    onClick={() => setExpandedTaskType(prev => prev === taskType ? null : taskType)}
                    aria-expanded={isExpanded}
                    aria-label={`${isExpanded ? 'Hide' : 'Show'} provider and model overrides for ${taskType}`}
                    className="px-2 py-1 bg-port-border/60 text-gray-300 hover:bg-port-border rounded text-xs inline-flex items-center gap-1 shrink-0"
                  >
                    {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <Settings size={12} />
                    Configure
                  </button>
                  <button
                    onClick={() => handleTrigger(taskType)}
                    disabled={triggering === taskType || !isEnabled}
                    className="px-2 py-1 bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded text-xs disabled:opacity-50 inline-flex items-center gap-1 shrink-0"
                  >
                    <Play size={12} />
                    {triggering === taskType ? '...' : 'Run'}
                  </button>
                </div>
                {/* Row 2: interval + cron + agent options */}
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={cronEditing[taskType] !== undefined || isCronExpression(overrideInterval) ? 'cron' : (overrideInterval ?? 'null')}
                    onChange={e => handleIntervalChange(taskType, e.target.value)}
                    className="px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-white focus:border-port-accent focus:outline-hidden"
                  >
                    {INTERVAL_OPTIONS.map(opt => (
                      <option key={String(opt.value)} value={String(opt.value)}>{opt.label}</option>
                    ))}
                  </select>
                  {cronEditing[taskType] !== undefined ? (
                    <CronInput
                      value={cronEditing[taskType]}
                      onSave={expr => handleCronSave(taskType, expr)}
                      onCancel={() => setCronEditing(prev => { const n = { ...prev }; delete n[taskType]; return n; })}
                    />
                  ) : isCronExpression(overrideInterval) ? (
                    <button
                      onClick={() => setCronEditing(prev => ({ ...prev, [taskType]: overrideInterval }))}
                      className="px-2 py-1 text-xs text-gray-400 font-mono bg-port-bg border border-port-border rounded hover:border-port-accent cursor-pointer"
                      title={describeCron(overrideInterval)}
                    >
                      {overrideInterval}
                    </button>
                  ) : null}
                  <div className="flex items-center gap-1 ml-auto">
                    {AGENT_OPTIONS.map(({ field, shortLabel, label }) => {
                      const effective = override.taskMetadata?.[field] ?? globalConfig.taskMetadata?.[field] ?? false;
                      const hasOverride = override.taskMetadata?.[field] !== undefined;
                      const managed = globalConfig.managedAgentOptions?.includes(field);
                      const titleText = managed
                        ? `${label}: managed internally by ${taskType}`
                        : `${label}: ${effective ? 'on' : 'off'}${hasOverride ? ' (app override)' : ' (inherited)'}`;
                      return (
                        <button
                          key={field}
                          onClick={() => handleMetaToggle(taskType, field, globalConfig.taskMetadata)}
                          disabled={managed}
                          aria-pressed={effective}
                          aria-label={managed
                            ? `${label}: managed by task`
                            : `${label}: ${effective ? 'on' : 'off'}${hasOverride ? ' (app override)' : ' (inherited)'}`}
                          className={`text-xs px-1.5 py-0.5 rounded transition-colors border ${agentOptionButtonClass(effective, hasOverride)} ${managed ? 'opacity-50 cursor-not-allowed' : ''}`}
                          title={titleText}
                        >
                          {shortLabel}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {/* Expanded config: per-app provider/model override (+ LI behavior link) */}
                {isExpanded && (
                  <div className="border-t border-port-border pt-3 space-y-3">
                    <ProviderModelSelector
                      providers={providers}
                      selectedProviderId={overrideProviderId}
                      selectedModel={overrideModel}
                      availableModels={modelOptions}
                      onProviderChange={id => handleProviderChange(taskType, id)}
                      onModelChange={model => handleModelChange(taskType, model)}
                      label="Provider override"
                      emptyProviderOption="Use default provider"
                      emptyModelOption="Default model"
                      alwaysShowModel
                      layout="stacked"
                    />
                    <p className="text-xs text-gray-500">
                      Effective provider: <span className="text-gray-300">{effectiveProviderName}</span>
                      {override.providerId ? ' (app override)' : globalConfig.providerId ? ' (task default)' : ''}
                    </p>
                    {isLayeredIntelligence && (
                      <div className="pt-1">
                        <button
                          onClick={() => navigate(`/apps/${appId}?edit=1&appTab=intelligence`)}
                          className="inline-flex items-center gap-1 text-xs text-port-accent hover:underline"
                        >
                          <Sparkles size={12} />
                          Configure behavior (sources, scopes, rules) →
                        </button>
                        <p className="text-xs text-gray-500 mt-1">
                          Telemetry sources, allowed scopes, and guidance rules live on the Edit App → Intelligence tab.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="border-t border-port-border pt-4">
        <CustomTasksSection appId={appId} appName={appName} />
      </div>
    </div>
  );
}
