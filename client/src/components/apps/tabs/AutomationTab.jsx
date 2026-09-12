import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { RefreshCw, Play, PauseCircle, Sparkles, AlertTriangle } from 'lucide-react';
import toast from '../../ui/Toast';
import BrailleSpinner from '../../BrailleSpinner';
import CronInput from '../../CronInput';
import ToggleSwitch from '../../ToggleSwitch';
import AppProviderPin from '../../cos/AppProviderPin';
import * as api from '../../../services/api';
import { AGENT_OPTIONS, hasProviderPin, providerPinDivergesFromSchedule, toggleAppMetadataOverride, agentOptionButtonClass } from '../../cos/constants';
import { isCronExpression, describeCron } from '../../../utils/cronHelpers';
import { PROVIDER_TYPES, providerDisplayName } from '../../../utils/providers';
import AppTaskCard from '../../cos/tabs/schedule/AppTaskCard';
import CustomTasksSection from './CustomTasksSection';

const RUNNABLE_PROVIDER_TYPES = Object.values(PROVIDER_TYPES);

const INTERVAL_OPTIONS = [
  { value: null, label: 'Inherit Global' },
  { value: 'on-demand', label: 'On Demand' },
  { value: 'cron', label: 'Scheduled' }
];

export default function AutomationTab({ appId, appName }) {
  const navigate = useNavigate();
  const [overrides, setOverrides] = useState({});
  const [schedule, setSchedule] = useState(null);
  const [providers, setProviders] = useState([]);
  const [providerCatalog, setProviderCatalog] = useState([]);
  const [activeProviderId, setActiveProviderId] = useState('');
  const [paused, setPaused] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
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
    setProviderCatalog(providersData?.providers || []);
    setActiveProviderId(providersData?.activeProvider || '');
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

  const saveOverride = async (taskType, patch) => {
    setSaving(true);
    const result = await api.updateAppTaskTypeOverride(appId, taskType, patch, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    setSaving(false);
    if (!result) return false;
    setOverrides(prev => ({ ...prev, [taskType]: { ...prev[taskType], ...patch } }));
    return true;
  };

  const handleToggle = async (taskType, isEnabled) => {
    const newEnabled = !isEnabled;
    await saveOverride(taskType, { enabled: newEnabled });
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
    await saveOverride(taskType, { interval: value });
  };

  const handleCronSave = async (taskType, expr) => {
    const saved = await saveOverride(taskType, { interval: expr });
    if (saved) setCronEditing(prev => { const n = { ...prev }; delete n[taskType]; return n; });
  };

  const handleMetaToggle = async (taskType, field, globalTaskMetadata) => {
    let taskMetadata = toggleAppMetadataOverride(overrides[taskType]?.taskMetadata, globalTaskMetadata, field);
    const globalConfig = schedule?.tasks?.[taskType] || {};
    const nextFileIssues = field === 'fileIssues'
      ? (taskMetadata?.fileIssues ?? globalTaskMetadata?.fileIssues ?? globalConfig.defaultFileIssues)
      : null;
    if (field === 'fileIssues' && nextFileIssues === true && taskMetadata) {
      taskMetadata = { ...taskMetadata, useWorktree: false, openPR: false, simplify: false };
    }
    await saveOverride(taskType, { taskMetadata });
  };

  // One mutation for the whole pin — AppProviderPin hands back an already
  // normalized { providerId, model }, so the clear rule lives in the control
  // rather than being re-derived here (#4783).
  const handlePinChange = async (taskType, patch) => {
    await saveOverride(taskType, patch);
  };

  const handleTrigger = async (taskType) => {
    const toastId = toast.loading(`Sending ${taskType} request for ${appName}…`);
    const result = await api.triggerCosOnDemandTask(taskType, appId, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    }).finally(() => toast.dismiss(toastId));
    if (result?.success) {
      toast.success(`Queued ${taskType} request for ${appName} — checks and available capacity determine when an agent appears`);
    }
    return result?.success ? result : null;
  };

  if (loading) {
    return <BrailleSpinner text="Loading automation settings" />;
  }

  const taskTypes = schedule?.tasks ? Object.keys(schedule.tasks).sort() : [];
  const allEnabled = taskTypes.length > 0 && taskTypes.every(t => (overrides[t] || {}).enabled === true);

  const handleToggleAll = async () => {
    setSaving(true);
    const newEnabled = !allEnabled;
    const result = await api.toggleAllAppTaskTypes(appId, newEnabled, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    setSaving(false);
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
      <div className="border-b border-port-border pb-4">
        <CustomTasksSection
          appId={appId}
          appName={appName}
          providerCatalog={providerCatalog}
          activeProviderId={activeProviderId}
        />
      </div>
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
            <h3 className="text-lg font-semibold text-white">Scheduled Task Options</h3>
            <p className="text-sm text-gray-500">
              Each toggle turns that CoS scheduled task on or off for this app. The controls beside it are optional —
              leave one on <em>Inherit</em> and it follows the global schedule defaults.
            </p>
          </div>
          <ToggleSwitch enabled={allEnabled} onChange={handleToggleAll} size="sm" activeColor="bg-port-success" disabled={saving} ariaLabel={allEnabled ? 'Disable every scheduled task for this app' : 'Enable every scheduled task for this app'} />
        </div>
        <button
          onClick={fetchData}
          disabled={saving}
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
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
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
            const isLayeredIntelligence = taskType === 'layered-intelligence';
            // The per-app pin outranks the task's Schedule pin at spawn for EVERY
            // task type (#4783), so it always counts toward "effective".
            const hasProviderOverride = hasProviderPin(override);
            const taskProviderName = globalConfig.providerId
              ? providerDisplayName(providers, globalConfig.providerId)
              : 'default (active provider)';
            const effectiveProviderName = override.providerId
              ? providerDisplayName(providers, override.providerId)
              : taskProviderName;
            // Surfaced collapsed (not just inside Configure): an app-level pin
            // silently wins over the Schedule pin at spawn (#4783), so a task
            // schedule showing one provider while this app's override names a
            // DIFFERENT one is exactly the "why did it run somewhere else"
            // confusion a user hits with only the Schedule page open.
            const providerDivergesFromSchedule = providerPinDivergesFromSchedule(override, globalConfig);

            return (
              <AppTaskCard
                key={`${appId}:${taskType}`}
                taskType={taskType}
                config={globalConfig}
                providers={providers}
                activeProviderId={activeProviderId}
                onConfigure={() => setExpandedTaskType(prev => prev === taskType ? null : taskType)}
                onTrigger={handleTrigger}
                appContext={{
                  enabled: isEnabled,
                  onToggle: () => handleToggle(taskType, isEnabled),
                  saving,
                  expanded: isExpanded,
                  interval: overrideInterval,
                  cadence: `${effectiveLabel}${intervalSuffix}`,
                  taskMetadata: override.taskMetadata,
                }}
              >
                {providerDivergesFromSchedule && (
                  <span className="inline-flex items-center gap-1 text-port-warning" title={`Runs on ${effectiveProviderName} — the schedule default is ${taskProviderName}`}>
                    <AlertTriangle size={11} />
                    <span className="text-[10px] uppercase tracking-wide">Provider override</span>
                  </span>
                )}
                {/* Row 2: interval + cron + agent options */}
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    aria-label="Override interval"
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
                  <div className="flex flex-wrap items-center gap-1">
                    {globalConfig.fileIssuesCapable && (() => {
                      const effective = override.taskMetadata?.fileIssues ?? globalConfig.taskMetadata?.fileIssues ?? globalConfig.defaultFileIssues === true;
                      const hasOverride = override.taskMetadata?.fileIssues !== undefined;
                      return (
                        <button
                          key="fileIssues"
                          onClick={() => handleMetaToggle(taskType, 'fileIssues', globalConfig.taskMetadata)}
                          aria-pressed={effective}
                          aria-label={`File issues only: ${effective ? 'on' : 'off'}${hasOverride ? ' (app override)' : ' (inherited)'}`}
                          className={`text-xs px-1.5 py-0.5 rounded transition-colors border ${agentOptionButtonClass(effective, hasOverride)}`}
                          title={`File issues only: ${effective ? 'on' : 'off'}${hasOverride ? ' (app override)' : ' (inherited)'}`}
                        >
                          Iss
                        </button>
                      );
                    })()}
                    {AGENT_OPTIONS.map(({ field, shortLabel, label }) => {
                      const effective = override.taskMetadata?.[field] ?? globalConfig.taskMetadata?.[field] ?? false;
                      const hasOverride = override.taskMetadata?.[field] !== undefined;
                      const fileIssuesOn = (override.taskMetadata?.fileIssues ?? globalConfig.taskMetadata?.fileIssues ?? globalConfig.defaultFileIssues) === true;
                      const managed = globalConfig.managedAgentOptions?.includes(field)
                        || (globalConfig.fileIssuesCapable && fileIssuesOn && ['useWorktree', 'openPR', 'simplify'].includes(field));
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
                    <AppProviderPin
                      providers={providers}
                      providerId={override.providerId}
                      model={override.model}
                      onChange={patch => handlePinChange(taskType, patch)}
                      label="Provider override"
                      inheritLabel={`Inherit (${taskProviderName})`}
                      layout="stacked"
                    />
                    <p className="text-xs text-gray-500">
                      Effective provider: <span className="text-gray-300">{effectiveProviderName}</span>
                      {hasProviderOverride ? ' (app override, wins over the task default)' : globalConfig.providerId ? ' (task default)' : ''}
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
              </AppTaskCard>
            );
          })}
        </div>
      )}


    </div>
  );
}
