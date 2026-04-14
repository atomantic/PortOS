import { useState, useEffect, Fragment } from 'react';
import { RefreshCw, Activity, XCircle, Cpu, MemoryStick, Terminal } from 'lucide-react';
import * as api from '../services/api';

export function AgentsPage() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [killing, setKilling] = useState({});
  const [expandedPid, setExpandedPid] = useState(null);
  const REFRESH_INTERVAL = 3;

  useEffect(() => {
    loadAgents();
    const interval = setInterval(loadAgents, REFRESH_INTERVAL * 1000);
    return () => clearInterval(interval);
  }, []);

  const loadAgents = async () => {
    const data = await api.getAgents().catch(() => []);
    setAgents(data);
    setLoading(false);
  };

  const handleKill = async (pid) => {
    setKilling(prev => ({ ...prev, [pid]: true }));
    await api.killAgent(pid).catch(() => null);
    setTimeout(() => {
      setKilling(prev => ({ ...prev, [pid]: false }));
      loadAgents();
    }, 1000);
  };

  const toggleExpand = (pid) => {
    setExpandedPid(prev => prev === pid ? null : pid);
  };

  const formatStartTime = (timestamp) => {
    return new Date(timestamp).toLocaleString();
  };

  const totalCpu = agents.reduce((sum, a) => sum + (a.cpu || 0), 0);
  const totalMemory = agents.reduce((sum, a) => sum + (a.memory || 0), 0);

  if (loading) {
    return <div className="text-center py-8 text-gray-400">Scanning for AI agents...</div>;
  }

  return (
    <div className="space-y-4 lg:space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2 sm:gap-3">
          <Activity size={24} className="sm:w-7 sm:h-7 text-purple-400" />
          <h1 className="text-lg sm:text-2xl font-bold text-white font-mono">AI Agent Processes</h1>
          <span className="hidden sm:inline text-gray-500 text-sm">({REFRESH_INTERVAL}s)</span>
        </div>
        <button
          onClick={loadAgents}
          className="flex items-center justify-center gap-2 px-3 py-1.5 sm:px-4 sm:py-2 bg-port-card border border-port-border hover:border-gray-500 text-white text-sm rounded-lg transition-colors"
        >
          <RefreshCw size={14} className="sm:w-4 sm:h-4" />
          <span className="sm:inline">Refresh</span>
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        <div className="bg-port-card border border-port-border rounded-lg sm:rounded-xl p-2 sm:p-5 flex items-center justify-between">
          <div>
            <div className="text-gray-400 text-[10px] sm:text-sm mb-0.5 sm:mb-1">Processes</div>
            <div className="text-lg sm:text-3xl font-bold text-white font-mono">{agents.length}</div>
          </div>
          <Terminal size={20} className="sm:w-8 sm:h-8 text-purple-400" />
        </div>
        <div className="bg-port-card border border-port-border rounded-lg sm:rounded-xl p-2 sm:p-5 flex items-center justify-between">
          <div>
            <div className="text-gray-400 text-[10px] sm:text-sm mb-0.5 sm:mb-1">CPU</div>
            <div className="text-lg sm:text-3xl font-bold text-white font-mono">{totalCpu.toFixed(1)}%</div>
          </div>
          <Cpu size={20} className="sm:w-8 sm:h-8 text-blue-400" />
        </div>
        <div className="bg-port-card border border-port-border rounded-lg sm:rounded-xl p-2 sm:p-5 flex items-center justify-between">
          <div>
            <div className="text-gray-400 text-[10px] sm:text-sm mb-0.5 sm:mb-1">Memory</div>
            <div className="text-lg sm:text-3xl font-bold text-white font-mono">{totalMemory.toFixed(1)}%</div>
          </div>
          <MemoryStick size={20} className="sm:w-8 sm:h-8 text-green-400" />
        </div>
      </div>

      {/* Running Processes */}
      <div className="bg-port-card border border-port-border rounded-lg sm:rounded-xl">
        <div className="px-3 sm:px-6 py-3 sm:py-4 border-b border-port-border">
          <h2 className="text-base sm:text-lg font-semibold text-white">Running Processes</h2>
        </div>

        {/* Mobile Card View */}
        <div className="sm:hidden divide-y divide-port-border">
          {agents.map(agent => (
            <div key={agent.pid} className="p-3">
              {/* Top row: Name, PID, Runtime, Kill button */}
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className="font-mono text-white text-sm truncate">{agent.agentName.toLowerCase()}</span>
                  {agent.source === 'cos' && (
                    <span className="px-1.5 py-0.5 text-[10px] bg-purple-500/20 text-purple-400 rounded shrink-0">CoS</span>
                  )}
                  <span className="text-gray-500 text-xs shrink-0">#{agent.pid}</span>
                  <span className="font-mono text-cyan-400 text-xs shrink-0 whitespace-nowrap">{agent.runtimeFormatted}</span>
                </div>
                <button
                  onClick={() => handleKill(agent.pid)}
                  disabled={killing[agent.pid]}
                  className="shrink-0 px-2 py-1 bg-red-500/20 text-red-400 hover:bg-red-500/30 hover:text-red-300 disabled:opacity-50 rounded text-xs font-medium flex items-center gap-1"
                >
                  <XCircle size={14} className={killing[agent.pid] ? 'animate-pulse' : ''} />
                  Kill
                </button>
              </div>
              {/* Stats row: CPU & Memory */}
              <div className="flex items-center gap-4 text-xs">
                <div className="flex items-center gap-1">
                  <span className="text-gray-500">CPU</span>
                  <span className="font-mono text-green-400">{agent.cpu?.toFixed(1)}%</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-gray-500">Mem</span>
                  <span className="font-mono text-blue-400">{agent.memory?.toFixed(1)}%</span>
                </div>
              </div>
              <button
                onClick={() => toggleExpand(agent.pid)}
                className="mt-2 text-xs text-gray-500 hover:text-white flex items-center gap-1"
              >
                <span className={`inline-block transition-transform ${expandedPid === agent.pid ? 'rotate-90' : ''}`}>▶</span>
                {expandedPid === agent.pid ? 'Hide details' : 'Show details'}
              </button>
              {expandedPid === agent.pid && (
                <div className="mt-3 pt-3 border-t border-port-border space-y-3">
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <div className="text-gray-500 uppercase tracking-wide mb-0.5">Agent Type</div>
                      <div className="text-purple-400">{agent.agentName}</div>
                    </div>
                    <div>
                      <div className="text-gray-500 uppercase tracking-wide mb-0.5">Parent PID</div>
                      <div className="text-gray-300 font-mono">{agent.ppid}</div>
                    </div>
                    {agent.model && (
                      <div>
                        <div className="text-gray-500 uppercase tracking-wide mb-0.5">Model</div>
                        <div className="text-yellow-400 font-mono">{agent.model}</div>
                      </div>
                    )}
                    {agent.taskId && (
                      <div>
                        <div className="text-gray-500 uppercase tracking-wide mb-0.5">Task ID</div>
                        <div className="text-gray-300 font-mono truncate">{agent.taskId}</div>
                      </div>
                    )}
                  </div>
                  {agent.prompt && (
                    <div>
                      <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Task</div>
                      <div className="bg-port-bg border border-port-border rounded p-2 text-xs text-gray-300 line-clamp-3">
                        {agent.prompt}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {agents.length === 0 && (
            <div className="px-3 py-8 text-center text-gray-500 text-sm">
              No AI agents currently running
            </div>
          )}
        </div>

        {/* Desktop Table View */}
        <div className="hidden sm:block overflow-x-auto">
        <table className="w-full min-w-[600px]">
          <thead>
            <tr className="border-b border-port-border">
              <th className="px-4 py-4 text-left text-sm font-semibold text-gray-400 w-8"></th>
              <th className="px-4 py-4 text-left text-sm font-semibold text-gray-400">PID</th>
              <th className="px-4 py-4 text-left text-sm font-semibold text-gray-400">Runtime</th>
              <th className="px-4 py-4 text-left text-sm font-semibold text-gray-400">CPU %</th>
              <th className="px-4 py-4 text-left text-sm font-semibold text-gray-400">Memory %</th>
              <th className="px-4 py-4 text-left text-sm font-semibold text-gray-400">Command</th>
              <th className="px-4 py-4 text-center text-sm font-semibold text-gray-400">Actions</th>
            </tr>
          </thead>
          <tbody>
            {agents.map(agent => (
              <Fragment key={agent.pid}>
                <tr className="border-b border-port-border/50 hover:bg-port-border/20">
                  <td className="px-4 py-4">
                    <button
                      onClick={() => toggleExpand(agent.pid)}
                      className="text-gray-400 hover:text-white transition-transform"
                    >
                      <span className={`inline-block transition-transform ${expandedPid === agent.pid ? 'rotate-90' : ''}`}>▶</span>
                    </button>
                  </td>
                  <td className="px-4 py-4 font-mono text-white">{agent.pid}</td>
                  <td className="px-4 py-4 font-mono text-cyan-400">{agent.runtimeFormatted}</td>
                  <td className="px-4 py-4 font-mono text-green-400">{agent.cpu?.toFixed(1)}%</td>
                  <td className="px-4 py-4 font-mono text-blue-400">{agent.memory?.toFixed(1)}%</td>
                  <td className="px-4 py-4 font-mono text-gray-300">
                    {agent.agentName.toLowerCase()}
                    {agent.source === 'cos' && (
                      <span className="ml-2 px-1.5 py-0.5 text-[10px] bg-purple-500/20 text-purple-400 rounded">CoS</span>
                    )}
                  </td>
                  <td className="px-4 py-4 text-center">
                    <button
                      onClick={() => handleKill(agent.pid)}
                      disabled={killing[agent.pid]}
                      className="px-3 py-1.5 bg-red-500/20 text-red-400 hover:bg-red-500/30 hover:text-red-300 disabled:opacity-50 rounded text-sm font-medium inline-flex items-center gap-1.5 transition-colors"
                      title="Kill process"
                    >
                      <XCircle size={16} className={killing[agent.pid] ? 'animate-pulse' : ''} />
                      Kill
                    </button>
                  </td>
                </tr>
                {expandedPid === agent.pid && (
                  <tr>
                    <td colSpan={7} className="p-0">
                      <div className="bg-port-bg border-t border-port-border">
                        <div className="px-3 sm:px-6 py-4 space-y-4">
                          {/* Process Details Grid */}
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <div>
                              <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Agent Type</div>
                              <div className="text-sm text-purple-400 font-medium">
                                {agent.agentName}
                                {agent.source === 'cos' && <span className="ml-1 text-xs text-purple-300">(CoS)</span>}
                              </div>
                            </div>
                            <div>
                              <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Parent PID</div>
                              <div className="text-sm text-gray-300 font-mono">{agent.ppid}</div>
                            </div>
                            <div>
                              <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Started At</div>
                              <div className="text-sm text-gray-300">{formatStartTime(agent.startTime)}</div>
                            </div>
                            <div>
                              <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Runtime (ms)</div>
                              <div className="text-sm text-gray-300 font-mono">{agent.runtime?.toLocaleString()}</div>
                            </div>
                            {agent.model && (
                              <div>
                                <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Model</div>
                                <div className="text-sm text-yellow-400 font-mono">{agent.model}</div>
                              </div>
                            )}
                            {agent.agentId && (
                              <div>
                                <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Agent ID</div>
                                <div className="text-sm text-gray-300 font-mono">{agent.agentId}</div>
                              </div>
                            )}
                            {agent.taskId && (
                              <div>
                                <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Task ID</div>
                                <div className="text-sm text-gray-300 font-mono">{agent.taskId}</div>
                              </div>
                            )}
                            {agent.workspacePath && (
                              <div>
                                <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Workspace</div>
                                <div className="text-sm text-gray-300 font-mono truncate" title={agent.workspacePath}>
                                  {agent.workspacePath.split('/').pop()}
                                </div>
                              </div>
                            )}
                          </div>

                          {/* Full Command */}
                          <div>
                            <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Full Command</div>
                            <div className="bg-port-card border border-port-border rounded-lg p-3 overflow-x-auto">
                              <code className="text-sm text-cyan-300 font-mono whitespace-pre-wrap break-all">
                                {agent.command}
                              </code>
                            </div>
                          </div>

                          {/* Task Prompt (for CoS agents) */}
                          {agent.prompt && (
                            <div>
                              <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Task Prompt</div>
                              <div className="bg-port-card border border-port-border rounded-lg p-3 overflow-x-auto max-h-48 overflow-y-auto">
                                <p className="text-sm text-gray-300 whitespace-pre-wrap">
                                  {agent.prompt}
                                </p>
                              </div>
                            </div>
                          )}

                          {/* Resource Usage Bar */}
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                              <div className="flex items-center justify-between text-xs mb-1">
                                <span className="text-gray-500 uppercase tracking-wide">CPU Usage</span>
                                <span className="text-green-400 font-mono">{agent.cpu?.toFixed(1)}%</span>
                              </div>
                              <div className="h-2 bg-port-border rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-green-500 rounded-full transition-all"
                                  style={{ width: `${Math.min(agent.cpu || 0, 100)}%` }}
                                />
                              </div>
                            </div>
                            <div>
                              <div className="flex items-center justify-between text-xs mb-1">
                                <span className="text-gray-500 uppercase tracking-wide">Memory Usage</span>
                                <span className="text-blue-400 font-mono">{agent.memory?.toFixed(1)}%</span>
                              </div>
                              <div className="h-2 bg-port-border rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-blue-500 rounded-full transition-all"
                                  style={{ width: `${Math.min(agent.memory || 0, 100)}%` }}
                                />
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {agents.length === 0 && (
              <tr>
                <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
                  No AI agents currently running
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}

export default AgentsPage;
