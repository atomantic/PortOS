import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Cpu, Box, Play, Square, Download, ArrowUpCircle, Power, PowerOff, RefreshCw, Save, Settings2, ExternalLink, Server } from 'lucide-react';
import RuntimeLogDisclosure from './RuntimeLogDisclosure.jsx';
import BrailleSpinner from '../BrailleSpinner';
import ContextWindowSelect from '../ui/ContextWindowSelect.jsx';
import { formatContextTokens, formatCount } from '../../utils/formatters';
import { SPLASH_CONTEXT, SPLASH_CONTEXT_WINDOWS } from '../../../../server/lib/splashRuntime.js';
import { LOCAL_RUNTIME_LABELS } from '../../../../server/lib/modelPinMembership.js';

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
  installing: { label: 'Installing', cls: 'bg-port-accent/20 text-port-accent', dot: 'bg-port-accent animate-pulse' },
  updating: { label: 'Updating', cls: 'bg-port-accent/20 text-port-accent', dot: 'bg-port-accent animate-pulse' },
  starting: { label: 'Starting', cls: 'bg-port-accent/20 text-port-accent', dot: 'bg-port-accent animate-pulse' },
  stopping: { label: 'Stopping', cls: 'bg-port-accent/20 text-port-accent', dot: 'bg-port-accent animate-pulse' },
  error: { label: 'Needs attention', cls: 'bg-port-error/20 text-port-error', dot: 'bg-port-error' },
  unknown: { label: 'Status unavailable', cls: 'bg-gray-500/20 text-gray-400', dot: 'bg-gray-500' },
  running: { label: 'Running', cls: 'bg-port-success/20 text-port-success', dot: 'bg-port-success animate-pulse' },
  external: { label: 'Running (external)', cls: 'bg-blue-500/20 text-blue-300', dot: 'bg-blue-400' },
  'not-ready': { label: 'Not ready', cls: 'bg-port-warning/20 text-port-warning', dot: 'bg-port-warning' },
  unrecognized: { label: 'Endpoint not verified', cls: 'bg-port-warning/20 text-port-warning', dot: 'bg-port-warning' },
  stopped: { label: 'Stopped', cls: 'bg-port-warning/20 text-port-warning', dot: 'bg-port-warning' },
  missing: { label: 'Not installed', cls: 'bg-gray-500/20 text-gray-400', dot: 'bg-gray-500' },
  disabled: { label: 'Disabled', cls: 'bg-gray-500/20 text-gray-400', dot: 'bg-gray-600' },
  unsupported: { label: 'Unavailable on this platform', cls: 'bg-gray-500/20 text-gray-400', dot: 'bg-gray-600' },
};

const btnClass = 'min-h-[44px] flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded transition-colors disabled:opacity-50';
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
function backendRow({ id, label, icon, data, onStart, onStop, onInstall, onUpgrade, startupControl }) {
  const state = !data ? 'unknown' : data?.disabled ? 'disabled' : data?.available ? 'running' : data?.installed ? 'stopped' : 'missing';
  // Same update contract as the PM2 rows, so an outdated backend shows on the
  // roster rather than only inside its detail card. Only Ollama reports one.
  const updateAvailable = Boolean(data?.installed && data?.updateAvailable === true);
  return {
    id,
    label,
    icon,
    configure: 'detail',
    startupControl,
    state,
    endpoint: data?.baseUrl || null,
    detail: data?.installed && Number.isFinite(data?.modelCount)
      ? `${formatCount(data.modelCount)} model${data.modelCount === 1 ? '' : 's'} installed`
      : null,
    onInstall: !data?.installed && data?.canAutoInstall ? onInstall : null,
    downloadUrl: !data?.installed && !data?.canAutoInstall ? data?.downloadUrl : null,
    onStart: data?.installed && !data?.available ? onStart : null,
    onStop: data?.available ? onStop : null,
    version: data?.installed ? data?.version || null : null,
    latestVersion: data?.latestVersion || null,
    updateAvailable,
    updateVia: data?.latestVersionSource === 'homebrew' ? 'Homebrew' : null,
    onUpgrade: updateAvailable && data?.canUpgrade && onUpgrade ? onUpgrade : null,
    updateUrl: updateAvailable && !data?.canUpgrade ? data?.downloadUrl || null : null,
  };
}

/**
 * The dedicated Qwen host — the one runtime on this page PortOS runs as a
 * DOCKER container rather than a PM2 process.
 *
 * It belongs here for the same reason as the rest: it is a local model server,
 * it is either up or it is not, and it can be stopped. Leaving it off was a
 * real dead end — enabling it lives on AI Providers → Model host setup, so an
 * operator who later came to the page named "Runtimes" to turn their GPU loose
 * again found every server they were NOT running and no sign of the one they
 * were.
 *
 * `onStart` is deliberately absent: a first start can mean cloning a compose
 * project and downloading ~30 GB, and the decision (and its progress stream)
 * belongs on the setup page that names the payload. Getting OUT does not need
 * that ceremony, so Stop is here.
 */
function fleetHostRow({ status, onStop }) {
  const up = Boolean(status?.listening || status?.runtimeReachable);
  const state = up ? 'running'
    : status?.enabled ? 'stopped'
      : status?.recommendation?.supported === false ? 'unsupported' : 'missing';
  return {
    id: 'fleet-host',
    label: 'Dedicated Qwen host',
    icon: Server,
    configure: 'detail',
    hostSetup: true,
    state,
    endpoint: status?.endpoint || null,
    detail: !up && status?.recommendation?.supported === false
      ? status.recommendation.title
      : up && !status?.serving
        ? 'Container up, model still loading'
        : up && status?.queue
          ? `${formatCount(status.queue.active)} generating · ${formatCount(status.queue.queued)} queued`
          : null,
    onStop: status?.stoppable ? onStop : null,
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
    <div className="flex flex-wrap items-center gap-1.5">
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
function ServerRow({ row, busy, actionInProgress, selected, hideActions, children }) {
  const Icon = row.icon;
  const meta = STATE_META[row.state] || STATE_META.missing;
  return (
    <div role="group" aria-label={row.label} data-runtime-id={row.id} className={`flex flex-col @min-[48rem]:grid @min-[48rem]:grid-cols-[10rem_minmax(0,1fr)_minmax(12rem,20rem)] gap-2 @min-[48rem]:gap-3 bg-port-bg border rounded-lg px-3 py-2 ${selected ? 'border-port-accent' : 'border-port-border'}`}>
      <div className="flex items-center gap-2 min-w-0 @min-[48rem]:w-full @min-[48rem]:shrink-0">
        <Icon size={14} className="text-port-accent shrink-0" />
        <span className="text-sm text-white break-words">{row.label}</span>
      </div>
      <div className="flex items-center gap-2 flex-wrap min-w-0 flex-1">
        <span className={`px-2 py-0.5 text-xs rounded flex items-center gap-1.5 ${meta.cls}`}>
          <span className={`w-2 h-2 rounded-full ${meta.dot}`} />
          {meta.label}{row.pid ? ` (PID ${row.pid})` : ''}
        </span>
        {row.endpoint && (
          <code className="text-xs text-gray-500 break-all max-w-full">{row.endpoint}</code>
        )}
        {row.model && <span className="text-xs text-gray-400 break-all">Model: {row.model}</span>}
        {row.version && <span className="text-xs text-gray-500">v{row.version}</span>}
        {row.updateAvailable && row.latestVersion && (
          <span
            className="text-xs text-port-warning"
            title={`${row.label} v${row.latestVersion} is available (you have ${row.version ? `v${row.version}` : 'an older version'})`}
          >
            v{row.latestVersion} available
          </span>
        )}
        {row.runAtStartup && (
          <span className="px-1.5 py-0.5 text-xs rounded border border-port-success/40 text-port-success" title="This PM2 process is in the saved list `pm2 resurrect` replays at boot">
            starts at boot
          </span>
        )}
        {row.releaseReason && (
          <span className="text-xs text-port-warning" title={row.releaseReason}>
            {row.releaseReason}
          </span>
        )}
        {row.detail && <span className="text-xs text-gray-500">{row.detail}</span>}
        {!hideActions && row.progress && <span role="status" className="text-xs text-port-accent">{row.progress}</span>}
        {!hideActions && row.error && <span role="alert" className="text-xs text-port-error break-words">{row.error}</span>}
      </div>
      <div className="flex items-center gap-2 flex-wrap shrink-0">
        {!hideActions && row.onInstall && (
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
        {!hideActions && row.onRepair && (
          <button type="button" onClick={row.onRepair} disabled={busy} className={accentBtn}
            title={`Repair ${row.label} and its model cache`}>
            <Download size={12} />Repair
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
        {!hideActions && row.onStart && (
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
        {!hideActions && row.onStop && (
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
        {!hideActions && row.onUpgrade && (
          <button
            onClick={() => row.onUpgrade()}
            disabled={busy}
            className={`${accentBtn} bg-port-success/20 hover:bg-port-success/30 text-port-success`}
            title={`Update ${row.label}${row.latestVersion ? ` to v${row.latestVersion}` : ''}${row.updateVia ? ` through ${row.updateVia}` : ''}`}
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
        {children}
      </div>
    </div>
  );
}

export default function RuntimeServersCard({
  status,
  runtimes,
  onAction,
  loading,
  busy,
  actionInProgress,
  onRefresh,
  onControlOllama,
  onUpgradeOllama,
  onControlLmStudio,
  onInstallBackend,
  onSaveStartup,
  onSaveIdleWindow,
  onToggleKeepLoaded,
  fleetHostStatus,
  onStopFleetHost,
  selectedRuntime,
  onSelectRuntime,
}) {
  const ollamaService = status?.ollama?.service;
  const ollamaRunsAtStartup = Boolean(ollamaService?.runAtStartup);

  const rows = [
    backendRow({
      id: 'ollama',
      label: LOCAL_RUNTIME_LABELS.ollama,
      icon: Cpu,
      data: status?.ollama,
      onInstall: () => onInstallBackend('ollama'),
      onStart: () => onControlOllama('start'),
      onStop: () => onControlOllama('stop'),
      onUpgrade: onUpgradeOllama,
      startupControl: ollamaService?.supported,
    }),
    backendRow({
      id: 'lmstudio',
      label: LOCAL_RUNTIME_LABELS.lmstudio,
      icon: Box,
      data: status?.lmstudio,
      onInstall: () => onInstallBackend('lmstudio'),
      onStart: () => onControlLmStudio('start'),
      onStop: () => onControlLmStudio('stop'),
    }),
    ...runtimes.map(({ descriptor, status }) => {
      const { id, capabilities, kind, copy } = descriptor;
      const row = descriptor.toRow(status, (action) => () => onAction(id, action));
      return {
        ...row,
        configure: capabilities.configure,
        hideActionsInDetail: kind === 'bundle',
        runAtStartup: capabilities.bootPersist && row.runAtStartup,
        idleRelease: capabilities.idleRelease && !['unsupported', 'missing', 'unknown'].includes(row.state),
        idleMinutes: status?.idleMinutes ?? 0,
        keepLoaded: Boolean(status?.keepLoaded),
        idleNote: copy?.idleRelease,
      };
    }),
    // Last, and only once its status has landed: an absent payload would
    // otherwise render a "Not installed" row for a host that is serving.
    ...(fleetHostStatus ? [fleetHostRow({ status: fleetHostStatus, onStop: onStopFleetHost })] : []),
  ];

  return (
    <div className="@container bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-gray-300">Local Runtime Servers</h2>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-400 hover:text-white transition-colors"
          title="Refresh runtime server status"
          aria-label="Refresh runtime server status"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      <p role="status" className="text-xs text-gray-400">
        {loading ? 'Refreshing runtime status…' : `${formatCount(rows.filter((row) => row.state === 'running' || row.state === 'external').length)} running · ${formatCount(rows.filter((row) => row.state === 'unknown').length)} status unavailable`}
      </p>

      <div className="space-y-2">
        {rows.map((row) => (
          <ServerRow key={row.id} row={row} busy={busy} actionInProgress={actionInProgress} selected={selectedRuntime === row.id}
            hideActions={selectedRuntime === row.id && row.hideActionsInDetail}>
            {onSelectRuntime && row.configure === 'detail' && (
              <button onClick={() => onSelectRuntime(row.id)} className={neutralBtn} aria-pressed={selectedRuntime === row.id}><Settings2 size={12} />Configure</button>
            )}
            {row.hostSetup && (
              <Link
                to="/ai/fleet?fleetStep=host"
                className={`${neutralBtn} no-underline`}
                title="Set up, reconfigure or inspect the dedicated Qwen host and its inbound usage"
              >
                <Settings2 size={12} />
                {fleetHostStatus?.stoppable ? 'Host setup & usage' : 'Set up host'}
              </Link>
            )}
            {(row.startupControl || row.idleRelease) && (
              <details className="open:w-full">
                <summary className="min-h-[44px] content-center cursor-pointer text-xs text-gray-400">Startup &amp; residency</summary>
                {row.startupControl && (
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
                {row.idleRelease && (
                  <div className="flex flex-wrap items-center gap-3">
                    <IdleWindowField
                      id={row.id}
                      value={row.idleMinutes}
                      busy={busy || row.keepLoaded}
                      onSave={(minutes) => onSaveIdleWindow?.(row.id, minutes)}
                      note={row.keepLoaded
                        ? `${row.label} is pinned to keep loaded and is exempt from idle release and memory pressure eviction.`
                        : row.idleNote}
                    />
                    <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={row.keepLoaded}
                        disabled={busy}
                        onChange={() => onToggleKeepLoaded?.(row.id, !row.keepLoaded)}
                        className="rounded bg-port-bg border-port-border text-port-accent focus:ring-0 focus:ring-offset-0"
                        aria-label={`Keep ${row.label} loaded`}
                      />
                      <span>Keep loaded</span>
                    </label>
                  </div>
                )}
              </details>
            )}
            {onSelectRuntime && row.configure === 'pm2' && row.state !== 'unsupported' && (
              <button
                onClick={() => onSelectRuntime(row.id)}
                className={neutralBtn}
                title={`Configure ${row.label}`}
                aria-pressed={selectedRuntime === row.id}
              >
                <Settings2 size={12} />
                Configure
              </button>
            )}
          </ServerRow>
        ))}
      </div>

      <details>
      <summary className="min-h-[44px] content-center cursor-pointer text-xs text-gray-400">Startup and idle-release guidance</summary>
      <p className="text-xs text-gray-500">
        <span className="text-gray-400">Idle release</span> puts a model down when nothing has used it for that many minutes — llama.cpp unloads it in place and reloads it on the next request; MTPLX and Slotstream are stopped and restarted on demand. <span className="text-gray-400">Only PortOS traffic counts.</span> A client hitting these ports directly is invisible to the timer and cannot lazily start a stopped server, so set <code className="text-gray-400">0</code> for a daemon you drive from outside PortOS.
      </p>

      </details>
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 pt-1">
        <button onClick={onSaveStartup} disabled={busy} className={accentBtn} title="Run `pm2 save` so the running PM2 processes are in the list a reboot resurrects">
          {actionInProgress === 'runtime-save-startup' ? <BrailleSpinner /> : <Save size={12} />}
          Save PM2 list for reboot
        </button>
        <details className="text-xs text-gray-500">
          <summary className="min-h-[44px] content-center cursor-pointer">What is saved for reboot?</summary>
          <p>llama.cpp, MTPLX and Slotstream run as PM2 processes (<code className="text-gray-400">portos-llama-server</code>, <code className="text-gray-400">portos-mtplx</code>, <code className="text-gray-400">portos-slotstream</code>). Saving snapshots what is running now so it comes back after a reboot — this needs <code className="text-gray-400">pm2 startup</code> to have been run once in a terminal, which is a privileged one-time step PortOS deliberately leaves to you. <span className="text-gray-400">MTPLX, Slotstream, Splash and mkserve are deliberately left out of that snapshot</span>: MTPLX and Slotstream can start on demand; Splash and mkserve are started here. This button does not change those running servers. Ollama and LM Studio manage their own launch-at-login.</p>
        </details>
      </div>
    </div>
  );
}

function SplashContextPicker({ status, busy, onSave }) {
  const contextWindow = status.requestedContextWindow;
  const editable = ['stopped', 'missing'].includes(status.state) && !status.operation;
  return (
    <div className="space-y-1.5">
      <label htmlFor="splash-context" className="block text-sm font-medium text-gray-300">Splash context window</label>
      <ContextWindowSelect
        id="splash-context"
        label="Splash context window"
        value={contextWindow}
        disabled={busy || !editable}
        onChange={(event) => onSave(Number(event.target.value))}
        aria-describedby="splash-context-help"
        options={SPLASH_CONTEXT_WINDOWS.map((window) => ({
          value: window, label: `${formatContextTokens(window)}${window === SPLASH_CONTEXT ? ' (default)' : ''}`,
        }))}
      />
      <p id="splash-context-help" className="text-xs text-gray-400">
        {editable
          ? 'Applies the next time you start Splash. Claude Code and OpenCode presets that follow Splash pick up the running limit automatically. Larger windows can need more memory or SSD space.'
          : 'Stop Splash before changing its next-start context window.'}
      </p>
      {status.servedContextWindow != null && (
        <p className="text-xs text-gray-300">Currently serving: {formatContextTokens(status.servedContextWindow)} tokens</p>
      )}
    </div>
  );
}

export function ManagedInklingRuntimeCard({ descriptor, status, busy, actionInProgress, onAction, onRefresh, onSaveContext }) {
  const { id, label, copy: { requirement, download, provider } } = descriptor;
  return (
    <section className="@container bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-3">
      <h3 className="text-sm font-medium text-white">{label} · Inkling 2 Mini</h3>
      <p className="text-xs text-gray-400">{requirement} {download}</p>
      <p className="text-xs text-gray-400">
        PortOS manages its own copy on this machine, binds it to loopback, and leaves the default backend unchanged.
        {' '}{provider} <Link className="text-port-accent hover:underline" to="/ai">Open AI Providers</Link>.
      </p>
      {id === 'splash' && status?.supported && status.requestedContextWindow != null && (
        <SplashContextPicker status={status} busy={busy} onSave={onSaveContext} />
      )}
      <ServerRow row={descriptor.toRow(status, (action) => () => onAction(id, action))} busy={busy} actionInProgress={actionInProgress}>
        <button type="button" onClick={onRefresh} className={neutralBtn}><RefreshCw size={12} />Check {label} status</button>
      </ServerRow>
      <RuntimeLogDisclosure logs={status?.recentLogs} />
    </section>
  );
}
