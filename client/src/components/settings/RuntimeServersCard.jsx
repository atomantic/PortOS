import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Cpu, Box, Zap, Gauge, Play, Square, Download, ArrowUpCircle, Power, PowerOff, RefreshCw, Save, Settings2, ExternalLink } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';

/**
 * One control surface for every local LLM server PortOS can run.
 *
 * Ollama, LM Studio, llama.cpp (`llama-server`) and MTPLX each used to be
 * managed somewhere different — two of them inline on this tab, one further down
 * behind the speculative-decoding launcher, and MTPLX only from a provider
 * readiness checklist on another page. They all answer the same three questions
 * ("installed?", "running?", "start it / stop it"), so they get one table that
 * asks them the same way.
 *
 * The runtimes are NOT mutually exclusive: any number of them can be installed
 * and running at once. Which one PortOS routes a given run to is a separate
 * decision — the default backend below, or the provider a task names.
 */

/** Uniform lifecycle state for a row, from each runtime's own status shape. */
const STATE_META = {
  running: { label: 'Running', cls: 'bg-port-success/20 text-port-success', dot: 'bg-port-success animate-pulse' },
  external: { label: 'Running (external)', cls: 'bg-blue-500/20 text-blue-300', dot: 'bg-blue-400' },
  stopped: { label: 'Stopped', cls: 'bg-port-warning/20 text-port-warning', dot: 'bg-port-warning' },
  missing: { label: 'Not installed', cls: 'bg-gray-500/20 text-gray-400', dot: 'bg-gray-500' },
  disabled: { label: 'Disabled', cls: 'bg-gray-500/20 text-gray-400', dot: 'bg-gray-600' },
  unsupported: { label: 'Unavailable on this platform', cls: 'bg-gray-500/20 text-gray-400', dot: 'bg-gray-600' },
};

const btnClass = 'flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded transition-colors disabled:opacity-50';
const neutralBtn = `${btnClass} bg-port-border hover:bg-port-border/70 text-white`;
const accentBtn = `${btnClass} bg-port-accent/20 hover:bg-port-accent/30 text-port-accent`;

/**
 * Rows for the two backends PortOS installs and catalogs models for.
 *
 * `managed` is deliberately absent: PortOS does not own these processes (Ollama
 * runs as a Homebrew/systemd service, LM Studio's server belongs to its app), so
 * "running" is all that can honestly be reported — there is no external-vs-ours
 * distinction to draw.
 */
function backendRow({ id, label, icon, data, onStart, onStop, onInstall }) {
  const state = data?.disabled ? 'disabled' : data?.available ? 'running' : data?.installed ? 'stopped' : 'missing';
  return {
    id,
    label,
    icon,
    state,
    endpoint: data?.baseUrl || null,
    detail: data?.installed && Number.isFinite(data?.modelCount)
      ? `${data.modelCount} model${data.modelCount === 1 ? '' : 's'} installed`
      : null,
    onInstall: !data?.installed && data?.canAutoInstall ? onInstall : null,
    downloadUrl: !data?.installed && !data?.canAutoInstall ? data?.downloadUrl : null,
    onStart: data?.installed && !data?.available ? onStart : null,
    onStop: data?.available ? onStop : null,
  };
}

/**
 * Rows for the two daemons PortOS runs as PM2 processes.
 *
 * These DO distinguish ours from external: `managed === false` while something
 * answers on the port means a server the user started in a terminal, which
 * PortOS must not offer to stop.
 */
function pm2Row({ id, label, icon, status, platformReason, onStart, onStop, onInstall, onUpgrade, startBlockedReason, detail }) {
  const external = status?.running && status?.managed === false;
  const updateAvailable = !platformReason && status?.installed && status?.updateAvailable === true;
  const state = platformReason ? 'unsupported'
    : status?.running ? (external ? 'external' : 'running')
      : status?.installed ? 'stopped' : 'missing';
  return {
    id,
    label,
    icon,
    state,
    endpoint: status?.endpoint || null,
    detail: platformReason || detail || null,
    pm2: true,
    runAtStartup: status?.runAtStartup ?? null,
    pid: status?.managed && status?.pid ? status.pid : null,
    // `status` is null until the first poll lands. Offering Install then would
    // put a button on a host that turns out not to support the runtime at all.
    onInstall: status && !platformReason && !status.installed ? onInstall : null,
    onStart: !platformReason && status?.installed && !status?.running && !startBlockedReason ? onStart : null,
    startBlockedReason: status?.installed && !status?.running ? startBlockedReason : null,
    onStop: !external && status?.running ? onStop : null,
    version: status?.version || null,
    latestVersion: status?.latestVersion || null,
    updateAvailable,
    onUpgrade: updateAvailable && status?.canUpgrade ? onUpgrade : null,
    updateUrl: updateAvailable && !status?.canUpgrade ? status?.downloadUrl : null,
  };
}

/**
 * The per-daemon "release the model when nothing is using it" window.
 *
 * The two daemons honour this the same way from the user's side and in two very
 * different ways underneath, which is why the copy is per-row rather than shared:
 * llama.cpp unloads the checkpoint IN PLACE (`--sleep-idle-seconds`) and reloads
 * it on the next request without the process ever going away, while MTPLX — which
 * cannot unload anything but its retrieval models — is stopped outright and
 * started again by the next request that needs it.
 *
 * `0` means never release, which is what every install did before this setting
 * existed and is still the default.
 *
 * Committed on blur/Enter rather than per keystroke: each save is a settings
 * PATCH, and a three-digit window would otherwise write three times.
 */
function IdleWindowField({ id, value, onSave, busy, note }) {
  const [draft, setDraft] = useState(String(value ?? 0));
  // Re-sync when the saved value changes underneath (a refresh, another tab) —
  // but never while the field is being edited, which would fight the typist.
  useEffect(() => { setDraft(String(value ?? 0)); }, [value]);

  const commit = () => {
    const next = Number(draft);
    if (!Number.isFinite(next) || next < 0) { setDraft(String(value ?? 0)); return; }
    const clamped = Math.min(1440, Math.floor(next));
    setDraft(String(clamped));
    if (clamped !== (value ?? 0)) onSave(clamped);
  };

  const fieldId = `idle-window-${id}`;
  return (
    <div className="flex items-center gap-1.5">
      <label htmlFor={fieldId} className="text-xs text-gray-500 whitespace-nowrap">
        Idle release
      </label>
      <input
        id={fieldId}
        type="number"
        min="0"
        max="1440"
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        className="w-16 px-1.5 py-1 text-xs bg-port-bg border border-port-border rounded text-white disabled:opacity-50"
        title={note}
      />
      <span className="text-xs text-gray-500 whitespace-nowrap" title={note}>
        min {Number(draft) === 0 ? '(never)' : ''}
      </span>
    </div>
  );
}

/**
 * Every action is invoked as `row.onX()`, never bound straight to `onClick` —
 * React would hand the handler its SyntheticEvent as the first argument, and a
 * handler that takes a launch config (MTPLX's start) would serialize the event
 * into the request body instead of the config.
 */
function ServerRow({ row, busy, actionInProgress, children }) {
  const Icon = row.icon;
  const meta = STATE_META[row.state] || STATE_META.missing;
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 bg-port-bg border border-port-border rounded-lg px-3 py-2">
      <div className="flex items-center gap-2 min-w-0 sm:w-44 shrink-0">
        <Icon size={14} className="text-port-accent shrink-0" />
        <span className="text-sm text-white truncate">{row.label}</span>
      </div>
      <div className="flex items-center gap-2 flex-wrap min-w-0 flex-1">
        <span className={`px-2 py-0.5 text-xs rounded flex items-center gap-1.5 ${meta.cls}`}>
          <span className={`w-2 h-2 rounded-full ${meta.dot}`} />
          {meta.label}{row.pid ? ` (PID ${row.pid})` : ''}
        </span>
        {row.endpoint && (
          <code className="text-xs text-gray-500 truncate max-w-full">{row.endpoint}</code>
        )}
        {row.version && <span className="text-xs text-gray-500">v{row.version}</span>}
        {row.updateAvailable && row.latestVersion && (
          <span
            className="text-xs text-port-warning"
            title={`${row.label} v${row.latestVersion} is available (you have ${row.version ? `v${row.version}` : 'an older version'})`}
          >
            v{row.latestVersion} available
          </span>
        )}
        {row.pm2 && row.runAtStartup && (
          <span className="px-1.5 py-0.5 text-xs rounded border border-port-success/40 text-port-success" title="This PM2 process is in the saved list `pm2 resurrect` replays at boot">
            starts at boot
          </span>
        )}
        {row.detail && <span className="text-xs text-gray-500">{row.detail}</span>}
      </div>
      <div className="flex items-center gap-2 flex-wrap shrink-0">
        {children}
        {row.onInstall && (
          <button
            onClick={() => row.onInstall()}
            disabled={busy}
            className={accentBtn}
            title={`Install ${row.label} on this machine`}
          >
            {actionInProgress === `runtime-install-${row.id}` ? <BrailleSpinner /> : <Download size={12} />}
            Install
          </button>
        )}
        {row.downloadUrl && (
          <a
            href={row.downloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={`${neutralBtn} no-underline`}
            title={`PortOS can't install ${row.label} on this platform — download it from the vendor`}
          >
            <ExternalLink size={12} />
            Download
          </a>
        )}
        {row.onStart && (
          <button
            onClick={() => row.onStart()}
            disabled={busy}
            className={neutralBtn}
            title={`Start the local ${row.label} server`}
          >
            {actionInProgress === `runtime-start-${row.id}` ? <BrailleSpinner /> : <Play size={12} />}
            Start
          </button>
        )}
        {row.startBlockedReason && (
          <span className="text-xs text-gray-500 max-w-xs">{row.startBlockedReason}</span>
        )}
        {row.onStop && (
          <button
            onClick={() => row.onStop()}
            disabled={busy}
            className={neutralBtn}
            title={`Stop the local ${row.label} server`}
          >
            {actionInProgress === `runtime-stop-${row.id}` ? <BrailleSpinner /> : <Square size={12} />}
            Stop
          </button>
        )}
        {row.onUpgrade && (
          <button
            onClick={() => row.onUpgrade()}
            disabled={busy}
            className={`${accentBtn} bg-port-success/20 hover:bg-port-success/30 text-port-success`}
            title={row.latestVersion ? `Update ${row.label} to v${row.latestVersion} through Homebrew` : `Update ${row.label} through Homebrew`}
          >
            {actionInProgress === `runtime-upgrade-${row.id}` ? <BrailleSpinner /> : <ArrowUpCircle size={12} />}
            {row.latestVersion ? `Update to v${row.latestVersion}` : 'Update'}
          </button>
        )}
        {row.updateUrl && (
          <a
            href={row.updateUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={`${neutralBtn} no-underline text-port-warning`}
            title={`${row.label} has an update, but PortOS cannot update this installation automatically`}
          >
            <ExternalLink size={12} />
            Update available
          </a>
        )}
      </div>
    </div>
  );
}

export default function RuntimeServersCard({
  status,
  llamaStatus,
  mtplxStatus,
  loading,
  busy,
  actionInProgress,
  onRefresh,
  onControlOllama,
  onControlLmStudio,
  onInstallBackend,
  onInstallLlama,
  onUpgradeLlama,
  onStopLlama,
  onConfigureLlama,
  onConfigureMtplx,
  onInstallMtplx,
  onStartMtplx,
  onStopMtplx,
  onSaveStartup,
  onSaveIdleWindow,
}) {
  // Read off each daemon's own status payload — the same place `runAtStartup`
  // and Ollama's `disabled` come from — so there is no second settings fetch on
  // this tab to keep in sync.
  const idleWindows = { llama: llamaStatus?.idleMinutes ?? 0, mtplx: mtplxStatus?.idleMinutes ?? 0 };
  const ollamaService = status?.ollama?.service;
  const ollamaRunsAtStartup = Boolean(ollamaService?.runAtStartup);

  const rows = [
    backendRow({
      id: 'ollama',
      label: 'Ollama',
      icon: Cpu,
      data: status?.ollama,
      onInstall: () => onInstallBackend('ollama'),
      onStart: () => onControlOllama('start'),
      onStop: () => onControlOllama('stop'),
    }),
    backendRow({
      id: 'lmstudio',
      label: 'LM Studio',
      icon: Box,
      data: status?.lmstudio,
      onInstall: () => onInstallBackend('lmstudio'),
      onStart: () => onControlLmStudio('start'),
      onStop: () => onControlLmStudio('stop'),
    }),
    pm2Row({
      id: 'llama',
      label: 'llama.cpp',
      icon: Zap,
      status: llamaStatus,
      onInstall: onInstallLlama,
      onUpgrade: onUpgradeLlama,
      onStop: onStopLlama,
      // llama-server takes a REQUIRED model path, and which GGUF (plus which
      // drafter and spec type) is a real choice — so there is no honest one-click
      // Start here. The launcher below owns it.
      startBlockedReason: 'Pick a model in Speculative Decoding below to start it',
    }),
    pm2Row({
      id: 'mtplx',
      label: 'MTPLX',
      icon: Gauge,
      status: mtplxStatus,
      platformReason: mtplxStatus?.supported === false ? 'macOS with Apple Silicon only' : null,
      onInstall: onInstallMtplx,
      // MTPLX can be started explicitly when a verified checkpoint is cached,
      // and is still restarted automatically before a request after an idle
      // release. Neither path downloads or guesses a model.
      onStart: mtplxStatus?.cachedModels?.length ? onStartMtplx : null,
      onStop: onStopMtplx,
      startBlockedReason: mtplxStatus?.installed && !mtplxStatus?.running
        ? (mtplxStatus?.cachedModels?.length === 0 && !mtplxStatus?.cacheError
          ? 'No checkpoint yet — use Configure to download one'
          : null)
        : null,
      detail: mtplxStatus?.cachedModels?.length
        ? `${mtplxStatus.cachedModels.length} checkpoint${mtplxStatus.cachedModels.length === 1 ? '' : 's'} cached`
        : null,
    }),
  ];

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-gray-300">Local Runtime Servers</h2>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="p-1.5 text-gray-400 hover:text-white transition-colors"
          title="Refresh runtime server status"
          aria-label="Refresh runtime server status"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      <p className="text-xs text-gray-500">
        Every local server PortOS can run, in one place. They are not mutually exclusive — install and run as many as you like. Which one a run goes to is a separate choice: the <span className="text-gray-400">Default</span> backend below, or the provider a task names in <Link to="/ai" className="text-port-accent hover:underline">AI Providers</Link>.
      </p>

      <div className="space-y-2">
        {rows.map((row) => (
          <ServerRow key={row.id} row={row} busy={busy} actionInProgress={actionInProgress}>
            {row.id === 'ollama' && ollamaService?.supported && (
              <button
                onClick={() => onControlOllama(ollamaRunsAtStartup ? 'disable' : 'enable')}
                disabled={busy}
                className={neutralBtn}
                title={ollamaRunsAtStartup
                  ? 'Stop the background service and remove the launch-at-login registration'
                  : 'Run Ollama in the background at login via its own service manager'}
              >
                {actionInProgress === `runtime-startup-ollama` ? <BrailleSpinner /> : ollamaRunsAtStartup ? <PowerOff size={12} /> : <Power size={12} />}
                {ollamaRunsAtStartup ? 'Disable at login' : 'Run at login'}
              </button>
            )}
            {(row.id === 'llama' || row.id === 'mtplx') && row.state !== 'unsupported' && row.state !== 'missing' && (
              <IdleWindowField
                id={row.id}
                value={idleWindows[row.id] ?? 0}
                busy={busy}
                onSave={(minutes) => onSaveIdleWindow?.(row.id, minutes)}
                note={row.id === 'llama'
                  ? 'Minutes of PortOS inactivity after which llama.cpp unloads the model in place and reloads it on the next request. 0 = keep it resident. Applies from the next start.'
                  : 'Minutes of PortOS inactivity after which MTPLX is stopped. The next PortOS request starts it again on the same checkpoint. 0 = keep it running.'}
              />
            )}
            {(row.id === 'llama' || row.id === 'mtplx') && row.state !== 'unsupported' && (
              <button
                onClick={row.id === 'llama' ? onConfigureLlama : onConfigureMtplx}
                className={neutralBtn}
                title={`Jump to the ${row.label} launcher below`}
              >
                <Settings2 size={12} />
                Configure
              </button>
            )}
          </ServerRow>
        ))}
      </div>

      <p className="text-xs text-gray-500">
        <span className="text-gray-400">Idle release</span> puts a model down when nothing has used it for that many minutes — llama.cpp unloads it in place and reloads it on the next request; MTPLX is stopped and restarted on demand. <span className="text-gray-400">Only PortOS traffic counts.</span> A client hitting these ports directly is invisible to the timer and cannot lazily start a stopped server, so set <code className="text-gray-400">0</code> for a daemon you drive from outside PortOS.
      </p>

      <div className="flex flex-col sm:flex-row sm:items-center gap-2 pt-1">
        <button onClick={onSaveStartup} disabled={busy} className={accentBtn} title="Run `pm2 save` so the running PM2 processes are in the list a reboot resurrects">
          {actionInProgress === 'runtime-save-startup' ? <BrailleSpinner /> : <Save size={12} />}
          Save PM2 list for reboot
        </button>
        <p className="text-xs text-gray-500">
          llama.cpp and MTPLX run as PM2 processes (<code className="text-gray-400">portos-llama-server</code>, <code className="text-gray-400">portos-mtplx</code>). Saving snapshots what is running now so it comes back after a reboot — this needs <code className="text-gray-400">pm2 startup</code> to have been run once in a terminal, which is a privileged one-time step PortOS deliberately leaves to you. <span className="text-gray-400">MTPLX is deliberately left out of that snapshot</span>: it starts on demand when a request needs it, so resurrecting it at boot would only pin its checkpoint on an idle machine. Ollama and LM Studio manage their own launch-at-login.
        </p>
      </div>
    </div>
  );
}
