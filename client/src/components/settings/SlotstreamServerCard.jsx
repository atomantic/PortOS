import { useEffect, useState } from 'react';
import { HardDrive, RefreshCw, Save, Square, Download, Terminal } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';

/**
 * Slotstream launcher — the same shape as the MTPLX launcher above it: a PM2
 * process (`portos-slotstream`) PortOS starts, stops, logs, and can idle-stop.
 *
 * Weights are a later, explicit user action. A start never fetches them. The
 * memory plan (target / peak / warm decode) is shown here rather than hidden,
 * and an explicit memory-cap override is saved onto the launch line an
 * on-demand start replays.
 */

const btnClass = 'flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg transition-colors disabled:opacity-50';

export default function SlotstreamServerCard({
  status,
  loading,
  busy,
  actionInProgress,
  onRefresh,
  onSaveLaunch,
  onStart,
  onStop,
  onInstall,
}) {
  const [model, setModel] = useState('');
  const [port, setPort] = useState('');
  const [memoryGb, setMemoryGb] = useState('');
  const [seeded, setSeeded] = useState(false);
  const [showLogs, setShowLogs] = useState(false);

  // Seed the form from the saved launch line ONCE the status arrives.
  // Without this the memory cap the user saved is invisible on the next visit,
  // and re-saving after any other edit silently drops it — `launchPayload`
  // omits an empty field. Guarded by `seeded` rather than keyed on `status`, so
  // a refresh mid-edit does not overwrite what the user is typing.
  const launch = status?.launch;
  useEffect(() => {
    if (seeded || !launch) return;
    setModel(launch.model || '');
    setPort(launch.port == null ? '' : String(launch.port));
    setMemoryGb(launch.memoryGb == null ? '' : String(launch.memoryGb));
    setSeeded(true);
  }, [launch, seeded]);

  const cached = status?.cachedModels || [];
  const emptyCache = Boolean(status?.installed) && cached.length === 0 && !status?.cacheError;
  const external = status?.running && status?.managed === false;
  const plan = status?.memoryPlan;

  const launchPayload = () => ({
    model: model || null,
    ...(port ? { port: Number(port) } : {}),
    ...(memoryGb ? { memoryGb: Number(memoryGb) } : {}),
  });

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <HardDrive size={16} className="text-port-accent" />
          <h2 className="text-sm font-medium text-gray-300">Slotstream (SSD-streaming MoE)</h2>
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="p-1 text-gray-400 hover:text-white transition-colors"
          title="Refresh Slotstream status"
          aria-label="Refresh Slotstream status"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <p className="text-xs text-gray-400 leading-relaxed">
        Slotstream runs a mixture-of-experts checkpoint larger than this Mac&apos;s RAM by keeping a small dense trunk resident and streaming experts from SSD into a fixed cache. Cache size trades speed against memory and never changes output. PortOS manages it as a PM2 process on a dedicated loopback port — never 11434, which is a PortOS-managed Ollama.
      </p>

      {plan && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs bg-port-bg border border-port-border rounded-lg px-3 py-2">
          <p><span className="text-gray-500">Target</span> <span className="text-white">{plan.targetGb} GB{plan.auto ? ' (auto)' : ''}</span></p>
          <p><span className="text-gray-500">Expected peak</span> <span className="text-white">{plan.expectedPeakGb} GB</span></p>
          <p><span className="text-gray-500">Warm decode</span> <span className="text-white">~{plan.expectedWarmDecodeToks} tok/s</span></p>
        </div>
      )}

      {!status ? (
        <p className="text-xs text-gray-500">Checking for Slotstream…</p>
      ) : status.supported === false ? (
        <p className="text-xs text-gray-500">{status.unsupportedReason || 'Slotstream runs only on macOS with Apple Silicon.'}</p>
      ) : !status.installed ? (
        <div className="bg-port-warning/10 border border-port-warning/30 rounded-lg p-3 text-xs text-port-warning flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="font-semibold">Slotstream was not detected on this machine.</p>
            <p className="text-gray-300">Installs the Apple Silicon release into ~/.slotstream/bin. Does not download model weights.</p>
          </div>
          <button onClick={onInstall} disabled={busy} className={`${btnClass} bg-port-accent/20 hover:bg-port-accent/30 text-port-accent shrink-0`}>
            {actionInProgress === 'runtime-install-slotstream' ? <BrailleSpinner /> : <Download size={13} />}
            Install Slotstream
          </button>
        </div>
      ) : status.running ? (
        <div className="bg-port-bg border border-port-success/30 rounded-lg p-3 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="text-xs text-gray-300 space-y-1">
              <p><span className="text-gray-500">Endpoint:</span> <code className="text-port-success">{status.endpoint}</code></p>
              {status.config?.model && (
                <p><span className="text-gray-500">Model:</span> <code className="text-gray-300">{status.config.model}</code></p>
              )}
              {status.config?.memoryGb && (
                <p><span className="text-gray-500">Memory cap:</span> <code className="text-gray-300">{status.config.memoryGb} GB</code></p>
              )}
              {external && (
                <p className="text-blue-300">Started outside PortOS — stop it where you started it.</p>
              )}
            </div>
            {!external && (
              <button onClick={onStop} disabled={busy} className={`${btnClass} bg-port-warning/20 hover:bg-port-warning/30 text-port-warning shrink-0`}>
                {actionInProgress === 'runtime-stop-slotstream' ? <BrailleSpinner /> : <Square size={13} />}
                Stop Slotstream
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="bg-port-bg border border-port-border rounded-lg p-3 space-y-3">
          {emptyCache ? (
            <p className="text-xs text-port-warning">
              No checkpoint is cached, so a start would exit before it binds a port. A start never downloads weights — place a checkpoint directory in <code className="text-gray-300">{status.cacheDir || '~/.slotstream/models'}</code>, then start Slotstream again.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1">
                <label htmlFor="slotstream-model" className="block text-xs text-gray-400">Checkpoint</label>
                <select
                  id="slotstream-model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full bg-port-card border border-port-border rounded px-2 py-1.5 text-xs text-white"
                >
                  <option value="">Auto — first checkpoint in the cache</option>
                  {cached.map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <label htmlFor="slotstream-port" className="block text-xs text-gray-400">Port</label>
                <input
                  id="slotstream-port"
                  type="number"
                  value={port}
                  placeholder={String(status?.port ?? 5564)}
                  onChange={(e) => setPort(e.target.value)}
                  className="w-full bg-port-card border border-port-border rounded px-2 py-1.5 text-xs text-white"
                />
                <p className="text-[11px] text-gray-500">Dedicated loopback port. Never 11434.</p>
              </div>
              <div className="space-y-1">
                <label htmlFor="slotstream-memory" className="block text-xs text-gray-400">Memory cap (GB)</label>
                <input
                  id="slotstream-memory"
                  type="number"
                  min="6"
                  value={memoryGb}
                  placeholder={plan ? String(plan.targetGb) : 'auto'}
                  onChange={(e) => setMemoryGb(e.target.value)}
                  className="w-full bg-port-card border border-port-border rounded px-2 py-1.5 text-xs text-white"
                />
                <p className="text-[11px] text-gray-500">Empty = auto-size from this Mac&apos;s RAM.</p>
              </div>
            </div>
          )}
          {status?.cacheError && (
            <p className="text-xs text-gray-500">Couldn&apos;t read Slotstream&apos;s model cache ({status.cacheError}).</p>
          )}
          <p className="text-[11px] text-gray-500">
            Slotstream starts on demand when a request needs it. You can also start it now with a cached checkpoint; its idle window (set under Local Runtime Servers) stops it again. Neither path downloads weights.
          </p>
          {!emptyCache && onStart && (
            <button
              onClick={() => onStart(launchPayload())}
              disabled={busy}
              className={`${btnClass} bg-port-success/20 hover:bg-port-success/30 text-port-success`}
              title="Start Slotstream with the cached checkpoint; no weights are downloaded"
            >
              {actionInProgress === 'runtime-start-slotstream' ? <BrailleSpinner /> : <Terminal size={13} />}
              Start Slotstream
            </button>
          )}
          <button
            onClick={() => onSaveLaunch(launchPayload())}
            disabled={busy || emptyCache}
            className={`${btnClass} bg-port-accent/20 hover:bg-port-accent/30 text-port-accent`}
            title={emptyCache ? 'Add a checkpoint first — a start never fetches weights' : 'Remember these options for the next on-demand start'}
          >
            {actionInProgress === 'runtime-save-slotstream-launch' ? <BrailleSpinner /> : <Save size={13} />}
            Save configuration
          </button>
        </div>
      )}

      {status?.recentLogs?.length > 0 && (
        <div className="space-y-1">
          <button
            type="button"
            onClick={() => setShowLogs((prev) => !prev)}
            className="text-[11px] text-gray-500 hover:text-gray-300 flex items-center gap-1"
          >
            <Terminal size={11} />
            {showLogs ? 'Hide server logs' : `View server logs (${status.recentLogs.length} lines)`}
          </button>
          {showLogs && (
            <pre className="text-[10px] text-gray-400 bg-port-bg border border-port-border/60 p-2.5 rounded max-h-40 overflow-y-auto font-mono whitespace-pre-wrap">
              {status.recentLogs.join('\n')}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
