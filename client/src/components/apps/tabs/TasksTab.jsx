import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router';
import { RefreshCw, Clock, Activity } from 'lucide-react';
import BrailleSpinner from '../../BrailleSpinner';
import TaskAddForm from '../../cos/TaskAddForm';
import * as api from '../../../services/api';
import { formatDurationMs, formatTime } from '../../../utils/formatters';

const STATUS_CONFIG = {
  running: { color: 'bg-port-accent', text: 'Running' },
  spawning: { color: 'bg-port-warning', text: 'Spawning' },
  completed: { color: 'bg-port-success', text: 'Completed' },
  failed: { color: 'bg-port-error', text: 'Failed' },
  error: { color: 'bg-port-error', text: 'Error' },
  cancelled: { color: 'bg-gray-500', text: 'Cancelled' }
};


export default function TasksTab({ appId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [providers, setProviders] = useState([]);
  const [apps, setApps] = useState([]);

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    const result = await api.getAppAgents(appId).catch(() => ({ agents: [], summary: {} }));
    setData(result);
    setLoading(false);
  }, [appId]);

  useEffect(() => {
    let active = true;
    fetchAgents();
    // Fetch providers and apps for the task add form
    api.getProviders().catch(() => ({ providers: [] }))
      .then(d => { if (active) setProviders(d.providers || []); });
    api.getApps().catch(() => [])
      .then(a => { if (active) setApps((a || []).filter(app => app.id !== 'portos-autofixer')); });
    return () => { active = false; };
  }, [appId, fetchAgents]);

  if (loading) {
    return <BrailleSpinner text="Loading agent history" />;
  }

  const { agents = [], summary = {} } = data || {};
  const successRate = summary.total > 0
    ? Math.round((summary.succeeded / summary.total) * 100)
    : 0;

  return (
    <div className="w-full min-w-0 space-y-4">
      {/* Add Task Form */}
      <TaskAddForm
        providers={providers}
        apps={apps}
        onTaskAdded={fetchAgents}
        compact
        defaultApp={appId}
      />

      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-white">Recent Agent Tasks</h3>
        <button
          onClick={fetchAgents}
          className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-xs flex items-center gap-1"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-port-card border border-port-border rounded-lg p-3 text-center">
          <div className="text-2xl font-bold text-white">{summary.total || 0}</div>
          <div className="text-xs text-gray-500">Total</div>
        </div>
        <div className="bg-port-card border border-port-border rounded-lg p-3 text-center">
          <div className="text-2xl font-bold text-port-accent">{summary.running || 0}</div>
          <div className="text-xs text-gray-500">Running</div>
        </div>
        <div className="bg-port-card border border-port-border rounded-lg p-3 text-center">
          <div className="text-2xl font-bold text-port-success">{summary.succeeded || 0}</div>
          <div className="text-xs text-gray-500">Succeeded</div>
        </div>
        <div className="bg-port-card border border-port-border rounded-lg p-3 text-center">
          <div className="text-2xl font-bold text-white">{successRate}%</div>
          <div className="text-xs text-gray-500">Success Rate</div>
        </div>
      </div>

      {/* Agent List */}
      {agents.length === 0 ? (
        <div className="bg-port-card border border-port-border rounded-lg p-8 text-center">
          <Activity size={32} className="text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400">No agent tasks found for this app in the last 14 days</p>
        </div>
      ) : (
        <div className="bg-port-card border border-port-border rounded-lg overflow-x-auto">
          <table className="w-full min-w-[40rem] table-fixed text-sm">
            <thead>
              <tr className="border-b border-port-border">
                <th className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wide font-medium">Description</th>
                <th className="w-28 text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wide font-medium whitespace-nowrap">Type</th>
                <th className="w-32 text-center px-4 py-3 text-xs text-gray-500 uppercase tracking-wide font-medium whitespace-nowrap">Status</th>
                <th className="w-28 text-right px-4 py-3 text-xs text-gray-500 uppercase tracking-wide font-medium whitespace-nowrap">Duration</th>
                <th className="w-28 text-right px-4 py-3 text-xs text-gray-500 uppercase tracking-wide font-medium whitespace-nowrap">When</th>
              </tr>
            </thead>
            <tbody>
              {agents.map(agent => {
                const statusCfg = STATUS_CONFIG[agent.status] || { color: 'bg-gray-600', text: agent.status };
                const duration = agent.completedAt && agent.startedAt
                  ? new Date(agent.completedAt) - new Date(agent.startedAt)
                  : null;
                const taskType = agent.metadata?.taskType || agent.metadata?.type || '-';
                const description = agent.metadata?.taskDescription || agent.metadata?.description || agent.id;

                return (
                  <tr key={agent.id} className="border-b border-port-border/50 hover:bg-white/5">
                    <td className="px-4 py-3 min-w-0">
                      <Link
                        to={`/cos/agents`}
                        className="text-gray-300 hover:text-port-accent text-xs line-clamp-2 break-words"
                      >
                        {description}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs text-gray-400 font-mono truncate block">{taskType}</span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs text-white ${statusCfg.color}`}>
                        {statusCfg.text}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <span className="text-xs text-gray-400 inline-flex items-center justify-end gap-1">
                        <Clock size={12} />
                        {formatDurationMs(duration)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <span className="text-xs text-gray-500">
                        {formatTime(agent.completedAt || agent.startedAt)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
