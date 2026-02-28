import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Clock, CheckCircle, XCircle, Activity } from 'lucide-react';
import BrailleSpinner from '../../BrailleSpinner';
import * as api from '../../../services/api';

const STATUS_CONFIG = {
  running: { color: 'bg-port-accent', text: 'Running' },
  spawning: { color: 'bg-port-warning', text: 'Spawning' },
  completed: { color: 'bg-port-success', text: 'Completed' },
  failed: { color: 'bg-port-error', text: 'Failed' },
  error: { color: 'bg-port-error', text: 'Error' },
  cancelled: { color: 'bg-gray-500', text: 'Cancelled' }
};

function formatDuration(ms) {
  if (!ms) return '-';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTime(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now - d;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function TasksTab({ appId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchAgents = async () => {
    setLoading(true);
    const result = await api.getAppAgents(appId).catch(() => ({ agents: [], summary: {} }));
    setData(result);
    setLoading(false);
  };

  useEffect(() => {
    fetchAgents();
  }, [appId]);

  if (loading) {
    return <BrailleSpinner text="Loading agent history" />;
  }

  const { agents = [], summary = {} } = data || {};
  const successRate = summary.total > 0
    ? Math.round((summary.succeeded / summary.total) * 100)
    : 0;

  return (
    <div className="max-w-5xl space-y-4">
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
        <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-port-border">
                  <th className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wide font-medium">Description</th>
                  <th className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wide font-medium">Type</th>
                  <th className="text-center px-4 py-3 text-xs text-gray-500 uppercase tracking-wide font-medium">Status</th>
                  <th className="text-right px-4 py-3 text-xs text-gray-500 uppercase tracking-wide font-medium">Duration</th>
                  <th className="text-right px-4 py-3 text-xs text-gray-500 uppercase tracking-wide font-medium">When</th>
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
                      <td className="px-4 py-3">
                        <Link
                          to={`/cos/agents`}
                          className="text-gray-300 hover:text-port-accent text-xs line-clamp-2"
                        >
                          {description}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs text-gray-400 font-mono">{taskType}</span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs text-white ${statusCfg.color}`}>
                          {statusCfg.text}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="text-xs text-gray-400 flex items-center justify-end gap-1">
                          <Clock size={12} />
                          {formatDuration(duration)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
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
        </div>
      )}
    </div>
  );
}
