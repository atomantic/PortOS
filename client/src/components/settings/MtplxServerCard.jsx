import { useState } from 'react';
import { Link } from 'react-router';
import { Gauge, RefreshCw, ExternalLink, Save, Square, Download, Terminal } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';
import MtplxCheckpoints from './MtplxCheckpoints.jsx';

/**
 * MTPLX launcher — the same shape as the llama.cpp launcher below it, because
 * MTPLX is managed the same way: a PM2 process (`portos-mtplx`) PortOS starts,
 * stops, logs, and can persist across a reboot.
 *
 * Weights are managed here too, in `MtplxCheckpoints` below: search, download,
 * remove. A download is never implicit — it moves tens of gigabytes and only
 * runs from a button that says so — but it IS in the app, because sending the
 * user to a terminal for the one step in the middle of a managed lifecycle is a
 * dead end (PRD NR-9). See `docs/features/mtplx.md`.
 */

const btnClass = 'flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg transition-colors disabled:opacity-50';

export default function MtplxServerCard({
  status,
  loading,
  busy,
  actionInProgress,
  onRefresh,
  onSaveLaunch,
  onStart,
  onStop,
  onInstall,
  onSearchModels,
  onPullModel,
  onRemoveModel,
  download,
}) {
  // '' = let PortOS pick from the cache (which is also what the readiness
  // checklist's one-click setup does).
  const [model, setModel] = useState('');
  const [port, setPort] = useState('');
  const [showLogs, setShowLogs] = useState(false);

  const cached = status?.cachedModels || [];
  // Rows carry size/verification for the manage-checkpoints list; older status
  // payloads (a peer or a tab open across an upgrade) carry only the ids.
  const cachedRows = status?.cachedModelRows || cached.map((repo) => ({ repo }));
  const emptyCache = Boolean(status?.installed) && cached.length === 0 && !status?.cacheError;
  // The Homebrew `mtplx` is a wrapper that downloads its real Python runtime on
  // first run, so "on PATH" and "can serve" are two different facts. Older
  // status payloads (a peer, or a tab left open across an upgrade) carry no
  // `runtimeReady` at all — treat those as ready, which is what the card did
  // before this field existed.
  const runtimeMissing = Boolean(status?.installed) && status?.runtimeReady === false;
  const external = status?.running && status?.managed === false;
  const tuningFlags = status?.tuningFlags || [];

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Gauge size={16} className="text-port-accent" />
          <h2 className="text-sm font-medium text-gray-300">MTPLX (native multi-token prediction)</h2>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={onRefresh}
            disabled={loading}
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-400 hover:text-white transition-colors"
            title="Refresh MTPLX status"
            aria-label="Refresh MTPLX status"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
          <Link to="/ai" className="text-xs text-port-accent hover:underline flex items-center gap-1">
            MTPLX presets in AI Providers <ExternalLink size={11} />
          </Link>
        </div>
      </div>

      <p className="text-xs text-gray-400 leading-relaxed">
        MTPLX runs Qwen checkpoints with native multi-token-prediction decoding on Apple Silicon and serves them over an OpenAI-compatible loopback API. PortOS manages it as a PM2 process, exactly like <code className="text-gray-300">llama-server</code> — start it here, then pick an <strong className="text-white">MTPLX</strong> preset in AI Providers. Search for and download MTP checkpoints below — PortOS never fetches weights on its own, but every download, removal, and launch happens here.
      </p>

      {!status ? (
        <p className="text-xs text-gray-500">Checking for MTPLX…</p>
      ) : status.supported === false ? (
        <p className="text-xs text-gray-500">{status.unsupportedReason || 'MTPLX runs only on macOS with Apple Silicon.'}</p>
      ) : !status.installed ? (
        <div className="bg-port-warning/10 border border-port-warning/30 rounded-lg p-3 text-xs text-port-warning flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="font-semibold">`mtplx` was not detected on system PATH.</p>
            <p className="text-gray-300">Installs from upstream's Homebrew tap, or with pip on a host without Homebrew.</p>
          </div>
          <button onClick={onInstall} disabled={busy} className={`${btnClass} bg-port-accent/20 hover:bg-port-accent/30 text-port-accent shrink-0`}>
            {actionInProgress === 'runtime-install-mtplx' ? <BrailleSpinner /> : <Download size={13} />}
            Install MTPLX
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
              {/*
                A measured assessment relaunches this daemon with tuning flags
                and leaves them on. Every later request through the `mtplx`
                provider runs under them, so a card that showed only the model
                would report a server as plain "running" while it is serving
                with, say, MTP decoding switched off.
              */}
              {tuningFlags.length > 0 && (
                <p><span className="text-gray-500">Tuning:</span> <code className="text-port-warning">{tuningFlags.join(' ')}</code></p>
              )}
              {external && (
                <p className="text-blue-300">Started outside PortOS — stop it where you started it.</p>
              )}
            </div>
            {!external && (
              <button onClick={onStop} disabled={busy} className={`${btnClass} bg-port-warning/20 hover:bg-port-warning/30 text-port-warning shrink-0`}>
                {actionInProgress === 'runtime-stop-mtplx' ? <BrailleSpinner /> : <Square size={13} />}
                Stop MTPLX
              </button>
            )}
          </div>
        </div>
      ) : runtimeMissing ? (
        <div className="bg-port-warning/10 border border-port-warning/30 rounded-lg p-3 text-xs text-port-warning flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="font-semibold">Installed — runtime not yet downloaded.</p>
            <p className="text-gray-300">
              Homebrew installs a wrapper that fetches MTPLX itself (several hundred megabytes of
              Python and MLX) the first time it runs. PortOS will not do that inside a status poll
              or a server start, so run it here — it streams into the install progress and takes a
              few minutes.
            </p>
          </div>
          <button onClick={onInstall} disabled={busy} className={`${btnClass} bg-port-accent/20 hover:bg-port-accent/30 text-port-accent shrink-0`}>
            {actionInProgress === 'runtime-install-mtplx' ? <BrailleSpinner /> : <Download size={13} />}
            Download MTPLX runtime
          </button>
        </div>
      ) : (
        <div className="bg-port-bg border border-port-border rounded-lg p-3 space-y-3">
          {emptyCache ? (
            <p className="text-xs text-port-warning">
              MTPLX's model cache is empty, so its server exits before it binds a port. Download a checkpoint below — the first request that needs MTPLX will start it on one.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label htmlFor="mtplx-model" className="block text-xs text-gray-400">Checkpoint</label>
                <select
                  id="mtplx-model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full bg-port-card border border-port-border rounded px-2 py-1.5 text-xs text-white"
                >
                  <option value="">Auto — first verified checkpoint in the cache</option>
                  {cached.map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <label htmlFor="mtplx-port" className="block text-xs text-gray-400">Port</label>
                <input
                  id="mtplx-port"
                  type="number"
                  value={port}
                  placeholder={String(status?.port ?? 8000)}
                  onChange={(e) => setPort(e.target.value)}
                  className="w-full bg-port-card border border-port-border rounded px-2 py-1.5 text-xs text-white"
                />
                <p className="text-[11px] text-gray-500">Must match the endpoint your MTPLX provider points at.</p>
              </div>
            </div>
          )}
          {status?.cacheError && (
            <p className="text-xs text-gray-500">Couldn't read MTPLX's model cache ({status.cacheError}) — an on-demand start will fall through to MTPLX's own default checkpoint.</p>
          )}
          <p className="text-[11px] text-gray-500">
            MTPLX starts on demand when a request needs it. You can also start it now with the
            cached checkpoint; its idle window (set under Local Runtime Servers) stops it again to
            release the checkpoint. Neither path downloads weights without an explicit download.
          </p>
          {!emptyCache && onStart && (
            <button
              onClick={() => onStart({ model: model || null, ...(port ? { port: Number(port) } : {}) })}
              disabled={busy}
              className={`${btnClass} bg-port-success/20 hover:bg-port-success/30 text-port-success`}
              title="Start MTPLX with the cached checkpoint; no weights are downloaded"
            >
              {actionInProgress === 'runtime-start-mtplx' ? <BrailleSpinner /> : <Terminal size={13} />}
              Start MTPLX
            </button>
          )}
          <button
            onClick={() => onSaveLaunch({ model: model || null, ...(port ? { port: Number(port) } : {}) })}
            disabled={busy || emptyCache}
            className={`${btnClass} bg-port-accent/20 hover:bg-port-accent/30 text-port-accent`}
            title={emptyCache ? 'Download an MTP checkpoint below first — a start never fetches weights' : 'Remember these options for the next on-demand start'}
          >
            {actionInProgress === 'runtime-save-mtplx-launch' ? <BrailleSpinner /> : <Save size={13} />}
            Save configuration
          </button>
        </div>
      )}

      {status?.installed && status?.supported !== false && !runtimeMissing && (
        <MtplxCheckpoints
          cached={cachedRows}
          cacheError={status?.cacheError || null}
          download={download}
          busy={busy}
          actionInProgress={actionInProgress}
          onSearch={onSearchModels}
          onPull={onPullModel}
          onRemove={onRemoveModel}
        />
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
            <pre className="text-[10px] text-gray-400 bg-port-bg border border-port-border/60 p-2.5 rounded max-h-40 overflow-y-auto font-mono whitespace-pre-wrap break-all">
              {status.recentLogs.join('\n')}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
