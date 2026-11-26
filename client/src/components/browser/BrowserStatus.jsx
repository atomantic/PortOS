import { Activity, Clock, Cpu, MemoryStick, Wifi, WifiOff } from 'lucide-react';
import { formatBytes, formatDurationMs } from '../../utils/formatters';
import { pluralize } from '../../lib/textUtils';
import { PORTS } from '../../lib/ports.js';

function formatUptime(timestamp) {
  if (!timestamp) return '-';
  return formatDurationMs(Date.now() - timestamp);
}

export function BrowserStatusCard({ status, isRunning, isConnected, loading }) {
  return (
    <div className="bg-port-card border border-port-border rounded-xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
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
          {isConnected ? 'Connected' : isRunning ? 'Running (not connected)' : loading ? 'Checking…' : !status ? 'Unknown' : 'Stopped'}
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
  );
}

export function BrowserSidebar({ status }) {
  return (
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
            <span className="text-gray-400 text-sm">Mode</span>
            <span className={`text-sm font-medium ${(status?.headless ?? status?.config?.headless) === false ? 'text-port-warning' : 'text-port-success'}`}>
              {(status?.headless ?? status?.config?.headless) === false ? 'Headed (visible)' : 'Headless'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-400 text-sm">Auto-connect</span>
            <span className={`text-sm font-medium ${status?.config?.autoConnect ? 'text-port-success' : 'text-gray-500'}`}>
              {status?.config?.autoConnect ? 'Yes' : 'No'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-400 text-sm">Downloads</span>
            <span className="text-sm font-medium text-port-success">{pluralize(status?.downloads?.files?.length ?? 0, 'file')}</span>
          </div>
        </div>
      </div>

      {/* CDP Endpoint card */}
      <div className="bg-port-card border border-port-border rounded-xl p-4">
        <h3 className="font-semibold text-white mb-3">CDP Endpoint</h3>
        <div className="bg-port-bg rounded-lg p-3 font-mono text-xs text-port-accent break-all">
          {status?.cdpEndpoint || `ws://127.0.0.1:${PORTS.CDP}`}
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
          <li>2. To sign in to sites, disable headless in Config, restart, then navigate to the login page</li>
          <li>3. Auth cookies persist across restarts in the browser profile</li>
          <li>4. Switch back to headless after authenticating</li>
        </ul>
      </div>
    </div>
  );
}
