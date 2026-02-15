import { useState, useEffect, useCallback } from 'react';
import * as api from '../../../services/api';
import { ACTION_TYPES, SCHEDULE_TYPES, CRON_PRESETS, INTERVAL_PRESETS } from '../constants';

export default function SchedulesTab({ agentId }) {
  const [schedules, setSchedules] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    agentId: agentId,
    accountId: '',
    action: { type: 'heartbeat', params: {} },
    schedule: { type: 'interval', intervalMs: 4 * 60 * 60 * 1000 },
    rateLimit: { maxPerDay: 50 },
    enabled: true
  });
  const [runningId, setRunningId] = useState(null);

  const fetchData = useCallback(async () => {
    const [schedulesData, accountsData, statsData] = await Promise.all([
      api.getAutomationSchedules(agentId),
      api.getPlatformAccounts(agentId),
      api.getScheduleStats()
    ]);
    setSchedules(schedulesData);
    setAccounts(accountsData);
    setStats(statsData);
    setLoading(false);
  }, [agentId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const resetForm = () => {
    setFormData({
      agentId: agentId,
      accountId: '',
      action: { type: 'heartbeat', params: {} },
      schedule: { type: 'interval', intervalMs: 4 * 60 * 60 * 1000 },
      rateLimit: { maxPerDay: 50 },
      enabled: true
    });
    setShowForm(false);
  };

  const handleScheduleTypeChange = (type) => {
    const scheduleDefaults = {
      cron: { type: 'cron', cron: '0 */4 * * *' },
      interval: { type: 'interval', intervalMs: 4 * 60 * 60 * 1000 },
      random: { type: 'random', randomWindow: { minMs: 60 * 60 * 1000, maxMs: 4 * 60 * 60 * 1000 } }
    };
    setFormData(prev => ({
      ...prev,
      schedule: scheduleDefaults[type]
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    await api.createAutomationSchedule(formData);
    resetForm();
    fetchData();
  };

  const handleDelete = async (id) => {
    await api.deleteAutomationSchedule(id);
    fetchData();
  };

  const handleToggle = async (id, enabled) => {
    await api.toggleAutomationSchedule(id, enabled);
    fetchData();
  };

  const handleRunNow = async (id) => {
    setRunningId(id);
    await api.runAutomationScheduleNow(id);
    setRunningId(null);
    fetchData();
  };

  const getAccountName = (accountId) => {
    const account = accounts.find(a => a.id === accountId);
    return account?.credentials?.username || 'Unknown';
  };

  const filteredAccounts = accounts.filter(a => a.status === 'active');

  // Filter action types by the selected account's platform
  const selectedAccount = accounts.find(a => a.id === formData.accountId);
  const selectedPlatform = selectedAccount?.platform;
  const filteredActionTypes = selectedPlatform
    ? ACTION_TYPES.filter(a => a.platform === selectedPlatform)
    : ACTION_TYPES.filter(a => a.platform === 'moltbook');

  const formatSchedule = (schedule) => {
    if (schedule.type === 'cron') {
      const preset = CRON_PRESETS.find(p => p.value === schedule.cron);
      return preset?.label || schedule.cron;
    }
    if (schedule.type === 'interval') {
      const preset = INTERVAL_PRESETS.find(p => p.value === schedule.intervalMs);
      return preset?.label || `${Math.round(schedule.intervalMs / 60000)} min`;
    }
    if (schedule.type === 'random') {
      const minHrs = Math.round(schedule.randomWindow.minMs / 3600000 * 10) / 10;
      const maxHrs = Math.round(schedule.randomWindow.maxMs / 3600000 * 10) / 10;
      return `${minHrs}-${maxHrs} hours`;
    }
    return 'Unknown';
  };

  if (loading) {
    return <div className="p-4 text-gray-400">Loading schedules...</div>;
  }

  return (
    <div className="p-4">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Automation Schedules</h2>
          {stats && (
            <p className="text-sm text-gray-400">
              {schedules.filter(s => s.enabled).length} enabled / {schedules.length} total
            </p>
          )}
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 bg-port-accent text-white rounded hover:bg-port-accent/80"
          disabled={filteredAccounts.length === 0}
        >
          {showForm ? 'Cancel' : '+ New Schedule'}
        </button>
      </div>

      {filteredAccounts.length === 0 && (
        <div className="mb-4 p-4 bg-port-warning/20 border border-port-warning/50 rounded text-port-warning">
          You need at least one active platform account to create schedules.
        </div>
      )}

      {showForm && (
        <form onSubmit={handleSubmit} className="mb-6 p-4 bg-port-card border border-port-border rounded-lg">
          <h3 className="text-md font-semibold text-white mb-4">Create Schedule</h3>

          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Account</label>
              <select
                value={formData.accountId}
                onChange={(e) => {
                  const acct = accounts.find(a => a.id === e.target.value);
                  const platform = acct?.platform;
                  const defaultAction = platform === 'moltworld' ? 'mw_heartbeat' : 'heartbeat';
                  setFormData({ ...formData, accountId: e.target.value, action: { type: defaultAction, params: {} } });
                }}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                required
              >
                <option value="">Select account...</option>
                {filteredAccounts.map(account => (
                  <option key={account.id} value={account.id}>
                    {account.credentials.username} ({account.platform})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Action Type</label>
              <select
                value={formData.action.type}
                onChange={(e) => setFormData({ ...formData, action: { type: e.target.value, params: {} } })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              >
                {filteredActionTypes.map(action => (
                  <option key={action.value} value={action.value}>
                    {action.icon} {action.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500 mt-1">
                {ACTION_TYPES.find(a => a.value === formData.action.type)?.description}
              </p>
            </div>
          </div>

          <div className="mb-4">
            <label className="block text-sm text-gray-400 mb-1">Schedule Type</label>
            <select
              value={formData.schedule.type}
              onChange={(e) => handleScheduleTypeChange(e.target.value)}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
            >
              {SCHEDULE_TYPES.map(type => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
          </div>

          {formData.schedule.type === 'cron' && (
            <div className="mb-4">
              <label className="block text-sm text-gray-400 mb-1">Cron Expression</label>
              <select
                value={formData.schedule.cron}
                onChange={(e) => setFormData({ ...formData, schedule: { ...formData.schedule, cron: e.target.value } })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              >
                {CRON_PRESETS.map(preset => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {formData.schedule.type === 'interval' && (
            <div className="mb-4">
              <label className="block text-sm text-gray-400 mb-1">Interval</label>
              <select
                value={formData.schedule.intervalMs}
                onChange={(e) => setFormData({ ...formData, schedule: { ...formData.schedule, intervalMs: parseInt(e.target.value) } })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              >
                {INTERVAL_PRESETS.map(preset => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {formData.schedule.type === 'random' && (
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Min Interval</label>
                <select
                  value={formData.schedule.randomWindow?.minMs}
                  onChange={(e) => setFormData({
                    ...formData,
                    schedule: {
                      ...formData.schedule,
                      randomWindow: { ...formData.schedule.randomWindow, minMs: parseInt(e.target.value) }
                    }
                  })}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                >
                  {INTERVAL_PRESETS.map(preset => (
                    <option key={preset.value} value={preset.value}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Max Interval</label>
                <select
                  value={formData.schedule.randomWindow?.maxMs}
                  onChange={(e) => setFormData({
                    ...formData,
                    schedule: {
                      ...formData.schedule,
                      randomWindow: { ...formData.schedule.randomWindow, maxMs: parseInt(e.target.value) }
                    }
                  })}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                >
                  {INTERVAL_PRESETS.map(preset => (
                    <option key={preset.value} value={preset.value}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <div className="mb-4">
            <label className="block text-sm text-gray-400 mb-1">Max Per Day (rate limit)</label>
            <input
              type="number"
              value={formData.rateLimit.maxPerDay || 50}
              onChange={(e) => setFormData({ ...formData, rateLimit: { ...formData.rateLimit, maxPerDay: parseInt(e.target.value) } })}
              className="w-32 px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              min="1"
              max="1000"
            />
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              className="px-4 py-2 bg-port-success text-white rounded hover:bg-port-success/80"
            >
              Create Schedule
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="px-4 py-2 bg-port-border text-gray-300 rounded hover:bg-port-border/80"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {schedules.length === 0 ? (
        <div className="text-center py-8 text-gray-400">
          <p className="text-lg mb-2">No schedules</p>
          <p className="text-sm">Create a schedule to automate agent actions</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {schedules.map(schedule => {
            const actionType = ACTION_TYPES.find(a => a.value === schedule.action?.type);

            return (
              <div
                key={schedule.id}
                className={`p-4 bg-port-card border rounded-lg ${schedule.enabled ? 'border-port-border' : 'border-port-border/50 opacity-60'}`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xl">{actionType?.icon || '📅'}</span>
                      <h3 className="font-semibold text-white">
                        {actionType?.label || schedule.action?.type}
                      </h3>
                      {schedule.isActive && (
                        <span className="text-xs px-2 py-0.5 rounded bg-port-success/20 text-port-success">
                          Active
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-gray-400">
                      {getAccountName(schedule.accountId)}
                    </p>
                    <p className="text-sm text-gray-500 mt-1">
                      {formatSchedule(schedule.schedule)} • Max {schedule.rateLimit?.maxPerDay || '∞'}/day
                    </p>
                    {schedule.lastRun && (
                      <p className="text-xs text-gray-500 mt-1">
                        Last run: {new Date(schedule.lastRun).toLocaleString()} ({schedule.runCount} total)
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleRunNow(schedule.id)}
                      disabled={runningId === schedule.id}
                      className="px-3 py-1 text-xs bg-port-accent/20 text-port-accent rounded hover:bg-port-accent/30 disabled:opacity-50"
                    >
                      {runningId === schedule.id ? 'Running...' : 'Run Now'}
                    </button>
                    <button
                      onClick={() => handleToggle(schedule.id, !schedule.enabled)}
                      className={`px-3 py-1 text-xs rounded ${
                        schedule.enabled
                          ? 'bg-port-success/20 text-port-success'
                          : 'bg-port-border text-gray-400'
                      }`}
                    >
                      {schedule.enabled ? 'Enabled' : 'Disabled'}
                    </button>
                    <button
                      onClick={() => handleDelete(schedule.id)}
                      className="px-3 py-1 text-xs bg-port-error/20 text-port-error rounded hover:bg-port-error/30"
                    >
                      Delete
                    </button>
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
