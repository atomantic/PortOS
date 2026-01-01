import { useState, useEffect, useCallback } from 'react';
import LogViewer from '../components/LogViewer';
import StatusBadge from '../components/StatusBadge';
import * as api from '../services/api';
import socket, { subscribeToLogs } from '../services/socket';

const LINES_OPTIONS = [50, 100, 200, 500, 1000];

export default function Logs() {
  const [processes, setProcesses] = useState([]);
  const [selectedProcess, setSelectedProcess] = useState('');
  const [logs, setLogs] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [lines, setLines] = useState(100);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [cleanupFn, setCleanupFn] = useState(null);
  const [connected, setConnected] = useState(socket.connected);

  // Track socket connection status
  useEffect(() => {
    const onConnect = () => setConnected(true);
    const onDisconnect = () => {
      setConnected(false);
      setStreaming(false);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, []);

  // Fetch PM2 processes
  useEffect(() => {
    const fetchProcesses = async () => {
      const procs = await api.getProcesses().catch(() => []);
      setProcesses(procs);
      if (procs.length > 0 && !selectedProcess) {
        setSelectedProcess(procs[0].name);
      }
      setLoading(false);
    };
    fetchProcesses();
    const interval = setInterval(fetchProcesses, 10000);
    return () => clearInterval(interval);
  }, []);

  // Stop streaming on unmount
  useEffect(() => {
    return () => {
      if (cleanupFn) cleanupFn();
    };
  }, [cleanupFn]);

  const fetchLogs = async () => {
    if (!selectedProcess) return;
    setLoading(true);
    const result = await api.getProcessLogs(selectedProcess, lines).catch(() => ({ logs: '' }));
    const logLines = (result.logs || '').split('\n').filter(Boolean).map(line => ({
      line,
      type: 'stdout',
      timestamp: Date.now()
    }));
    setLogs(logLines);
    setLoading(false);
  };

  const startStreaming = useCallback(() => {
    if (!selectedProcess || streaming || !connected) return;

    setLogs([]);
    setStreaming(true);

    const cleanup = subscribeToLogs(selectedProcess, lines, {
      onLine: (data) => {
        setLogs(prev => [...prev, data]);
      },
      onSubscribed: (data) => {
        setLogs(prev => [...prev, {
          type: 'connected',
          line: `Connected to ${data.processName}`,
          timestamp: data.timestamp
        }]);
      },
      onError: (data) => {
        console.error('Stream error:', data);
        setLogs(prev => [...prev, {
          type: 'error',
          line: `Error: ${data.error}`,
          timestamp: Date.now()
        }]);
      },
      onClose: (data) => {
        setStreaming(false);
        setLogs(prev => [...prev, {
          type: 'connected',
          line: `Stream closed (code: ${data.code})`,
          timestamp: Date.now()
        }]);
      }
    });

    setCleanupFn(() => cleanup);
  }, [selectedProcess, lines, streaming, connected]);

  const stopStreaming = useCallback(() => {
    if (cleanupFn) {
      cleanupFn();
      setCleanupFn(null);
    }
    setStreaming(false);
    setLogs(prev => [...prev, { type: 'connected', line: 'Streaming stopped', timestamp: Date.now() }]);
  }, [cleanupFn]);

  const clearLogs = () => setLogs([]);

  const filteredLogs = filter
    ? logs.filter(log => (log.line || '').toLowerCase().includes(filter.toLowerCase()))
    : logs;

  const getProcessStatus = (name) => {
    const proc = processes.find(p => p.name === name);
    return proc?.status || 'unknown';
  };

  if (loading && processes.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading processes...</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white">Logs</h2>
          <p className="text-gray-500">View and stream PM2 process logs</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-port-success' : 'bg-port-error'}`} />
          <span className="text-sm text-gray-400">
            {connected ? 'Socket connected' : 'Socket disconnected'}
          </span>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-port-card border border-port-border rounded-lg p-4">
        <div className="flex flex-col lg:flex-row gap-4">
          {/* Process selector */}
          <div className="flex-1">
            <label className="block text-sm text-gray-400 mb-1">Process</label>
            <select
              value={selectedProcess}
              onChange={(e) => {
                if (streaming) stopStreaming();
                setSelectedProcess(e.target.value);
                setLogs([]);
              }}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
              disabled={streaming}
            >
              <option value="">Select a process...</option>
              {processes.map(proc => (
                <option key={proc.name} value={proc.name}>
                  {proc.name} ({proc.status})
                </option>
              ))}
            </select>
          </div>

          {/* Lines */}
          <div className="w-full lg:w-32">
            <label className="block text-sm text-gray-400 mb-1">Lines</label>
            <select
              value={lines}
              onChange={(e) => setLines(parseInt(e.target.value))}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
              disabled={streaming}
            >
              {LINES_OPTIONS.map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>

          {/* Filter */}
          <div className="flex-1">
            <label className="block text-sm text-gray-400 mb-1">Filter</label>
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search logs..."
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
            />
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap gap-2 mt-4">
          <button
            onClick={fetchLogs}
            disabled={!selectedProcess || streaming}
            className="px-4 py-2 bg-port-border hover:bg-port-border/80 text-white rounded-lg transition-colors disabled:opacity-50"
          >
            Fetch Logs
          </button>

          {!streaming ? (
            <button
              onClick={startStreaming}
              disabled={!selectedProcess || !connected}
              className="px-4 py-2 bg-port-success hover:bg-port-success/80 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              Start Streaming
            </button>
          ) : (
            <button
              onClick={stopStreaming}
              className="px-4 py-2 bg-port-error hover:bg-port-error/80 text-white rounded-lg transition-colors"
            >
              Stop Streaming
            </button>
          )}

          <button
            onClick={clearLogs}
            className="px-4 py-2 bg-port-border hover:bg-port-border/80 text-gray-300 rounded-lg transition-colors"
          >
            Clear
          </button>

          {streaming && (
            <div className="flex items-center gap-2 ml-auto">
              <span className="w-2 h-2 rounded-full bg-port-success animate-pulse" />
              <span className="text-sm text-port-success">Streaming live</span>
            </div>
          )}
        </div>
      </div>

      {/* Selected process info */}
      {selectedProcess && (
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-gray-400">Viewing:</span>
          <span className="font-medium text-white">{selectedProcess}</span>
          <StatusBadge status={getProcessStatus(selectedProcess)} size="sm" />
          <span className="text-gray-500 text-sm">
            {filteredLogs.length} lines {filter && '(filtered)'}
          </span>
        </div>
      )}

      {/* Log viewer */}
      <LogViewer
        logs={filteredLogs}
        autoScroll={streaming}
        maxHeight="calc(100vh - 400px)"
      />

      {/* Empty state */}
      {processes.length === 0 && (
        <div className="bg-port-card border border-port-border rounded-lg p-8 text-center">
          <div className="text-4xl mb-4">📋</div>
          <h3 className="text-lg font-semibold text-white mb-2">No PM2 processes found</h3>
          <p className="text-gray-500">
            Start an app from the Dashboard to see its logs here.
          </p>
        </div>
      )}
    </div>
  );
}
