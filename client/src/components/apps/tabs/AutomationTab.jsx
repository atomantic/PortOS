import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Play } from 'lucide-react';
import toast from 'react-hot-toast';
import BrailleSpinner from '../../BrailleSpinner';
import CronInput from '../../CronInput';
import * as api from '../../../services/api';
import { AGENT_OPTIONS, toggleAppMetadataOverride } from '../../cos/constants';
import { isCronExpression, describeCron } from '../../../utils/cronHelpers';

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
  const [overrides, setOverrides] = useState({});
  const [schedule, setSchedule] = useState(null);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(null);
  const [cronEditing, setCronEditing] = useState({});

  const fetchData = useCallback(async () => {
    const [taskTypesData, scheduleData] = await Promise.all([
      api.getAppTaskTypes(appId).catch(() => ({ taskTypeOverrides: {} })),
      api.getCosSchedule().catch(() => null)
    ]);
    setOverrides(taskTypesData.taskTypeOverrides || {});
    setSchedule(scheduleData);
    setLoading(false);
  }, [appId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleToggle = async (taskType, isEnabled) => {
    const newEnabled = !isEnabled;
    await api.updateAppTaskTypeOverride(appId, taskType, { enabled: newEnabled }).catch(err => {
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
    await api.updateAppTaskTypeOverride(appId, taskType, { interval: value }).catch(err => {
      toast.error(err.message);
      return null;
    });
    setOverrides(prev => ({
      ...prev,
      [taskType]: { ...prev[taskType], interval: value }
    }));
  };

  const handleCronSave = async (taskType, expr) => {
    await api.updateAppTaskTypeOverride(appId, taskType, { interval: expr }).catch(err => {
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
    await api.updateAppTaskTypeOverride(appId, taskType, { taskMetadata }).catch(err => {
      toast.error(err.message);
      return null;
    });
    setOverrides(prev => ({
      ...prev,
      [taskType]: { ...prev[taskType], taskMetadata }
    }));
  };

  const handleTrigger = async (taskType) => {
    setTriggering(taskType);
    const result = await api.triggerCosOnDemandTask(taskType, appId).catch(err => {
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
    await api.toggleAllAppTaskTypes(appId, newEnabled).catch(err => {
      toast.error(err.message);
      return null;
    });
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
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div>
            <h3 className="text-lg font-semibold text-white">Task Type Overrides</h3>
            <p className="text-sm text-gray-500">Per-app automation preferences for CoS task scheduling</p>
          </div>
          <button
            onClick={handleToggleAll}
            className={`w-10 h-5 rounded-full transition-colors relative shrink-0 ${
              allEnabled ? 'bg-port-success' : 'bg-gray-600'
            }`}
            title={allEnabled ? 'Disable all automations' : 'Enable all automations'}
          >
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              allEnabled ? 'left-5' : 'left-0.5'
            }`} />
          </button>
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

            return (
              <div key={taskType} className="bg-port-card border border-port-border rounded-lg p-3 space-y-2">
                {/* Row 1: name + toggle + run now */}
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => handleToggle(taskType, isEnabled)}
                    className={`w-10 h-5 rounded-full transition-colors relative shrink-0 ${
                      isEnabled ? 'bg-port-success' : 'bg-gray-600'
                    }`}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                      isEnabled ? 'left-5' : 'left-0.5'
                    }`} />
                  </button>
                  <div className="flex-1 min-w-0">
                    <span className="text-white font-mono text-xs">{taskType}</span>
                    <div className="text-xs text-gray-500">{effectiveLabel}{intervalSuffix}</div>
                  </div>
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
                      return (
                        <button
                          key={field}
                          onClick={() => handleMetaToggle(taskType, field, globalConfig.taskMetadata)}
                          aria-pressed={effective}
                          aria-label={`${label}: ${effective ? 'on' : 'off'}${hasOverride ? ' (app override)' : ' (inherited)'}`}
                          className={`text-xs px-1.5 py-0.5 rounded transition-colors ${
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
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
