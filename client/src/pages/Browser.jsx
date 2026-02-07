import { useState, useEffect, useCallback } from 'react';
import {
  Globe, Play, Square, RefreshCw, Settings, Activity,
  Monitor, Wifi, WifiOff, Clock, Cpu, MemoryStick,
  FileText, ChevronDown, ChevronRight, ExternalLink
} from 'lucide-react';
import {
  getBrowserStatus, getBrowserConfig, updateBrowserConfig,
  launchBrowser, stopBrowser, restartBrowser,
  getBrowserLogs, navigateBrowser
} from '../services/api';
import toast from 'react-hot-toast';

const POLL_INTERVAL = 5000;

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}

function formatUptime(timestamp) {
  if (!timestamp) return '-';
  const ms = Date.now() - timestamp;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export default function BrowserPage() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(null);
  const [showConfig, setShowConfig] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showPages, setShowPages] = useState(true);
  const [logs, setLogs] = useState('');
  const [config, setConfig] = useState(null);
  const [configDraft, setConfigDraft] = useState(null);
  const [navUrl, setNavUrl] = useState('');

  const fetchStatus = useCallback(async () => {
    const data = await getBrowserStatus().catch(() => null);
    if (data) {
      setStatus(data);
      setLoading(false);
    }
  }, []);

  const fetchLogs = useCallback(async () => {
    const data = await getBrowserLogs(100).catch(() => null);
    if (data) {
      const combined = [data.stdout, data.stderr].filter(Boolean).join('\n');
      setLogs(combined || '(no logs)');
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Poll for status updates
  useEffect(() => {
    const interval = setInterval(fetchStatus, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // Load config when settings panel opens
  useEffect(() => {
    if (showConfig && !config) {
      getBrowserConfig().then(c => {
        setConfig(c);
        setConfigDraft(c);
      }).catch(() => {});
    }
  }, [showConfig, config]);

  // Load logs when panel opens
  useEffect(() => {
    if (showLogs) fetchLogs();
  }, [showLogs, fetchLogs]);

  const handleAction = useCallback(async (action, fn) => {
    setActionLoading(action);
    const result = await fn().catch(err => {
      toast.error(`Failed to ${action}: ${err.message}`);
      return null;
    });
    if (result) {
      toast.success(`Browser ${action} successful`);
      // Refresh full status after action
      await fetchStatus();
    }
    setActionLoading(null);
  }, [fetchStatus]);

  const handleSaveConfig = useCallback(async () => {
    if (!configDraft) return;
    const saved = await updateBrowserConfig(configDraft).catch(err => {
      toast.error(`Failed to save config: ${err.message}`);
      return null;
    });
    if (saved) {
      setConfig(saved);
      setConfigDraft(saved);
      toast.success('Browser config saved');
    }
  }, [configDraft]);

  const handleNavigate = useCallback(async () => {
    const trimmed = navUrl.trim();
    if (!trimmed) return;
    const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    setActionLoading('navigate');
    const result = await navigateBrowser(url).catch(err => {
      toast.error(`Failed to navigate: ${err.message}`);
      return null;
    });
    if (result) {
      toast.success(`Opened ${url}`);
      setNavUrl('');
      await fetchStatus();
    }
    setActionLoading(null);
  }, [navUrl, fetchStatus]);

  const isRunning = status?.process?.status === 'online';
  const isConnected = status?.connected;

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white flex items-center gap-2">
            <Globe size={28} className="text-port-accent" />
            Browser
          </h2>
          <p className="text-gray-500">Manage the authenticated CDP/Playwright browser</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setShowConfig(s => !s)}
            className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg transition-colors ${
              showConfig
                ? 'bg-port-accent text-white'
                : 'bg-port-card border border-port-border text-gray-400 hover:text-white hover:border-port-accent/50'
            }`}
          >
            <Settings size={16} />
            <span className="hidden sm:inline">Config</span>
          </button>
          <button
            onClick={() => { setShowLogs(s => !s); }}
            className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg transition-colors ${
              showLogs
                ? 'bg-port-accent text-white'
                : 'bg-port-card border border-port-border text-gray-400 hover:text-white hover:border-port-accent/50'
            }`}
          >
            <FileText size={16} />
            <span className="hidden sm:inline">Logs</span>
          </button>
          <button
            onClick={fetchStatus}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg bg-port-card border border-port-border text-gray-400 hover:text-white hover:border-port-accent/50 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      {/* Config panel */}
      {showConfig && configDraft && (
        <div className="mb-6 p-4 bg-port-card border border-port-border rounded-xl">
          <h3 className="text-lg font-semibold text-white mb-4">Browser Configuration</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">CDP Port</label>
              <input
                type="number"
                value={configDraft.cdpPort}
                onChange={e => setConfigDraft(d => ({ ...d, cdpPort: parseInt(e.target.value, 10) || 5556 }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:outline-none focus:border-port-accent"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">CDP Host</label>
              <input
                type="text"
                value={configDraft.cdpHost}
                onChange={e => setConfigDraft(d => ({ ...d, cdpHost: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:outline-none focus:border-port-accent"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Health Port</label>
              <input
                type="number"
                value={configDraft.healthPort}
                onChange={e => setConfigDraft(d => ({ ...d, healthPort: parseInt(e.target.value, 10) || 5557 }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:outline-none focus:border-port-accent"
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="headless"
                checked={configDraft.headless}
                onChange={e => setConfigDraft(d => ({ ...d, headless: e.target.checked }))}
                className="w-4 h-4 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
              />
              <label htmlFor="headless" className="text-sm text-gray-400">Headless mode</label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="autoConnect"
                checked={configDraft.autoConnect}
                onChange={e => setConfigDraft(d => ({ ...d, autoConnect: e.target.checked }))}
                className="w-4 h-4 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
              />
              <label htmlFor="autoConnect" className="text-sm text-gray-400">Auto-connect on startup</label>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <button
              onClick={handleSaveConfig}
              className="px-4 py-2 bg-port-accent text-white rounded-lg text-sm font-medium hover:bg-port-accent/80 transition-colors"
            >
              Save Config
            </button>
          </div>
        </div>
      )}

      {/* Logs panel */}
      {showLogs && (
        <div className="mb-6 bg-port-card border border-port-border rounded-xl overflow-hidden">
          <div className="flex items-center justify-between p-3 border-b border-port-border">
            <h3 className="text-sm font-semibold text-white">Recent Logs</h3>
            <button
              onClick={fetchLogs}
              className="text-xs text-gray-400 hover:text-white transition-colors"
            >
              <RefreshCw size={14} />
            </button>
          </div>
          <pre className="p-3 text-xs text-gray-400 font-mono overflow-auto max-h-64 whitespace-pre-wrap">
            {logs || 'Loading...'}
          </pre>
        </div>
      )}

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Status + Controls */}
        <div className="lg:col-span-2 space-y-6">
          {/* Status card */}
          <div className="bg-port-card border border-port-border rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                <Activity size={20} className="text-port-accent" />
                Browser Status
              </h3>
              <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-sm font-medium ${
                isConnected
                  ? 'bg-port-success/10 text-port-success'
                  : isRunning
                    ? 'bg-port-warning/10 text-port-warning'
                    : 'bg-port-error/10 text-port-error'
              }`}>
                {isConnected ? <Wifi size={14} /> : <WifiOff size={14} />}
                {isConnected ? 'Connected' : isRunning ? 'Running (not connected)' : 'Stopped'}
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="bg-port-bg rounded-lg p-3">
                <div className="text-xs text-gray-500 mb-1">Process</div>
                <div className={`text-sm font-medium ${
                  isRunning ? 'text-port-success' : 'text-port-error'
                }`}>
                  {status?.process?.status || 'unknown'}
                </div>
              </div>
              <div className="bg-port-bg rounded-lg p-3">
                <div className="text-xs text-gray-500 mb-1">CDP Endpoint</div>
                <div className="text-sm font-medium text-white truncate" title={status?.cdpEndpoint}>
                  {status?.cdpEndpoint || '-'}
                </div>
              </div>
              <div className="bg-port-bg rounded-lg p-3">
                <div className="text-xs text-gray-500 mb-1">Open Pages</div>
                <div className="text-sm font-medium text-white">
                  {status?.pageCount ?? '-'}
                </div>
              </div>
              <div className="bg-port-bg rounded-lg p-3">
                <div className="text-xs text-gray-500 mb-1">Uptime</div>
                <div className="text-sm font-medium text-white flex items-center gap-1">
                  <Clock size={12} />
                  {formatUptime(status?.process?.uptime)}
                </div>
              </div>
            </div>

            {/* Process details row */}
            {status?.process?.exists && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-3">
                <div className="bg-port-bg rounded-lg p-3">
                  <div className="text-xs text-gray-500 mb-1 flex items-center gap-1"><Cpu size={10} /> CPU</div>
                  <div className="text-sm font-medium text-white">{status.process.cpu ?? 0}%</div>
                </div>
                <div className="bg-port-bg rounded-lg p-3">
                  <div className="text-xs text-gray-500 mb-1 flex items-center gap-1"><MemoryStick size={10} /> Memory</div>
                  <div className="text-sm font-medium text-white">{formatBytes(status.process.memory)}</div>
                </div>
                <div className="bg-port-bg rounded-lg p-3">
                  <div className="text-xs text-gray-500 mb-1">PID</div>
                  <div className="text-sm font-medium text-white">{status.process.pid ?? '-'}</div>
                </div>
                <div className="bg-port-bg rounded-lg p-3">
                  <div className="text-xs text-gray-500 mb-1">Restarts</div>
                  <div className="text-sm font-medium text-white">{status.process.restarts ?? 0}</div>
                </div>
              </div>
            )}

            {/* Version info */}
            {status?.version && (
              <div className="mt-3 bg-port-bg rounded-lg p-3">
                <div className="text-xs text-gray-500 mb-1">Browser Version</div>
                <div className="text-sm text-white">
                  {status.version.Browser || status.version['User-Agent'] || 'Unknown'}
                </div>
              </div>
            )}
          </div>

          {/* Controls */}
          <div className="bg-port-card border border-port-border rounded-xl p-5">
            <h3 className="text-lg font-semibold text-white mb-4">Controls</h3>
            <div className="flex flex-wrap gap-3">
              {!isRunning ? (
                <button
                  onClick={() => handleAction('launch', launchBrowser)}
                  disabled={actionLoading !== null}
                  className="flex items-center gap-2 px-5 py-2.5 bg-port-success text-white rounded-lg font-medium hover:bg-port-success/80 transition-colors disabled:opacity-50 min-h-[40px]"
                >
                  {actionLoading === 'launch'
                    ? <RefreshCw size={18} className="animate-spin" />
                    : <Play size={18} />
                  }
                  Launch Browser
                </button>
              ) : (
                <>
                  <button
                    onClick={() => handleAction('stop', stopBrowser)}
                    disabled={actionLoading !== null}
                    className="flex items-center gap-2 px-5 py-2.5 bg-port-error text-white rounded-lg font-medium hover:bg-port-error/80 transition-colors disabled:opacity-50 min-h-[40px]"
                  >
                    {actionLoading === 'stop'
                      ? <RefreshCw size={18} className="animate-spin" />
                      : <Square size={18} />
                    }
                    Stop
                  </button>
                  <button
                    onClick={() => handleAction('restart', restartBrowser)}
                    disabled={actionLoading !== null}
                    className="flex items-center gap-2 px-5 py-2.5 bg-port-warning text-white rounded-lg font-medium hover:bg-port-warning/80 transition-colors disabled:opacity-50 min-h-[40px]"
                  >
                    {actionLoading === 'restart'
                      ? <RefreshCw size={18} className="animate-spin" />
                      : <RefreshCw size={18} />
                    }
                    Restart
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Navigate to URL */}
          {isConnected && (
            <div className="bg-port-card border border-port-border rounded-xl p-5">
              <h3 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                <ExternalLink size={20} className="text-port-accent" />
                Open URL
              </h3>
              <form
                onSubmit={e => { e.preventDefault(); handleNavigate(); }}
                className="flex gap-2"
              >
                <input
                  type="text"
                  value={navUrl}
                  onChange={e => setNavUrl(e.target.value)}
                  placeholder="https://example.com"
                  className="flex-1 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:outline-none focus:border-port-accent placeholder-gray-600"
                />
                <button
                  type="submit"
                  disabled={!navUrl.trim() || actionLoading !== null}
                  className="flex items-center gap-2 px-5 py-2 bg-port-accent text-white rounded-lg font-medium hover:bg-port-accent/80 transition-colors disabled:opacity-50"
                >
                  {actionLoading === 'navigate'
                    ? <RefreshCw size={16} className="animate-spin" />
                    : <Globe size={16} />
                  }
                  Go
                </button>
              </form>
            </div>
          )}

          {/* Open Pages */}
          <div className="bg-port-card border border-port-border rounded-xl overflow-hidden">
            <button
              onClick={() => setShowPages(s => !s)}
              className="w-full flex items-center justify-between p-4 text-left hover:bg-port-border/30 transition-colors"
            >
              <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                <Monitor size={20} className="text-port-accent" />
                Open Pages
                {status?.pages?.length > 0 && (
                  <span className="ml-2 px-2 py-0.5 text-xs rounded-full bg-port-accent/20 text-port-accent">
                    {status.pages.length}
                  </span>
                )}
              </h3>
              {showPages ? <ChevronDown size={18} className="text-gray-400" /> : <ChevronRight size={18} className="text-gray-400" />}
            </button>
            {showPages && (
              <div className="border-t border-port-border">
                {!status?.pages || status.pages.length === 0 ? (
                  <div className="p-4 text-sm text-gray-500">
                    {isConnected ? 'No pages open' : 'Browser not connected'}
                  </div>
                ) : (
                  <div className="divide-y divide-port-border">
                    {status.pages.map(page => (
                      <div key={page.id} className="p-3 hover:bg-port-border/20 transition-colors">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-white truncate">
                              {page.title}
                            </div>
                            <div className="text-xs text-gray-500 truncate mt-0.5">
                              {page.url}
                            </div>
                          </div>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-port-border text-gray-400 flex-shrink-0">
                            {page.type}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Quick Status */}
          <div className="bg-port-card border border-port-border rounded-xl p-4">
            <h3 className="font-semibold text-white mb-4">Connection Info</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-gray-400 text-sm">CDP Port</span>
                <span className="text-sm font-mono text-white">{status?.config?.cdpPort || '-'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-400 text-sm">Health Port</span>
                <span className="text-sm font-mono text-white">{status?.config?.healthPort || '-'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-400 text-sm">Headless</span>
                <span className={`text-sm font-medium ${status?.config?.headless ? 'text-port-success' : 'text-port-warning'}`}>
                  {status?.config?.headless ? 'Yes' : 'No'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-400 text-sm">Auto-connect</span>
                <span className={`text-sm font-medium ${status?.config?.autoConnect ? 'text-port-success' : 'text-gray-500'}`}>
                  {status?.config?.autoConnect ? 'Yes' : 'No'}
                </span>
              </div>
            </div>
          </div>

          {/* CDP Endpoint card */}
          <div className="bg-port-card border border-port-border rounded-xl p-4">
            <h3 className="font-semibold text-white mb-3">CDP Endpoint</h3>
            <div className="bg-port-bg rounded-lg p-3 font-mono text-xs text-port-accent break-all">
              {status?.cdpEndpoint || `ws://127.0.0.1:5556`}
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Use this endpoint to connect Playwright or other CDP clients to the running browser instance.
            </p>
          </div>

          {/* Instructions */}
          <div className="bg-port-card border border-port-border rounded-xl p-4">
            <h3 className="font-semibold text-white mb-3">Usage</h3>
            <ul className="space-y-2 text-sm text-gray-400">
              <li>1. Launch the browser using the controls</li>
              <li>2. Browser runs as a PM2 process (portos-browser)</li>
              <li>3. Connect via CDP endpoint for automation</li>
              <li>4. Sessions persist across restarts</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
