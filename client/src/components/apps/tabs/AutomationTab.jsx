import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Play } from 'lucide-react';
import toast from 'react-hot-toast';
import BrailleSpinner from '../../BrailleSpinner';
import * as api from '../../../services/api';
import { AGENT_OPTIONS, toggleAppMetadataOverride } from '../../cos/constants';

const INTERVAL_OPTIONS = [
  { value: null, label: 'Inherit Global' },
  { value: 'rotation', label: 'Rotation' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'once', label: 'Once' },
  { value: 'on-demand', label: 'On-demand' }
];

export default function AutomationTab({ appId, appName }) {
  const [overrides, setOverrides] = useState({});
  const [schedule, setSchedule] = useState(null);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(null);

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

  const handleToggle = async (taskType, currentEnabled) => {
    const newEnabled = currentEnabled === false;
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

  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white">Task Type Overrides</h3>
          <p className="text-sm text-gray-500">Per-app automation preferences for CoS task scheduling</p>
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
        <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-port-border">
                  <th className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wide font-medium">Task Type</th>
                  <th className="text-center px-4 py-3 text-xs text-gray-500 uppercase tracking-wide font-medium">Enabled</th>
                  <th className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wide font-medium">Interval</th>
                  <th className="text-center px-4 py-3 text-xs text-gray-500 uppercase tracking-wide font-medium cursor-help" title="Bright = app override on, Dim = inherited from global, Gray = app override off">Agent Options</th>
                  <th className="text-right px-4 py-3 text-xs text-gray-500 uppercase tracking-wide font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {taskTypes.map(taskType => {
                  const override = overrides[taskType] || {};
                  const globalConfig = schedule.tasks[taskType] || {};
                  const isEnabled = override.enabled !== false;
                  const overrideInterval = override.interval || null;

                  return (
                    <tr key={taskType} className="border-b border-port-border/50 hover:bg-white/5">
                      <td className="px-4 py-3">
                        <div>
                          <span className="text-white font-mono text-xs">{taskType}</span>
                          <div className="text-xs text-gray-500">{globalConfig.type || 'rotation'}{globalConfig.intervalMs ? ` (${Math.round(globalConfig.intervalMs / 3600000)}h)` : ''}</div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <button
                          onClick={() => handleToggle(taskType, override.enabled)}
                          className={`w-10 h-5 rounded-full transition-colors relative ${
                            isEnabled ? 'bg-port-success' : 'bg-gray-600'
                          }`}
                        >
                          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                            isEnabled ? 'left-5' : 'left-0.5'
                          }`} />
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <select
                          value={overrideInterval ?? 'null'}
                          onChange={e => handleIntervalChange(taskType, e.target.value)}
                          className="px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-white focus:border-port-accent focus:outline-hidden"
                        >
                          {INTERVAL_OPTIONS.map(opt => (
                            <option key={String(opt.value)} value={String(opt.value)}>{opt.label}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-center gap-1">
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
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => handleTrigger(taskType)}
                          disabled={triggering === taskType || !isEnabled}
                          className="px-2 py-1 bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded text-xs disabled:opacity-50 inline-flex items-center gap-1"
                        >
                          <Play size={12} />
                          {triggering === taskType ? '...' : 'Run Now'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
