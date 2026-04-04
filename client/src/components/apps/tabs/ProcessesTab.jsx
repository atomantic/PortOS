import { useState, useEffect, useRef, Fragment } from 'react';
import { Maximize2, X } from 'lucide-react';
import * as api from '../../../services/api';
import socket from '../../../services/socket';
import BrailleSpinner from '../../BrailleSpinner';

const formatMemory = (bytes) => {
  if (!bytes) return '0 MB';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const formatUptime = (ms) => {
  if (!ms) return '-';
  const hours = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  if (hours > 24) {
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  }
  return `${hours}h ${mins}m`;
};

const getStatusClasses = (status) => {
  switch (status) {
    case 'online': return { badge: 'bg-port-success/15 text-port-success', dot: 'bg-port-success' };
    case 'stopped': return { badge: 'bg-gray-500/20 text-gray-400', dot: 'bg-gray-500' };
    case 'errored': return { badge: 'bg-port-error/15 text-port-error', dot: 'bg-port-error' };
    default: return { badge: 'bg-port-warning/15 text-port-warning', dot: 'bg-port-warning' };
  }
};

export default function ProcessesTab({ pm2ProcessNames, filterFn }) {
  const [processes, setProcesses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedProcess, setExpandedProcess] = useState(null);
  const [logs, setLogs] = useState([]);
  const [restarting, setRestarting] = useState({});
  const [tailLines, setTailLines] = useState(500);
  const [subscribed, setSubscribed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const logsRef = useRef(null);
  const fullscreenLogsRef = useRef(null);

  const loadProcesses = async () => {
    const data = await api.getProcessesList().catch(() => []);
    setProcesses(data);
    setLoading(false);
  };

  useEffect(() => {
    loadProcesses();
    const interval = setInterval(loadProcesses, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!expandedProcess) {
      setLogs([]);
      setSubscribed(false);
      return;
    }

    socket.emit('logs:subscribe', { processName: expandedProcess, lines: tailLines });

    const handleLog = (data) => {
      if (data.processName === expandedProcess) {
        setLogs(prev => [...prev.slice(-1000), {
          line: data.line,
          type: data.type,
          timestamp: data.timestamp
        }]);
        setTimeout(() => {
          if (logsRef.current) {
            logsRef.current.scrollTop = logsRef.current.scrollHeight;
          }
          if (fullscreenLogsRef.current) {
            fullscreenLogsRef.current.scrollTop = fullscreenLogsRef.current.scrollHeight;
          }
        }, 10);
      }
    };

    const handleSubscribed = (data) => {
      if (data.processName === expandedProcess) {
        setSubscribed(true);
      }
    };

    const handleError = (data) => {
      if (data.processName === expandedProcess) {
        setLogs(prev => [...prev, { line: `Error: ${data.error}`, type: 'stderr', timestamp: Date.now() }]);
      }
    };

    socket.on('logs:line', handleLog);
    socket.on('logs:subscribed', handleSubscribed);
    socket.on('logs:error', handleError);

    return () => {
      socket.emit('logs:unsubscribe', { processName: expandedProcess });
      socket.off('logs:line', handleLog);
      socket.off('logs:subscribed', handleSubscribed);
      socket.off('logs:error', handleError);
    };
  }, [expandedProcess, tailLines]);

  const handleRestart = async (name) => {
    setRestarting(prev => ({ ...prev, [name]: true }));
    await fetch('/api/commands/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: `pm2 restart ${name}` })
    }).catch(() => null);
    setTimeout(() => {
      setRestarting(prev => ({ ...prev, [name]: false }));
      loadProcesses();
    }, 2000);
  };

  const handleStop = async (name) => {
    setRestarting(prev => ({ ...prev, [name]: true }));
    await fetch('/api/commands/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: `pm2 stop ${name}` })
    }).catch(() => null);
    setTimeout(() => {
      setRestarting(prev => ({ ...prev, [name]: false }));
      loadProcesses();
    }, 2000);
  };

  const handleStart = async (name) => {
    setRestarting(prev => ({ ...prev, [name]: true }));
    await fetch('/api/commands/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: `pm2 start ${name}` })
    }).catch(() => null);
    setTimeout(() => {
      setRestarting(prev => ({ ...prev, [name]: false }));
      loadProcesses();
    }, 2000);
  };

  const toggleExpand = (name) => {
    setExpandedProcess(prev => prev === name ? null : name);
    setLogs([]);
  };

  const filteredProcesses = filterFn
    ? processes.filter(proc => filterFn(proc.name))
    : pm2ProcessNames
      ? processes.filter(proc => pm2ProcessNames.includes(proc.name))
      : processes;

  if (loading) {
    return <div className="text-center py-8"><BrailleSpinner text="Loading processes" /></div>;
  }

  return (
    <>
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <p className="text-gray-500 text-sm">{filteredProcesses.length} process{filteredProcesses.length !== 1 ? 'es' : ''}</p>
          <button
            onClick={loadProcesses}
            className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-white rounded-lg transition-colors text-sm"
          >
            Refresh
          </button>
        </div>

        <div className="bg-port-card border border-port-border rounded-xl overflow-hidden overflow-x-auto">
          <table className="w-full min-w-[700px]">
            <thead className="bg-port-border/50">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-400 w-8"></th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-400">Name</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-400">Status</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-400">PID</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-400">CPU</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-400">Memory</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-400">Uptime</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-400">Restarts</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-gray-400">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-port-border">
              {filteredProcesses.map(proc => (
                <Fragment key={proc.pm_id}>
                  <tr className="hover:bg-port-border/20">
                    <td className="px-4 py-3">
                      <button
                        onClick={() => toggleExpand(proc.name)}
                        className="text-gray-400 hover:text-white transition-transform"
                      >
                        <span className={`inline-block transition-transform ${expandedProcess === proc.name ? 'rotate-90' : ''}`}>▶</span>
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-medium text-white">{proc.name}</span>
                    </td>
                    <td className="px-4 py-3">
                      {(() => { const sc = getStatusClasses(proc.status); return (
                        <span className={`inline-flex items-center gap-2 px-2 py-1 rounded text-xs ${sc.badge}`}>
                          <span className={`w-2 h-2 rounded-full ${sc.dot}`} />
                          {proc.status}
                        </span>
                      ); })()}
                    </td>
                    <td className="px-4 py-3 text-gray-400 font-mono text-sm">{proc.pid || '-'}</td>
                    <td className="px-4 py-3 text-gray-400">{proc.cpu ? `${proc.cpu}%` : '-'}</td>
                    <td className="px-4 py-3 text-gray-400">{formatMemory(proc.memory)}</td>
                    <td className="px-4 py-3 text-gray-400">{formatUptime(proc.uptime)}</td>
                    <td className="px-4 py-3 text-gray-400">{proc.restarts}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        {proc.status === 'online' ? (
                          <>
                            <button
                              onClick={() => handleRestart(proc.name)}
                              disabled={restarting[proc.name]}
                              className="px-2 py-1 text-xs bg-port-warning/20 text-port-warning hover:bg-port-warning/30 rounded disabled:opacity-50"
                            >
                              {restarting[proc.name] ? '...' : 'Restart'}
                            </button>
                            <button
                              onClick={() => handleStop(proc.name)}
                              disabled={restarting[proc.name]}
                              className="px-2 py-1 text-xs bg-port-error/20 text-port-error hover:bg-port-error/30 rounded disabled:opacity-50"
                            >
                              Stop
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => handleStart(proc.name)}
                            disabled={restarting[proc.name]}
                            className="px-2 py-1 text-xs bg-port-success/20 text-port-success hover:bg-port-success/30 rounded disabled:opacity-50"
                          >
                            {restarting[proc.name] ? '...' : 'Start'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {expandedProcess === proc.name && (
                    <tr>
                      <td colSpan={9} className="p-0">
                        <div className="bg-port-bg border-t border-port-border">
                          <div className="flex items-center justify-between px-4 py-2 border-b border-port-border">
                            <div className="flex items-center gap-3">
                              <span className="text-xs text-gray-400">Live logs for {proc.name}</span>
                              {subscribed && (
                                <span className="text-xs text-port-success">● streaming</span>
                              )}
                            </div>
                            <div className="flex items-center gap-3">
                              <div className="flex items-center gap-2">
                                <label className="text-xs text-gray-500">Tail lines:</label>
                                <select
                                  value={tailLines}
                                  onChange={(e) => {
                                    setTailLines(Number(e.target.value));
                                    setLogs([]);
                                  }}
                                  className="px-2 py-1 text-xs bg-port-card border border-port-border rounded text-white"
                                >
                                  <option value={100}>100</option>
                                  <option value={250}>250</option>
                                  <option value={500}>500</option>
                                  <option value={1000}>1000</option>
                                  <option value={2000}>2000</option>
                                </select>
                              </div>
                              <span className="text-xs text-gray-600">{logs.length} lines</span>
                              <button
                                onClick={() => setLogs([])}
                                className="text-xs text-gray-500 hover:text-white"
                              >
                                Clear
                              </button>
                              <button
                                onClick={() => setFullscreen(true)}
                                className="text-xs text-gray-500 hover:text-white flex items-center gap-1"
                                title="Fullscreen"
                              >
                                <Maximize2 size={12} />
                                Fullscreen
                              </button>
                            </div>
                          </div>
                          <div
                            ref={logsRef}
                            className="h-[32rem] overflow-auto p-3 font-mono text-xs"
                          >
                            {logs.length === 0 ? (
                              <div className="text-gray-500">
                                {subscribed ? 'No logs yet...' : 'Connecting to log stream...'}
                              </div>
                            ) : (
                              logs.map((log, i) => (
                                <div
                                  key={i}
                                  className={`py-0.5 ${log.type === 'stderr' ? 'text-port-error' : 'text-gray-300'}`}
                                >
                                  <span className="text-gray-600 mr-2">
                                    {new Date(log.timestamp).toLocaleTimeString()}
                                  </span>
                                  {log.line}
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {filteredProcesses.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-500">
                    No PM2 processes found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Fullscreen Log Modal */}
      {fullscreen && expandedProcess && (
        <div className="fixed inset-0 bg-port-bg z-50 flex flex-col">
          <div className="flex items-center justify-between px-6 py-4 border-b border-port-border bg-port-card">
            <div className="flex items-center gap-4">
              <span className="text-lg font-medium text-white">Logs: {expandedProcess}</span>
              {subscribed && (
                <span className="text-sm text-port-success">● streaming</span>
              )}
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-500">Tail lines:</label>
                <select
                  value={tailLines}
                  onChange={(e) => {
                    setTailLines(Number(e.target.value));
                    setLogs([]);
                  }}
                  className="px-2 py-1 text-sm bg-port-bg border border-port-border rounded text-white"
                >
                  <option value={100}>100</option>
                  <option value={250}>250</option>
                  <option value={500}>500</option>
                  <option value={1000}>1000</option>
                  <option value={2000}>2000</option>
                </select>
              </div>
              <span className="text-sm text-gray-600">{logs.length} lines</span>
              <button
                onClick={() => setLogs([])}
                className="text-sm text-gray-500 hover:text-white"
              >
                Clear
              </button>
              <button
                onClick={() => setFullscreen(false)}
                className="p-2 text-gray-400 hover:text-white"
                title="Exit fullscreen"
              >
                <X size={20} />
              </button>
            </div>
          </div>
          <div
            ref={fullscreenLogsRef}
            className="flex-1 overflow-auto p-4 font-mono text-sm"
          >
            {logs.length === 0 ? (
              <div className="text-gray-500">
                {subscribed ? 'No logs yet...' : 'Connecting to log stream...'}
              </div>
            ) : (
              logs.map((log, i) => (
                <div
                  key={i}
                  className={`py-0.5 ${log.type === 'stderr' ? 'text-port-error' : 'text-gray-300'}`}
                >
                  <span className="text-gray-600 mr-3">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                  {log.line}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </>
  );
}
