import { useState, useEffect } from 'react';
import * as api from '../../../services/api';

export default function ConfigTab() {
  const [stats, setStats] = useState(null);
  const [agents, setAgents] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      const [agentsData, accountsData, scheduleStats] = await Promise.all([
        api.getAgentPersonalities(),
        api.getPlatformAccounts(),
        api.getScheduleStats()
      ]);
      setAgents(agentsData);
      setAccounts(accountsData);
      setStats(scheduleStats);
      setLoading(false);
    };
    fetchData();
  }, []);

  if (loading) {
    return <div className="p-4 text-gray-400">Loading config...</div>;
  }

  const enabledAgents = agents.filter(a => a.enabled).length;
  const activeAccounts = accounts.filter(a => a.status === 'active').length;

  return (
    <div className="p-4">
      <h2 className="text-lg font-semibold text-white mb-4">Configuration</h2>

      {/* Overview Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="p-4 bg-port-card border border-port-border rounded-lg">
          <div className="text-2xl font-bold text-white">{agents.length}</div>
          <div className="text-sm text-gray-400">Total Agents</div>
          <div className="text-xs text-port-success">{enabledAgents} enabled</div>
        </div>
        <div className="p-4 bg-port-card border border-port-border rounded-lg">
          <div className="text-2xl font-bold text-white">{accounts.length}</div>
          <div className="text-sm text-gray-400">Platform Accounts</div>
          <div className="text-xs text-port-success">{activeAccounts} active</div>
        </div>
        <div className="p-4 bg-port-card border border-port-border rounded-lg">
          <div className="text-2xl font-bold text-white">{stats?.total || 0}</div>
          <div className="text-sm text-gray-400">Schedules</div>
          <div className="text-xs text-port-success">{stats?.active || 0} running</div>
        </div>
        <div className="p-4 bg-port-card border border-port-border rounded-lg">
          <div className="text-2xl font-bold text-white">{stats?.totalRuns || 0}</div>
          <div className="text-sm text-gray-400">Total Runs</div>
          <div className="text-xs text-gray-500">all time</div>
        </div>
      </div>

      {/* Schedule Actions Breakdown */}
      {stats?.byAction && Object.keys(stats.byAction).length > 0 && (
        <div className="mb-6">
          <h3 className="text-md font-semibold text-white mb-3">Schedules by Action</h3>
          <div className="grid grid-cols-4 gap-2">
            {Object.entries(stats.byAction).map(([action, count]) => (
              <div key={action} className="p-3 bg-port-card border border-port-border rounded">
                <div className="text-lg font-bold text-white">{count}</div>
                <div className="text-sm text-gray-400 capitalize">{action}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Global Settings */}
      <div className="mb-6">
        <h3 className="text-md font-semibold text-white mb-3">Global Settings</h3>
        <div className="p-4 bg-port-card border border-port-border rounded-lg">
          <p className="text-gray-400 text-sm mb-4">
            Global agent settings will be available in a future update.
          </p>
          <div className="space-y-3 opacity-50">
            <div className="flex items-center justify-between">
              <span className="text-gray-300">Default Rate Limit (per day)</span>
              <input
                type="number"
                defaultValue={50}
                className="w-24 px-3 py-1 bg-port-bg border border-port-border rounded text-white text-right"
                disabled
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-300">Activity Log Retention (days)</span>
              <input
                type="number"
                defaultValue={30}
                className="w-24 px-3 py-1 bg-port-bg border border-port-border rounded text-white text-right"
                disabled
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-300">Enable Socket.IO Updates</span>
              <label className="relative inline-flex items-center cursor-not-allowed">
                <input type="checkbox" defaultChecked disabled className="sr-only peer" />
                <div className="w-11 h-6 bg-port-border rounded-full peer peer-checked:bg-port-accent"></div>
              </label>
            </div>
          </div>
        </div>
      </div>

      {/* Moltbook Rate Limits Info */}
      <div className="mb-6">
        <h3 className="text-md font-semibold text-white mb-3">Platform Rate Limits</h3>
        <div className="p-4 bg-port-card border border-port-border rounded-lg">
          <h4 className="text-white font-medium mb-2">📚 Moltbook</h4>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-gray-400">Posts</div>
              <div className="text-white">1 per 30 minutes</div>
            </div>
            <div>
              <div className="text-gray-400">Comments</div>
              <div className="text-white">1 per 20 seconds, 50/day</div>
            </div>
            <div>
              <div className="text-gray-400">Votes</div>
              <div className="text-white">1 per second, 200/day</div>
            </div>
          </div>
        </div>
      </div>

      {/* Documentation Links */}
      <div>
        <h3 className="text-md font-semibold text-white mb-3">Documentation</h3>
        <div className="p-4 bg-port-card border border-port-border rounded-lg">
          <ul className="space-y-2 text-sm">
            <li>
              <span className="text-gray-400">• Agent Personalities:</span>{' '}
              <span className="text-gray-300">Define unique AI personalities with custom tones and topics</span>
            </li>
            <li>
              <span className="text-gray-400">• Platform Accounts:</span>{' '}
              <span className="text-gray-300">Link agents to social platforms via API</span>
            </li>
            <li>
              <span className="text-gray-400">• Automation Schedules:</span>{' '}
              <span className="text-gray-300">Configure cron, interval, or random timing for actions</span>
            </li>
            <li>
              <span className="text-gray-400">• Activity Log:</span>{' '}
              <span className="text-gray-300">Monitor all agent actions with filtering</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
