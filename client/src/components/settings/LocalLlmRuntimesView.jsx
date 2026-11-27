import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { RefreshCw, Link2, Copy } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import { formatBytes } from '../../utils/formatters';
import useAsyncAction from '../../hooks/useAsyncAction';
import useDownloadPreflightConfirm from '../../hooks/useDownloadPreflightConfirm';
import useLocalLlmStatus from '../../hooks/useLocalLlmStatus';
import {
  migrateLocalLlmBackend,
  upgradeLocalLlmBackend,
  controlOllamaService,
  previewLocalLlmDownload,
  controlLmStudioService,
  searchMtplxModels,
  pullMtplxModel,
  cancelMtplxModelPull,
  removeMtplxModel,
  saveSplashContextWindow,
  downloadSlotstreamModel,
  cancelSlotstreamModelDownload,
  removeSlotstreamModel,
  saveRuntimeStartupList,
} from '../../services/apiLocalLlm.js';
import { patchSettingsSlice } from '../../services/apiSystem.js';
import { getFleetLlmHost, stopFleetLlmHost } from '../../services/apiProviders';
import socket from '../../services/socket';
import RuntimeServersCard, { ManagedInklingRuntimeCard } from './RuntimeServersCard.jsx';
import { LOCAL_RUNTIME_DESCRIPTORS, RUNTIME_CHANGE_LABELS } from './localRuntimeDescriptors.js';
import useRuntimeDownloadProgress from './useRuntimeDownloadProgress.js';
import Modal from '../ui/Modal';
import LlamaServerCard from './LlamaServerCard.jsx';
import MtplxServerCard from './MtplxServerCard.jsx';
import SlotstreamServerCard from './SlotstreamServerCard.jsx';
import HardwareLlmRecommendation from './HardwareLlmRecommendation.jsx';
import LocalPersistentMindSetupCard from './LocalPersistentMindSetupCard.jsx';
import LocalLlmBackendCard from './LocalLlmBackendCard.jsx';
import DownloadPreflightConfirm from '../models/DownloadPreflightConfirm.jsx';
import { LOCAL_LLM_BACKENDS as BACKENDS, localLlmBackendLabel as labelFor } from '../../lib/localLlmBackends.js';

// Summarize a migrate result for the success toast (per-model statuses → counts).
function summarizeMigrate(r) {
  const c = { linked: 0, copied: 0, installed: 0, started: 0, failed: 0, skipped: 0 };
  for (const x of r?.results || []) {
    if (x.status === 'imported') c[x.linked ? 'linked' : 'copied']++;
    else if (c[x.status] != null) c[x.status]++;
  }
  const parts = [
    c.linked && `${c.linked} linked`,
    c.copied && `${c.copied} copied`,
    c.installed && `${c.installed} downloaded`,
    c.started && `${c.started} downloading`,
    c.failed && `${c.failed} failed`,
    c.skipped && `${c.skipped} skipped`
  ].filter(Boolean);
  return `${labelFor(r.from)} → ${labelFor(r.to)}: ${parts.join(', ') || 'nothing to move'}`;
}

const descriptors = Object.values(LOCAL_RUNTIME_DESCRIPTORS);
const runtimeIds = ['ollama', 'lmstudio', ...descriptors.map(({ id }) => id), 'fleet-host'];

// Install, start, stop and configure the local servers that run language models.
// Status and progress subscriptions belong to the Runtimes tab.
export default function LocalLlmRuntimesView({ view } = {}) {
  const navigate = useNavigate();
  const { search } = useLocation();
  const selectedRuntime = runtimeIds.includes(view) ? view : null;
  const selectedDescriptor = LOCAL_RUNTIME_DESCRIPTORS[selectedRuntime];
  const selectRuntime = (id) => navigate(`/models/llms-runtimes${id ? '/' + id : ''}${search}`);
  const detailHeading = useRef(null);
  const rosterRef = useRef(null);
  const previousRuntime = useRef(null);
  useEffect(() => {
    if (view) detailHeading.current?.focus();
    else if (previousRuntime.current) {
      rosterRef.current?.querySelector(`[data-runtime-id="${previousRuntime.current}"] button[aria-pressed]`)?.focus();
    }
    previousRuntime.current = selectedRuntime;
  }, [view, selectedRuntime]);
  const [statuses, setStatuses] = useState({});
  const { llama: llamaStatus, mtplx: mtplxStatus, slotstream: slotstreamStatus } = statuses;
  const statusRequests = useRef({});
  const bundleProgress = useRef({});
  const [runtimeConfirm, setRuntimeConfirm] = useState(null);
  const confirmationCopy = runtimeConfirm?.action === 'uninstall'
    ? runtimeConfirm.descriptor.copy.uninstallDetail
    : runtimeConfirm?.action === 'repair' && runtimeConfirm.descriptor.copy.repair;
  // The dedicated Qwen host is a docker container rather than a PM2 process, so
  // it is not part of the shared local-LLM status payload — but it IS a local
  // model server, and this is the page an operator comes to when they want to
  // stop one (#7414 moved every other lifecycle control here).
  const [fleetHostStatus, setFleetHostStatus] = useState(null);
  const { confirm: downloadConfirm, request: requestWeightDownload, cancel: cancelDownloadConfirm, confirmRun: runDownloadConfirm } = useDownloadPreflightConfirm();
  const [llamaDownloading, setLlamaDownloading] = useState(false);
  const loadRuntime = useCallback(async (id) => {
    const { api, kind } = LOCAL_RUNTIME_DESCRIPTORS[id];
    const requestId = Symbol(id);
    const progressAtRequest = bundleProgress.current[id];
    statusRequests.current[id] = requestId;
    const result = await api.status({ silent: true }).catch(() => null);
    if (statusRequests.current[id] !== requestId) return result;
    if (result || kind === 'bundle') {
      setStatuses((previous) => {
        if (bundleProgress.current[id] === progressAtRequest) return { ...previous, [id]: result };
        const { operation, lastError } = previous[id] ?? {};
        return { ...previous, [id]: { ...(result ?? previous[id]), operation, lastError } };
      });
    }
    // Keep version/package-manager probing off the lifecycle status critical path.
    if (result?.installed && api.updateStatus) {
      api.updateStatus({ silent: true }).then((update) => {
        if (update && statusRequests.current[id] === requestId) {
          setStatuses((previous) => ({ ...previous, [id]: { ...previous[id], ...update } }));
        }
      }).catch(() => null);
    }
    return result;
  }, []);

  const refreshLlama = useCallback(() => loadRuntime('llama'), [loadRuntime]);

  const mergeRuntimeStatus = (id, result) => {
    // An older read may have captured the state before the mutation was accepted.
    delete statusRequests.current[id];
    setStatuses((previous) => ({ ...previous, [id]: { ...previous[id], ...result } }));
  };

  const applyBundleProgress = useCallback(({ runtime: id, event, message, operation, lastError }) => {
    if (LOCAL_RUNTIME_DESCRIPTORS[id]?.kind !== 'bundle') return;
    bundleProgress.current[id] = Symbol(id);
    setStatuses((previous) => {
      const current = previous[id];
      if (operation === undefined && event === 'progress') {
        if (!current?.operation) return previous;
        return { ...previous, [id]: { ...current, operation: { ...current.operation, message } } };
      }
      return {
        ...previous,
        [id]: { ...current, operation: operation ?? null, lastError: lastError ?? null },
      };
    });
  }, []);

  const [mtplxDownload, clearMtplxDownload] = useRuntimeDownloadProgress('mtplx:download', () => loadRuntime('mtplx'));
  const [slotstreamDownload, clearSlotstreamDownload] = useRuntimeDownloadProgress('slotstream:download', () => loadRuntime('slotstream'));

  // The runtime rows refresh alongside the shared status, so one
  // Refresh — or one completed action — repaints every row on this view.
  const loadFleetHostStatus = useCallback(() => (
    getFleetLlmHost({ silent: true })
      .then((res) => { if (res) setFleetHostStatus(res); return res; })
      // Silent by design: this row is one of several on a shared card, and a
      // machine with no dedicated host configured must not toast on every
      // refresh of the page.
      .catch(() => null)
  ), []);

  const refreshRuntimes = useCallback(() => {
    for (const { id } of descriptors) loadRuntime(id);
    loadFleetHostStatus();
  }, [loadRuntime, loadFleetHostStatus]);
  useEffect(() => {
    // Recover terminal bundle operation state after a dropped connection.
    const recover = () => {
      for (const { id, kind } of descriptors) {
        if (kind === 'bundle') loadRuntime(id);
      }
    };
    socket.on('connect', recover);
    return () => socket.off('connect', recover);
  }, [loadRuntime]);
  const {
    status, loading, loadStatus, runAction, installBackend: installRuntimeBackend,
    actionInProgress, busy, progressMsg, confirmAction, setConfirmAction,
  } = useLocalLlmStatus({ onRefresh: refreshRuntimes, onProgress: applyBundleProgress });
  const llamaBusy = actionInProgress?.endsWith('-llama');
  const activeBundles = descriptors.filter(({ id, kind }) => kind === 'bundle' && statuses[id]?.operation);
  const runRuntimeAction = (id, action, payload) => {
    if (busy) return;
    const { api, kind, copy } = LOCAL_RUNTIME_DESCRIPTORS[id];
    const key = `runtime-${action}-${id}`;
    if (id === 'llama' && action !== 'upgrade') {
      const failureMessage = `Failed to ${action} ${action === 'install' ? 'llama.cpp' : 'llama-server'}`;
      const options = { silent: true };
      return runAction(key, async () => {
        const result = await (action === 'start' ? api.start(payload, options) : api[action](options));
        if (!result?.success) throw new Error(result?.message || result?.error || failureMessage);
        return result;
      }, action === 'start'
        ? (result) => `llama-server started (PID ${result.pid}) on port ${payload.port}`
        : copy[action], {
        onError: (err) => {
          if (!err?.toasted) toast.error(err?.message || failureMessage);
          loadRuntime('llama');
        },
      });
    }
    if (kind === 'bundle') {
      return runAction(key, async () => {
        const progressAtRequest = bundleProgress.current[id];
        const result = await (action === 'cancel' ? api.cancel(payload) : api[action]());
        // A socket frame may arrive before the HTTP response for the same action.
        if (result?.operation && bundleProgress.current[id] === progressAtRequest) {
          mergeRuntimeStatus(id, { operation: result.operation, lastError: null });
        }
        return result;
      });
    }
    const invoke = () => action === 'start' ? api.start(payload ?? {}) : api[action]();
    return runAction(key, invoke, copy?.[action]).then(() => loadRuntime(id));
  };
  const runtimeAction = (id, action, payload) => {
    const descriptor = LOCAL_RUNTIME_DESCRIPTORS[id];
    if (action === 'uninstall' || (descriptor.capabilities.confirmInstall && Object.hasOwn(RUNTIME_CHANGE_LABELS, action))) {
      setRuntimeConfirm({ descriptor, action });
    } else {
      runRuntimeAction(id, action, payload);
    }
  };
  const confirmRuntimeAction = () => {
    const { descriptor, action } = runtimeConfirm;
    setRuntimeConfirm(null);
    runRuntimeAction(descriptor.id, action);
  };
  const updateSplashContext = (contextWindow) => runAction(
    'runtime-context-splash',
    async () => {
      const result = await saveSplashContextWindow(contextWindow);
      mergeRuntimeStatus('splash', result);
      return result;
    },
    'Saved Splash context for its next start',
  );

  // === Unified runtime-server controls ======================================
  // Every handler routes through `runAction` so one busy/spinner/refresh path
  // covers every runtime. The `runtime-<verb>-<id>` keys are what
  // `RuntimeServersCard` matches to place its spinner.
  const controlOllama = (action) => runAction(
    action === 'enable' || action === 'disable' ? 'runtime-startup-ollama' : `runtime-${action}-ollama`,
    () => controlOllamaService(action),
    { start: 'Ollama is running', stop: 'Ollama stopped', enable: 'Ollama will run at login', disable: 'Ollama background service disabled' }[action],
    { ollamaService: true }
  );
  const stopFleetHost = () => runAction(
    'runtime-stop-fleet-host',
    async () => {
      const result = await stopFleetLlmHost();
      if (result?.error) toast.error(result.error);
      else toast.success(result?.containerStopped
        ? 'Dedicated Qwen host stopped and its container removed'
        : 'Dedicated Qwen host disabled');
      return result;
    },
  ).then(loadFleetHostStatus);
  // The roster's update action; same endpoint and toast as the Ollama detail card's button.
  const runtimeUpgradeOllama = () => runAction(
    'runtime-upgrade-ollama',
    () => upgradeLocalLlmBackend('ollama'),
    (r) => r?.note ? `Ollama updated — ${r.note}` : `Ollama updated to v${status?.ollama?.latestVersion}`,
  );
  const controlLmStudio = (action) => runAction(
    `runtime-${action}-lmstudio`,
    () => controlLmStudioService(action),
    action === 'start' ? 'LM Studio server is running' : 'LM Studio server stopped'
  );
  const saveRuntimeLaunch = (id, launch) => runAction(
    `runtime-save-${id}-launch`,
    () => patchSettingsSlice(`localLlm.${id}`, { launch }),
    `Saved — ${LOCAL_RUNTIME_DESCRIPTORS[id].label} will start on these options when a request needs it`
  ).then(() => loadRuntime(id));

  // The idle window is a plain settings write for the PM2-managed daemons;
  // only what happens when it elapses differs (llama.cpp unloads in place on
  // its next start; MTPLX and Slotstream are stopped and lazily restarted).
  const saveIdleWindow = (runtime, minutes) => runAction(
    `runtime-idle-${runtime}`,
    () => patchSettingsSlice(`localLlm.${runtime}`, { idleMinutes: minutes }),
    minutes === 0
      ? `${LOCAL_RUNTIME_DESCRIPTORS[runtime].label} will stay loaded while idle`
      : `${LOCAL_RUNTIME_DESCRIPTORS[runtime].label} releases its model after ${minutes} idle minute${minutes === 1 ? '' : 's'}`
  ).then(() => loadRuntime(runtime));
  const toggleKeepLoaded = (runtime, nextPinned) => runAction(
    `runtime-keep-loaded-${runtime}`,
    () => patchSettingsSlice(`localLlm.${runtime}`, { keepLoaded: nextPinned }),
    nextPinned
      ? `${LOCAL_RUNTIME_DESCRIPTORS[runtime].label} is pinned and will stay loaded`
      : `${LOCAL_RUNTIME_DESCRIPTORS[runtime].label} will follow idle and pressure release policies`
  ).then(() => loadRuntime(runtime));
  // The route awaits the whole transfer, so this request runs for as long as the
  // download does; the bar is driven by `slotstream:download` (subscribed above)
  // rather than by the spinner, and the terminal frame clears it first. The
  // clear below is the belt for a socket that dropped mid-transfer.
  const startSlotstreamDownload = (model) => runAction(
    'slotstream-download',
    () => downloadSlotstreamModel(model, { silent: true }).then((r) => {
      if (r?.canceled === true || r?.cancelled === true) return r;
      if (r?.success === false) throw new Error(r.error || 'Download failed');
      toast.success(`${r?.repo || 'Checkpoint'} downloaded`);
      return r;
    }),
    null,
    { onError: (err) => toast.error(`Slotstream download failed: ${err.message}`) },
  ).then(() => {
    clearSlotstreamDownload();
    return loadRuntime('slotstream');
  });
  const slotstreamDownloadModel = (model) => requestWeightDownload({
    title: 'Download Slotstream checkpoint',
    preview: () => previewLocalLlmDownload({ kind: 'slotstream', model }, { silent: true }),
    run: () => startSlotstreamDownload(model),
  });
  // A 100 GB+ transfer that is merely SLOW never trips the idle watchdog, so
  // without this the only way out was to wait it out. The bar comes down on the
  // terminal 'canceled' frame from the transfer.
  const [cancelSlotstreamDownload, cancellingSlotstreamDownload] = useAsyncAction(async (model) => {
    const result = await cancelSlotstreamModelDownload(model, { silent: true });
    toast.info(result?.cancelled ? 'Cancelling checkpoint download…' : 'No checkpoint download is running');
  }, { errorMessage: 'Could not cancel the checkpoint download' });
  const slotstreamRemove = (model, onRemoved) => runAction(
    'slotstream-remove',
    async () => {
      const result = await removeSlotstreamModel(model, { silent: true });
      onRemoved();
      delete statusRequests.current.slotstream;
      setStatuses((previous) => {
        const current = previous.slotstream;
        if (!current) return previous;
        return {
          ...previous,
          slotstream: {
            ...current,
            cachedModels: current.cachedModels?.filter((id) => id !== model),
            cachedModelRows: current.cachedModelRows?.filter((row) => row.id !== model),
          },
        };
      });
      return result;
    },
    `${model} removed from the Slotstream cache`,
    { onError: (err) => toast.error(err.message) },
  );
  // Checkpoint management (search / download / remove), owned by the MTPLX card.
  //
  // `mtplxSearch` keeps a stable identity because the checkpoint panel keys its
  // one-time initial load on it, and progress and status updates re-render this component. It resolves its own failures into the `{models, error}`
  // shape the panel renders inline, so it is `silent` — no toast.
  const mtplxSearch = useCallback((params) => searchMtplxModels(params, { silent: true })
    .catch((err) => ({ models: [], error: err?.message || 'Search failed' })), []);
  // The pull resolves only when the weights are on disk; byte progress arrives
  // on `mtplx:download` (subscribed above), so the button spinner is not the
  // only sign of life during a multi-gigabyte transfer.
  const startMtplxPull = (model) => runAction(
    model ? `mtplx-pull-${model}` : 'mtplx-pull',
    () => pullMtplxModel(model, { silent: true }).then((r) => {
      if (r?.cancelled) return r;
      if (r?.success === false) throw new Error(r.error || 'Download failed');
      toast.success(`${r?.model || 'Default checkpoint'} downloaded`);
      return r;
    }),
    null,
    { onError: (err) => {
      if (err.code === 'MTPLX_PULL_FAILED') clearMtplxDownload();
      toast.error(`MTPLX download failed: ${err.message}`);
    } },
  ).then((result) => {
    if (result) clearMtplxDownload();
    return loadRuntime('mtplx');
  });
  const [cancelMtplxPull, cancellingMtplxPull] = useAsyncAction(async () => {
    const result = await cancelMtplxModelPull({ silent: true });
    if (result.cancelled) toast.info('Cancelling checkpoint download…');
    else toast.info('No checkpoint download is running');
  });
  const mtplxPull = (model) => requestWeightDownload({
    title: 'Download MTPLX checkpoint',
    preview: () => previewLocalLlmDownload({ kind: 'mtplx', model: model || null }, { silent: true }),
    run: () => startMtplxPull(model),
  });
  const mtplxRemove = (model) => runAction(
    `mtplx-remove-${model}`,
    () => removeMtplxModel(model),
    (r) => `${r?.model || model} removed${r?.bytesFreed ? ` — ${formatBytes(r.bytesFreed)} freed` : ''}`,
  ).then(() => loadRuntime('mtplx'));
  const saveRuntimeStartup = () => runAction(
    'runtime-save-startup',
    () => saveRuntimeStartupList(),
    'Saved — the PM2 processes running now will come back after a reboot'
  ).then(() => {
    for (const { id, kind } of descriptors) {
      if (kind === 'pm2') loadRuntime(id);
    }
  });
  return (
    <section id="llm-runtimes-panel" role="tabpanel" aria-labelledby="llm-runtimes-heading" className="space-y-4">
      {/* The panel names itself. It used to borrow `tab-runtimes` from the LLMs
          pill bar, but #7414 made Runtimes a section tab, and `RouteTabsHeader`
          passes no `controlsIdPrefix` — so that id stopped existing and the
          labelledby dangled, leaving the panel unnamed. A heading of its own
          survives whatever tab bar happens to be above it. Visually hidden
          because the section header already shows "Models → Runtimes". */}
      {runtimeConfirm && (
        <Modal open onClose={() => setRuntimeConfirm(null)} size="sm" usePortal
          ariaLabel={`${RUNTIME_CHANGE_LABELS[runtimeConfirm.action]} ${runtimeConfirm.descriptor.label}`}>
          <div className="rounded-xl border border-port-border bg-port-card p-5 space-y-4">
            <p className="text-sm text-white">{confirmationCopy || runtimeConfirm.descriptor.copy.download}</p>
            {!confirmationCopy && <p className="text-xs text-gray-400">This stages the PortOS-supported version. Existing providers and other runtimes are not changed.</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" onClick={() => setRuntimeConfirm(null)} className="min-h-[44px] rounded border border-port-border px-3 text-sm text-gray-300">Cancel</button>
              <button type="button" onClick={confirmRuntimeAction} disabled={busy} className="min-h-[44px] rounded bg-port-accent px-3 text-sm text-white disabled:opacity-50">
                {runtimeConfirm.action === 'install' ? 'Install and download' : RUNTIME_CHANGE_LABELS[runtimeConfirm.action]}
              </button>
            </div>
          </div>
        </Modal>
      )}
      <h2 id="llm-runtimes-heading" className="sr-only">Runtimes</h2>
      {/* One start/stop/install surface for every local server PortOS can run */}
      {(progressMsg || busy || mtplxDownload || slotstreamDownload || activeBundles.length > 0 || llamaDownloading) && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg border border-port-accent/30 p-3 text-sm text-port-accent">
          <BrailleSpinner />{progressMsg || statuses[activeBundles[0]?.id]?.operation?.message || 'Runtime work in progress'}
          {(llamaBusy || llamaDownloading) && <Link className="underline" to={`/models/llms-runtimes/llama${search}`}>llama.cpp progress</Link>}
          {mtplxDownload && <Link className="underline" to={`/models/llms-runtimes/mtplx${search}`}>MTPLX progress</Link>}
          {slotstreamDownload && <Link className="underline" to={`/models/llms-runtimes/slotstream${search}`}>Slotstream progress</Link>}
          {activeBundles.map(({ id, label }) => (
            <Link key={id} className="underline" to={`/models/llms-runtimes/${id}${search}`}>{label} progress</Link>
          ))}
        </div>
      )}
      <div className="@container">
      <div className="grid items-start gap-4 @min-[80rem]:grid-cols-2">
      <div ref={rosterRef} className={view ? 'hidden @min-[80rem]:block min-w-0' : 'min-w-0 @min-[80rem]:col-span-2'}>
      <RuntimeServersCard
        selectedRuntime={selectedRuntime}
        onSelectRuntime={selectRuntime}
        status={status}
        runtimes={descriptors.map((descriptor) => ({ descriptor, status: statuses[descriptor.id] }))}
        onAction={runtimeAction}
        loading={loading}
        busy={busy}
        actionInProgress={actionInProgress}
        onRefresh={loadStatus}
        onControlOllama={controlOllama}
        onUpgradeOllama={runtimeUpgradeOllama}
        onControlLmStudio={controlLmStudio}
        onInstallBackend={installRuntimeBackend}
        onSaveStartup={saveRuntimeStartup}
        onSaveIdleWindow={saveIdleWindow}
        onToggleKeepLoaded={toggleKeepLoaded}
        fleetHostStatus={fleetHostStatus}
        onStopFleetHost={stopFleetHost}
      />
      </div>
      <div hidden={!view} className="min-w-0 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 ref={detailHeading} tabIndex={-1} className="text-base font-medium text-white focus:outline-none">Runtime configuration</h2>
          <Link to={`/models/llms-runtimes${search}`} className="min-h-[44px] inline-flex items-center text-sm text-port-accent hover:underline">All runtimes</Link>
        </div>
        {view && !selectedRuntime && <p role="status" className="text-sm text-port-warning">Runtime not found. Return to All runtimes to select an available runtime.</p>}
        {selectedRuntime === 'fleet-host' && <p className="text-sm text-gray-400">The dedicated host's configuration, logs and usage live in <Link to="/ai/fleet?fleetStep=host" className="text-port-accent hover:underline">Host setup &amp; usage</Link>.</p>}
        {/* Keep the existing form owners mounted: selection never discards drafts,
            checkpoint searches, progress subscriptions or explicit cancellation. */}

      {/* Backends — model catalog, default marker, cross-backend import */}
      <div hidden={!BACKENDS.some((b) => b.id === selectedRuntime)} className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-gray-300">Local LLM Backends</h2>
          <button onClick={loadStatus} disabled={loading} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-400 hover:text-white transition-colors" title="Refresh" aria-label="Refresh local LLM status">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <p className="text-xs text-gray-500">
          Ollama and LM Studio are the two backends PortOS keeps a model catalog for — both can be installed and running at once, and <span className="text-gray-400">Default</span> just sets which one PortOS routes local-LLM runs to. Use <span className="text-gray-400">Import from…</span> to copy or link models between them without re-downloading. Start and stop them (and llama.cpp and MTPLX) from <span className="text-gray-400">Local Runtime Servers</span> above.
        </p>
        <p className="text-xs text-gray-500">
          For local coding agents, configure the shared <Link to="/ai" className="text-port-accent hover:underline">temperature, top-p and thinking defaults in AI Providers</Link>. Every local OpenAI-compatible backend receives them — Ollama, llama.cpp and MTPLX, whether reached directly or through an OpenCode CLI/TUI wrapper. Every control left blank is simply not sent, so the backend keeps its own default — Ollama agent runs fall back to temperature 0.6.
        </p>

        {loading && !status ? (
          <BrailleSpinner text="Loading local LLM status" />
        ) : status ? (
          <>
            <div className="space-y-3">
              {BACKENDS.map((b) => (
                <div key={b.id} hidden={selectedRuntime !== b.id}>
                <LocalLlmBackendCard
                  backend={b} status={status} isDefault={status.backend === b.id}
                  busy={busy} actionInProgress={actionInProgress}
                  runAction={runAction} setConfirmAction={setConfirmAction}
                />
                </div>
              ))}
            </div>

            {confirmAction && (
              <div className="bg-port-bg border border-port-warning/30 rounded-lg p-4 space-y-3">
                <p className="text-sm text-white">{confirmAction.label}</p>
                {confirmAction.detail && <p className="text-xs text-gray-400">{confirmAction.detail}</p>}
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => runAction(`migrate-${confirmAction.to}-link`, () => migrateLocalLlmBackend(confirmAction.to, 'link'), summarizeMigrate)}
                    disabled={busy}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent"
                    title="Hardlink each GGUF so both backends share one file on disk (no extra space; falls back to a copy across filesystems)"
                  >
                    {actionInProgress === `migrate-${confirmAction.to}-link` ? <BrailleSpinner /> : <Link2 size={14} />}
                    Link (share disk)
                  </button>
                  <button
                    onClick={() => runAction(`migrate-${confirmAction.to}-copy`, () => migrateLocalLlmBackend(confirmAction.to, 'copy'), summarizeMigrate)}
                    disabled={busy}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 bg-port-border hover:bg-port-border/70 text-white"
                    title="Make an independent duplicate on the target (uses extra disk; survives deleting the source backend's copy)"
                  >
                    {actionInProgress === `migrate-${confirmAction.to}-copy` ? <BrailleSpinner /> : <Copy size={14} />}
                    Copy (independent)
                  </button>
                  <button onClick={() => setConfirmAction(null)} className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors">
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-gray-500">Unable to load local LLM status</p>
        )}
      </div>

      {selectedDescriptor?.kind === 'bundle' && (
        <ManagedInklingRuntimeCard
          descriptor={selectedDescriptor}
          status={statuses[selectedRuntime]}
          busy={busy}
          actionInProgress={actionInProgress}
          onRefresh={() => loadRuntime(selectedRuntime)}
          onAction={runtimeAction}
          onSaveContext={updateSplashContext}
        />
      )}

      {/* Slotstream — PM2-managed SSD-streaming MoE runtime (Apple Silicon) */}
      <div hidden={selectedRuntime !== 'slotstream'}>
        <SlotstreamServerCard
          status={slotstreamStatus}
          loading={loading}
          busy={busy}
          actionInProgress={actionInProgress}
          onRefresh={() => loadRuntime('slotstream')}
          onSaveLaunch={(launch) => saveRuntimeLaunch('slotstream', launch)}
          onStart={(launch) => runRuntimeAction('slotstream', 'start', launch)}
          onStop={() => runRuntimeAction('slotstream', 'stop')}
          onInstall={() => runRuntimeAction('slotstream', 'install')}
          onUninstall={() => runtimeAction('slotstream', 'uninstall')}
          onDownloadModel={slotstreamDownloadModel}
          onRemoveModel={slotstreamRemove}
          onCancelDownload={cancelSlotstreamDownload}
          cancelling={cancellingSlotstreamDownload}
          download={slotstreamDownload}
        />
      </div>

      {/* MTPLX — PM2-managed native-MTP runtime (Apple Silicon) */}
      <div hidden={selectedRuntime !== 'mtplx'}>
        <MtplxServerCard
          visible={selectedRuntime === 'mtplx'}
          status={mtplxStatus}
          loading={loading}
          busy={busy}
          actionInProgress={actionInProgress}
          onRefresh={() => loadRuntime('mtplx')}
          onSaveLaunch={(launch) => saveRuntimeLaunch('mtplx', launch)}
          onStart={(launch) => runRuntimeAction('mtplx', 'start', launch)}
          onStop={() => runRuntimeAction('mtplx', 'stop')}
          onInstall={() => runRuntimeAction('mtplx', 'install')}
          onUninstall={() => runtimeAction('mtplx', 'uninstall')}
          onSearchModels={mtplxSearch}
          onPullModel={mtplxPull}
          onCancelPull={cancelMtplxPull}
          cancellingPull={cancellingMtplxPull}
          onRemoveModel={mtplxRemove}
          download={mtplxDownload}
        />
      </div>

      <div hidden={selectedRuntime !== 'llama'}>
        <LlamaServerCard
          status={llamaStatus}
          busy={busy}
          actionInProgress={actionInProgress}
          onRefresh={refreshLlama}
          onStart={(launch) => runRuntimeAction('llama', 'start', launch)}
          onStop={() => runRuntimeAction('llama', 'stop')}
          onInstall={() => runRuntimeAction('llama', 'install')}
          requestWeightDownload={requestWeightDownload}
          onDownloadActivityChange={setLlamaDownloading}
        />
      </div>
      </div>
      </div>
      </div>
      <details className="bg-port-card border border-port-border rounded-xl p-4">
        <summary className="cursor-pointer text-sm font-medium text-gray-300">Setup guidance and recommendations</summary>
        <div className="mt-4 space-y-4">
          <LocalPersistentMindSetupCard />
          <HardwareLlmRecommendation />
        </div>
      </details>
      <DownloadPreflightConfirm
        open={Boolean(downloadConfirm)}
        title={downloadConfirm?.title}
        loading={Boolean(downloadConfirm?.loading)}
        error={downloadConfirm?.error}
        assessment={downloadConfirm?.assessment}
        confirmLabel="Start download"
        onCancel={cancelDownloadConfirm}
        onConfirm={runDownloadConfirm}
      />
    </section>
  );
}
