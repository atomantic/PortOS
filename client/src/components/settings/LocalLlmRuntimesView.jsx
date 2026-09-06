import { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router';
import { Download, RefreshCw, ExternalLink, Link2, Copy, Power, PowerOff, Zap, ChevronDown, ChevronUp, Terminal, } from 'lucide-react';
import toast from '../ui/Toast';
import FormField from '../ui/FormField';
import BrailleSpinner from '../BrailleSpinner';
import { formatBytes } from '../../utils/formatters';
import useDownloadPreflightConfirm from '../../hooks/useDownloadPreflightConfirm';
import useLocalLlmStatus from '../../hooks/useLocalLlmStatus';
import { migrateLocalLlmBackend, controlOllamaService, patchSettingsSlice, getLlamaServerStatus, getLlamaServerUpdateStatus, startLlamaServer, stopLlamaServer, installLlamaServer, upgradeLlamaServer, downloadSpecDecodeModel, cancelSpecDecodeModelDownload, previewLocalLlmDownload, controlLmStudioService, getMtplxServerStatus, startMtplxServer, stopMtplxServer, installMtplx, searchMtplxModels, pullMtplxModel, removeMtplxModel, getSlotstreamServerStatus, startSlotstreamServer, stopSlotstreamServer, installSlotstream, downloadSlotstreamModel, cancelSlotstreamModelDownload, saveRuntimeStartupList } from '../../services/api';
import socket from '../../services/socket';
import SpecDecodeWeightRow from './SpecDecodeWeightRow.jsx';
import RuntimeServersCard from './RuntimeServersCard.jsx';
import MtplxServerCard from './MtplxServerCard.jsx';
import SlotstreamServerCard from './SlotstreamServerCard.jsx';
import HardwareLlmRecommendation from './HardwareLlmRecommendation.jsx';
import LocalLlmBackendCard from './LocalLlmBackendCard.jsx';
import DownloadPreflightConfirm from '../models/DownloadPreflightConfirm.jsx';
import { LOCAL_LLM_BACKENDS as BACKENDS, localLlmBackendLabel as labelFor } from '../../lib/localLlmBackends.js';

// The speculative-decoding presets come from the server
// (`server/lib/specDecodePresets.js`, surfaced on the llama-server status
// response) rather than a table here: each preset names a multi-gigabyte GGUF,
// and only the server knows which Hugging Face repo it comes from, whether it
// is already on disk, and how to fetch it. A client-side copy would inevitably
// list a path the Download button had no source for.
const DEFAULT_SPEC_PRESET_ID = 'qwen3.8-27b-dspark';
const downloadKey = (presetId, role) => `${presetId}:${role}`;
// Each entry carries its own `role`, so the rows come straight off the preset
// rather than from a second copy of the role list.
const specWeightEntries = (preset) => [preset?.model, preset?.draftModel].filter((e) => e?.path);

// Defaults for the advanced numeric fields. They are applied when the server is
// launched rather than on every keystroke: a controlled number input that coerces
// as you type snaps back to its default the moment you clear it to retype.
// Keep the launcher default aligned with server/lib/ports.js. 8080 is a common
// IPFS / Tomcat / local-dashboard port and is not a safe default for a managed
// daemon.
const LLAMA_NUMBER_DEFAULTS = { port: 5568, ctxSize: 32768, nGpuLayers: 99, parallel: 1 };
// Optional llama.cpp tuning flags — unlike the fields above these have NO
// PortOS default: an untouched one is stripped from the launch payload so
// llama.cpp applies its own. Mirrors `server/lib/localModelTuning.js`.
const LLAMA_TUNING_FIELDS = ['batchSize', 'ubatchSize', 'threads', 'cacheTypeK', 'cacheTypeV'];
// KV-cache types llama.cpp accepts for --cache-type-k/-v; '' means "leave it off".
const LLAMA_CACHE_TYPES = ['f16', 'q8_0', 'q4_0'];

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

// Install, start, stop and configure the local servers that run language models.
// Mounted only while the Runtimes pill is selected, so every socket subscription
// and poll below belongs to a visible surface.
export default function LocalLlmRuntimesView() {
  const [llamaStatus, setLlamaStatus] = useState(null);
  const [mtplxStatus, setMtplxStatus] = useState(null);
  const [slotstreamStatus, setSlotstreamStatus] = useState(null);
  // Live byte progress for an in-flight `mtplx pull`, driven by the socket. One
  // at a time on purpose: a checkpoint is tens of gigabytes, so two concurrent
  // pulls just make both slower.
  const [mtplxDownload, setMtplxDownload] = useState(null);
  const [slotstreamDownload, setSlotstreamDownload] = useState(null);
  const { confirm: downloadConfirm, request: requestWeightDownload, cancel: cancelDownloadConfirm, confirmRun: runDownloadConfirm } = useDownloadPreflightConfirm();
  const [llamaLoading, setLlamaLoading] = useState(false);
  // Anchor for the unified server card's "Configure" action — llama-server needs
  // a model path, so its Start lives in the launcher rather than in that row.
  const llamaSectionRef = useRef(null);
  const mtplxSectionRef = useRef(null);
  const slotstreamSectionRef = useRef(null);
  const [llamaPresetId, setLlamaPresetId] = useState(DEFAULT_SPEC_PRESET_ID);
  const [llamaForm, setLlamaForm] = useState({
    model: '',
    draftModel: '',
    specType: 'draft-dspark',
    port: 5568,
    host: '127.0.0.1',
    ctxSize: 32768,
    nGpuLayers: 99,
    alias: 'dflash',
    // Always sent — llama-server's own default is often 4 slots, which divides
    // the context window and spends VRAM a TUI agent never uses.
    parallel: 1,
    // Performance tuning (`server/lib/localModelTuning.js`). Empty = NOT SET:
    // the flag is left off the launch line entirely so llama.cpp applies its own
    // default. A number here would silently pin a value the user never chose and
    // make two "default" launches incomparable. Measure the effect of a change
    // on Models → Performance.
    batchSize: '',
    ubatchSize: '',
    threads: '',
    flashAttn: false,
    cacheTypeK: '',
    cacheTypeV: '',
  });
  // Byte progress for downloads STARTED HERE, keyed `presetId:role`. A transfer
  // another tab started still renders — the server reports it on the entry —
  // but only the starting tab owns the toast and the cleanup.
  const [llamaDownloads, setLlamaDownloads] = useState({});
  const specPresetSeeded = useRef(false);
  const [showLlamaAdvanced, setShowLlamaAdvanced] = useState(false);
  const [showLlamaLogs, setShowLlamaLogs] = useState(false);

  const loadLlamaStatus = useCallback(() => {
    return getLlamaServerStatus({ silent: true })
      .then((res) => {
        if (res) {
          setLlamaStatus(res);
          // Version/Homebrew metadata is deliberately a separate, non-blocking
          // request. A slow `--version` probe must not hold up lifecycle state,
          // presets, or the rest of the Local LLMs page.
          if (res.installed) {
            getLlamaServerUpdateStatus({ silent: true })
              .then((update) => {
                if (update) setLlamaStatus((previous) => previous ? { ...previous, ...update } : previous);
              })
              .catch(() => null);
          }
        }
        return res;
      })
      .catch(() => null);
  }, []);

  const loadMtplxStatus = useCallback(() => (
    getMtplxServerStatus({ silent: true })
      .then((res) => {
        if (res) setMtplxStatus(res);
        return res;
      })
      .catch(() => null)
  ), []);

  const loadSlotstreamStatus = useCallback(() => (
    getSlotstreamServerStatus({ silent: true })
      .then((res) => {
        if (res) setSlotstreamStatus(res);
        return res;
      })
      .catch(() => null)
  ), []);

  // The three managed runtimes refresh alongside the shared status, so one
  // Refresh — or one completed action — repaints every row on this view.
  const refreshRuntimes = useCallback(() => {
    loadLlamaStatus();
    loadMtplxStatus();
    loadSlotstreamStatus();
  }, [loadLlamaStatus, loadMtplxStatus, loadSlotstreamStatus]);
  const {
    status, loading, loadStatus, runAction, installBackend: installRuntimeBackend,
    actionInProgress, busy, progressMsg, confirmAction, setConfirmAction,
  } = useLocalLlmStatus({ onRefresh: refreshRuntimes });

  // The preset select mounts pre-selected, so the form has to be filled in the
  // moment the presets land — otherwise the recommended preset reads as chosen
  // while the required model path is still empty and Start sits disabled with
  // nothing to act on. Seeds once, so a later status refresh can't overwrite
  // paths the user has since edited.
  useEffect(() => {
    if (specPresetSeeded.current) return;
    const presets = llamaStatus?.presets;
    if (!presets?.length) return;
    const preset = presets.find((p) => p.id === DEFAULT_SPEC_PRESET_ID) || presets[0];
    specPresetSeeded.current = true;
    setLlamaPresetId(preset.id);
    setLlamaForm((prev) => ({
      ...prev,
      model: preset.model?.path || '',
      draftModel: preset.draftModel?.path || '',
      specType: preset.specType || prev.specType,
    }));
  }, [llamaStatus?.presets]);

  // Byte progress for an in-flight GGUF download. Frames are adopted no matter
  // who started the transfer — a reload mid-download, or a second tab, would
  // otherwise sit on whatever byte count the last status fetch happened to
  // carry and read as frozen. A terminal frame drops the row back to the
  // server's own view of the file, which the refresh below re-reads.
  useEffect(() => {
    const handleDownloadProgress = (frame) => {
      if (!frame?.presetId || !frame?.role) return;
      const key = downloadKey(frame.presetId, frame.role);
      if (frame.event === 'complete' || frame.event === 'error' || frame.event === 'cancelled') {
        setLlamaDownloads((prev) => {
          if (!prev[key]) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
        loadLlamaStatus();
        return;
      }
      setLlamaDownloads((prev) => ({
        ...prev,
        [key]: { received: frame.received || 0, total: frame.total || 0 },
      }));
    };
    socket.on('llamaServer:download', handleDownloadProgress);
    return () => socket.off('llamaServer:download', handleDownloadProgress);
  }, [loadLlamaStatus]);

  // MTPLX checkpoint download progress. A pull can run for hours, so the socket
  // — not the still-open HTTP request — is what the UI trusts: a terminal frame
  // clears the bar AND re-reads the cache, so the list is right even if the
  // request itself never comes back.
  useEffect(() => {
    const handleMtplxDownload = (frame) => {
      if (!frame) return;
      if (frame.event === 'complete' || frame.event === 'error' || frame.event === 'cancelled') {
        setMtplxDownload(null);
        loadMtplxStatus();
        return;
      }
      setMtplxDownload((prev) => ({
        model: frame.model || prev?.model || null,
        // A frame without byte counters (`resolving`, `verifying`) must not
        // reset a bar that already has them — keep the last known numbers.
        received: Number.isFinite(frame.received) ? frame.received : (prev?.received ?? 0),
        total: Number.isFinite(frame.total) ? frame.total : (prev?.total ?? 0),
        message: frame.message || prev?.message || null,
      }));
    };
    socket.on('mtplx:download', handleMtplxDownload);
    return () => socket.off('mtplx:download', handleMtplxDownload);
  }, [loadMtplxStatus]);

  // Slotstream checkpoint download progress. Same contract as MTPLX above: a
  // 100 GB+ pull outlives the request that started it, so the socket's terminal
  // frame is what clears the bar and re-reads the cache — the list is then right
  // even if the request itself never comes back.
  useEffect(() => {
    const handleSlotstreamDownload = (frame) => {
      if (!frame) return;
      if (frame.event === 'complete' || frame.event === 'error' || frame.event === 'cancelled') {
        setSlotstreamDownload(null);
        loadSlotstreamStatus();
        return;
      }
      setSlotstreamDownload((prev) => ({
        model: frame.model || prev?.model || null,
        // A frame without byte counters (the resolving pass) must not reset a
        // bar that already has them — keep the last known numbers.
        received: Number.isFinite(frame.received) ? frame.received : (prev?.received ?? 0),
        total: Number.isFinite(frame.total) ? frame.total : (prev?.total ?? 0),
        message: frame.message || prev?.message || null,
      }));
    };
    socket.on('slotstream:download', handleSlotstreamDownload);
    return () => socket.off('slotstream:download', handleSlotstreamDownload);
  }, [loadSlotstreamStatus]);

  // === Unified runtime-server controls ======================================
  // Every handler routes through `runAction` so one busy/spinner/refresh path
  // covers all four runtimes. The `runtime-<verb>-<id>` keys are what
  // `RuntimeServersCard` matches to place its spinner.
  const controlOllama = (action) => runAction(
    action === 'enable' || action === 'disable' ? 'runtime-startup-ollama' : `runtime-${action}-ollama`,
    () => controlOllamaService(action),
    { start: 'Ollama is running', stop: 'Ollama stopped', enable: 'Ollama will run at login', disable: 'Ollama background service disabled' }[action],
    { ollamaService: true }
  );
  const controlLmStudio = (action) => runAction(
    `runtime-${action}-lmstudio`,
    () => controlLmStudioService(action),
    action === 'start' ? 'LM Studio server is running' : 'LM Studio server stopped'
  );
  const runtimeInstallLlama = () => runAction(
    'runtime-install-llama',
    () => installLlamaServer(),
    'llama.cpp installed'
  ).then(loadLlamaStatus);
  const runtimeUpgradeLlama = () => runAction(
    'runtime-upgrade-llama',
    () => upgradeLlamaServer(),
    (r) => r?.note || 'llama.cpp updated'
  ).then(loadLlamaStatus);
  const runtimeStopLlama = () => runAction(
    'runtime-stop-llama',
    () => stopLlamaServer(),
    (r) => r?.message || 'llama-server stopped'
  ).then(loadLlamaStatus);
  const runtimeInstallMtplx = () => runAction(
    'runtime-install-mtplx',
    () => installMtplx(),
    'MTPLX installed'
  ).then(loadMtplxStatus);
  const runtimeStartMtplx = (launch = {}) => runAction(
    'runtime-start-mtplx',
    () => startMtplxServer(launch),
    (r) => r?.online ? 'MTPLX is running' : 'MTPLX is loading its checkpoint'
  ).then(loadMtplxStatus);
  // The card can start MTPLX explicitly from its cached checkpoint, and the
  // same launch configuration is replayed when a request wakes it on demand.
  const saveMtplxLaunch = (launch) => runAction(
    'runtime-save-mtplx-launch',
    () => patchSettingsSlice('localLlm.mtplx', { launch }),
    'Saved — MTPLX will start on these options when a request needs it'
  ).then(loadMtplxStatus);

  // The idle window is a plain settings write for the PM2-managed daemons;
  // only what happens when it elapses differs (llama.cpp unloads in place on
  // its next start; MTPLX and Slotstream are stopped and lazily restarted).
  const idleRuntimeLabel = { llama: 'llama.cpp', mtplx: 'MTPLX', slotstream: 'Slotstream' };
  const saveIdleWindow = (runtime, minutes) => runAction(
    `runtime-idle-${runtime}`,
    () => patchSettingsSlice(`localLlm.${runtime}`, { idleMinutes: minutes }),
    minutes === 0
      ? `${idleRuntimeLabel[runtime] || runtime} will stay loaded while idle`
      : `${idleRuntimeLabel[runtime] || runtime} releases its model after ${minutes} idle minute${minutes === 1 ? '' : 's'}`
  ).then(runtime === 'llama' ? loadLlamaStatus : runtime === 'slotstream' ? loadSlotstreamStatus : loadMtplxStatus);
  const toggleKeepLoaded = (runtime, nextPinned) => runAction(
    `runtime-keep-loaded-${runtime}`,
    () => patchSettingsSlice(`localLlm.${runtime}`, { keepLoaded: nextPinned }),
    nextPinned
      ? `${idleRuntimeLabel[runtime] || runtime} is pinned and will stay loaded`
      : `${idleRuntimeLabel[runtime] || runtime} will follow idle and pressure release policies`
  ).then(runtime === 'llama' ? loadLlamaStatus : runtime === 'slotstream' ? loadSlotstreamStatus : loadMtplxStatus);
  const runtimeInstallSlotstream = () => runAction(
    'runtime-install-slotstream',
    () => installSlotstream(),
    'Slotstream installed'
  ).then(loadSlotstreamStatus);
  const runtimeStartSlotstream = (launch = {}) => runAction(
    'runtime-start-slotstream',
    () => startSlotstreamServer(launch),
    (r) => r?.online ? 'Slotstream is running' : 'Slotstream is loading its checkpoint'
  ).then(loadSlotstreamStatus);
  const saveSlotstreamLaunch = (launch) => runAction(
    'runtime-save-slotstream-launch',
    () => patchSettingsSlice('localLlm.slotstream', { launch }),
    'Saved — Slotstream will start on these options when a request needs it'
  ).then(loadSlotstreamStatus);
  // The route awaits the whole transfer, so this request runs for as long as the
  // download does; the bar is driven by `slotstream:download` (subscribed above)
  // rather than by the spinner, and the terminal frame clears it first. The
  // clear below is the belt for a socket that dropped mid-transfer.
  const startSlotstreamDownload = (model) => runAction(
    'slotstream-download',
    () => downloadSlotstreamModel(model).then((r) => {
      if (r?.success === false) throw new Error(r.error || 'Download failed');
      return r;
    }),
    (r) => `${r?.repo || 'Checkpoint'} downloaded`,
    { onError: (err) => toast.error(`Slotstream download failed: ${err.message}`) },
  ).then(() => {
    setSlotstreamDownload(null);
    return loadSlotstreamStatus();
  });
  const slotstreamDownloadModel = (model) => requestWeightDownload({
    title: 'Download Slotstream checkpoint',
    preview: () => previewLocalLlmDownload({ kind: 'slotstream', model }, { silent: true }),
    run: () => startSlotstreamDownload(model),
  });
  // A 100 GB+ transfer that is merely SLOW never trips the idle watchdog, so
  // without this the only way out was to wait it out. The bar comes down on the
  // 'cancelled' frame the server emits, not here.
  const cancelSlotstreamDownload = (model) => runAction(
    'slotstream-download-cancel',
    () => cancelSlotstreamModelDownload(model, { silent: true }),
    (r) => (r?.cancelled ? 'Cancelling checkpoint download…' : 'No checkpoint download is running'),
    { onError: (err) => toast.error(err?.message || 'Could not cancel the checkpoint download') },
  );
  const runtimeStopSlotstream = () => runAction(
    'runtime-stop-slotstream',
    () => stopSlotstreamServer(),
    (r) => r?.message || 'Slotstream stopped'
  ).then(loadSlotstreamStatus);
  const runtimeStopMtplx = () => runAction(
    'runtime-stop-mtplx',
    () => stopMtplxServer(),
    (r) => r?.message || 'MTPLX stopped'
  ).then(loadMtplxStatus);

  // Checkpoint management (search / download / remove), owned by the MTPLX card.
  //
  // `mtplxSearch` keeps a stable identity because the checkpoint panel keys its
  // one-time initial load on it, and the status poll re-renders this component
  // every few seconds. It resolves its own failures into the `{models, error}`
  // shape the panel renders inline, so it is `silent` — no toast.
  const mtplxSearch = useCallback((params) => searchMtplxModels(params, { silent: true })
    .catch((err) => ({ models: [], error: err?.message || 'Search failed' })), []);
  // The pull resolves only when the weights are on disk; byte progress arrives
  // on `mtplx:download` (subscribed above), so the button spinner is not the
  // only sign of life during a multi-gigabyte transfer.
  const startMtplxPull = (model) => runAction(
    model ? `mtplx-pull-${model}` : 'mtplx-pull',
    // A failed download RESOLVES `{success: false, error}` rather than throwing
    // (its progress already streamed), so convert it to the rejection
    // `runAction` routes to `onError` — otherwise the success formatter runs on
    // a failure and toasts an empty success next to the error.
    () => pullMtplxModel(model).then((r) => {
      if (r?.success === false) throw new Error(r.error || 'Download failed');
      return r;
    }),
    (r) => `${r?.model || 'Default checkpoint'} downloaded`,
    { onError: (err) => toast.error(`MTPLX download failed: ${err.message}`) },
  ).then(() => {
    setMtplxDownload(null);
    return loadMtplxStatus();
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
  ).then(loadMtplxStatus);
  const saveRuntimeStartup = () => runAction(
    'runtime-save-startup',
    () => saveRuntimeStartupList(),
    'Saved — the PM2 processes running now will come back after a reboot'
  ).then(() => { loadLlamaStatus(); loadMtplxStatus(); loadSlotstreamStatus(); });
  const scrollTo = (ref) => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // Hand-editing a path the preset supplied means the form no longer describes
  // that preset — say Custom rather than keep claiming the preset is in effect.
  const setLlamaField = (field, value) => {
    setLlamaPresetId('custom');
    setLlamaForm((prev) => ({ ...prev, [field]: value }));
  };

  // Keep an emptied field empty so it can be retyped; the launch path fills in
  // the default. `Number('')` is 0, hence the explicit empty check.
  const setLlamaNumber = (field, raw) =>
    setLlamaForm((prev) => ({ ...prev, [field]: raw === '' ? '' : Number(raw) }));

  const specPresets = llamaStatus?.presets || [];
  const activeSpecPreset = specPresets.find((p) => p.id === llamaPresetId) || null;
  const activeSpecWeights = specWeightEntries(activeSpecPreset);
  // Clearing the target path is the one way back to a disabled Start — say why
  // rather than leaving a dead button.
  const llamaModelMissing = !llamaForm.model.trim();
  // A preset file the server says isn't on disk, still named by the form. This
  // is what the launcher would reject with LLAMA_MODEL_FILE_MISSING, so block
  // Start here and point at the Download button instead of spending a request
  // to produce an error the card can already answer.
  const missingWeight = (role) => {
    const entry = activeSpecPreset?.[role];
    const field = role === 'model' ? llamaForm.model : llamaForm.draftModel;
    return Boolean(entry?.path && !entry.exists && entry.path === (field || '').trim());
  };
  const baseWeightMissing = missingWeight('model');
  // Rendered from the server's list (status payload) so the card never carries a
  // second copy of the llama.cpp vocabulary.
  const specTypeSuggestions = llamaStatus?.specTypes || [];
  // MIRROR of `parseSpecTypes` / `isDraftSpecType` in
  // server/lib/specDecodePresets.js, and of how `startLlamaServer` resolves the
  // two fields against each other. An EMPTY spec type still drafts (llama.cpp
  // speculates off a bare `--model-draft`), so it counts as using the drafter.
  const requestedSpecTypes = String(llamaForm.specType || '').split(',').map((t) => t.trim()).filter(Boolean);
  const draftSpecTypes = requestedSpecTypes.filter((t) => t.startsWith('draft-'));
  const drafterInUse = requestedSpecTypes.length === 0 || draftSpecTypes.length > 0;
  const drafterConfigured = Boolean((llamaForm.draftModel || '').trim());
  // Only block Start on a missing drafter GGUF when the launch would actually
  // load one — an `ngram-*` run needs no drafter, so a preset's undownloaded
  // drafter path must not hold it hostage.
  const draftWeightMissing = drafterInUse && missingWeight('draftModel');
  const llamaStartBlocked = llamaModelMissing || baseWeightMissing || draftWeightMissing;
  // Say what the launcher will do with a mismatched pair rather than letting the
  // server quietly rewrite the launch line the user thought they were starting.
  const specTypeNotice = !drafterConfigured && draftSpecTypes.length > 0
    ? `${draftSpecTypes.join(', ')} will be skipped until a Drafter Model is set.`
    : drafterConfigured && !drafterInUse
      ? 'The Drafter Model will be ignored — none of these spec types use one.'
      : '';
  // Resolved server-side, because the browser has no idea what OS it is talking
  // to; absent until the first status lands, and the copy below says so.
  const llamaInstallCommand = llamaStatus?.installCommand;
  const llamaStartBlockedReason = llamaModelMissing
    ? 'Enter a Target Base Model path to enable Start'
    : baseWeightMissing
      ? 'Download the base model to enable Start'
      : draftWeightMissing
        ? 'Download the drafter, or clear the field to run without it'
        : '';

  const startSpecDownload = async (role) => {
    const presetId = llamaPresetId;
    const key = downloadKey(presetId, role);
    setLlamaDownloads((prev) => ({ ...prev, [key]: { received: 0, total: 0 } }));
    try {
      // Custom catch below owns the failure toast — `silent` keeps apiCore from
      // firing a second one for the same error.
      const res = await downloadSpecDecodeModel(presetId, role, { silent: true });
      toast.success(res?.alreadyDownloaded
        ? `${res.path} is already on disk`
        : `${res?.path || 'Model'} downloaded`);
    } catch (err) {
      // A multi-gigabyte transfer outlives plenty of things that can drop this
      // request — a reload, a proxy's idle timeout. The download itself keeps
      // running server-side, so ask the server before calling it a failure:
      // reporting "Download failed" over a transfer that is still going is the
      // one message guaranteed to send the user looking for a problem that
      // isn't there.
      const status = await loadLlamaStatus();
      const stillRunning = status?.presets
        ?.find((p) => p.id === presetId)?.[role]?.downloading;
      if (err?.code === 'SPEC_DOWNLOAD_CANCELLED') {
        toast.info('Download cancelled');
      } else if (stillRunning) {
        toast.warning('Download still running in the background — this page lost the request, not the transfer.');
      } else {
        toast.error(err?.message || 'Download failed');
      }
    } finally {
      setLlamaDownloads((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      loadLlamaStatus();
    }
  };

  const handleDownloadSpecModel = (role) => requestWeightDownload({
    title: 'Download speculative-decoding weights',
    preview: () => previewLocalLlmDownload(
      { kind: 'spec-decode', presetId: llamaPresetId, role },
      { silent: true },
    ),
    run: () => startSpecDownload(role),
  });

  const handleCancelSpecModelDownload = async (role) => {
    try {
      const res = await cancelSpecDecodeModelDownload(llamaPresetId, role, { silent: true });
      if (res.cancelled) toast.info('Cancelling model download…');
    } catch (err) {
      toast.error(err?.message || 'Could not cancel the model download');
    } finally {
      loadLlamaStatus();
    }
  };

  const handleStartLlama = async (e) => {
    e?.preventDefault?.();
    // Submitting with Enter bypasses the disabled button, so re-check here.
    if (llamaModelMissing) {
      toast.error('Please specify a base model path (e.g. models/Qwen3.8-27B-Q4_K_M.gguf)');
      return;
    }
    if (baseWeightMissing || draftWeightMissing) {
      toast.error(`${llamaStartBlockedReason} — the GGUF isn't on this machine yet.`);
      return;
    }
    setLlamaLoading(true);
    const config = { ...llamaForm };
    for (const [field, fallback] of Object.entries(LLAMA_NUMBER_DEFAULTS)) {
      if (!Number.isFinite(config[field])) config[field] = fallback;
    }
    // An untouched tuning field means "llama.cpp's default", which is NOT a
    // value we can name — drop it so the server leaves the flag off the launch
    // line instead of receiving an empty string it would coerce to 0.
    for (const field of LLAMA_TUNING_FIELDS) {
      if (config[field] === '' || config[field] === null) delete config[field];
    }
    try {
      const res = await startLlamaServer(config);
      if (res?.success) {
        toast.success(`llama-server started (PID ${res.pid}) on port ${config.port}`);
      }
      loadLlamaStatus();
    } catch (err) {
      toast.error(err?.message || 'Failed to start llama-server');
      loadLlamaStatus();
    } finally {
      setLlamaLoading(false);
    }
  };

  const handleStopLlama = async () => {
    setLlamaLoading(true);
    try {
      const res = await stopLlamaServer();
      if (res?.success) {
        toast.success(res.message || 'llama-server stopped');
      } else {
        toast.error(res?.message || 'Could not stop server');
      }
      loadLlamaStatus();
    } catch (err) {
      toast.error(err?.message || 'Failed to stop llama-server');
      loadLlamaStatus();
    } finally {
      setLlamaLoading(false);
    }
  };

  const handleInstallLlama = async () => {
    setLlamaLoading(true);
    try {
      const res = await installLlamaServer();
      if (res?.success) {
        toast.success(res.message || 'llama.cpp installed successfully');
      }
      loadLlamaStatus();
    } catch (err) {
      toast.error(err?.message || 'Failed to install llama.cpp');
      loadLlamaStatus();
    } finally {
      setLlamaLoading(false);
    }
  };

  const handlePresetSelect = (presetId) => {
    const preset = specPresets.find((p) => p.id === presetId);
    if (!preset) return;
    setLlamaPresetId(preset.id);
    // `custom` carries no paths — it exists so hand-entered fields keep a label.
    if (preset.model?.path || preset.draftModel?.path) {
      setLlamaForm((prev) => ({
        ...prev,
        model: preset.model?.path || '',
        draftModel: preset.draftModel?.path || '',
        specType: preset.specType || prev.specType,
      }));
    }
  };

  return (
    <section id="llm-management-panel-runtimes" role="tabpanel" aria-labelledby="tab-runtimes" className="space-y-4">
      <HardwareLlmRecommendation />
      {/* One start/stop/install surface for every local server PortOS can run */}
      <RuntimeServersCard
        status={status}
        llamaStatus={llamaStatus}
        mtplxStatus={mtplxStatus}
        slotstreamStatus={slotstreamStatus}
        loading={loading}
        busy={busy}
        actionInProgress={actionInProgress}
        onRefresh={loadStatus}
        onControlOllama={controlOllama}
        onControlLmStudio={controlLmStudio}
        onInstallBackend={installRuntimeBackend}
        onInstallLlama={runtimeInstallLlama}
        onUpgradeLlama={runtimeUpgradeLlama}
        onStopLlama={runtimeStopLlama}
        onConfigureLlama={() => scrollTo(llamaSectionRef)}
        onConfigureMtplx={() => scrollTo(mtplxSectionRef)}
        onInstallMtplx={runtimeInstallMtplx}
        onStartMtplx={runtimeStartMtplx}
        onStopMtplx={runtimeStopMtplx}
        onConfigureSlotstream={() => scrollTo(slotstreamSectionRef)}
        onInstallSlotstream={runtimeInstallSlotstream}
        onStartSlotstream={runtimeStartSlotstream}
        onStopSlotstream={runtimeStopSlotstream}
        onSaveStartup={saveRuntimeStartup}
        onSaveIdleWindow={saveIdleWindow}
        onToggleKeepLoaded={toggleKeepLoaded}
      />

      {/* Backends — model catalog, default marker, cross-backend import */}
      <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-4">
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {BACKENDS.map((b) => (
                <LocalLlmBackendCard
                  key={b.id} backend={b} status={status} isDefault={status.backend === b.id}
                  busy={busy} actionInProgress={actionInProgress}
                  runAction={runAction} setConfirmAction={setConfirmAction}
                />
              ))}
            </div>

            {progressMsg && (
              <div className="flex items-center gap-2 text-sm text-port-accent bg-port-accent/10 border border-port-accent/20 rounded-lg px-3 py-2">
                <BrailleSpinner />
                {progressMsg}
              </div>
            )}

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

      {/* Slotstream — PM2-managed SSD-streaming MoE runtime (Apple Silicon) */}
      <div ref={slotstreamSectionRef}>
        <SlotstreamServerCard
          status={slotstreamStatus}
          loading={loading}
          busy={busy}
          actionInProgress={actionInProgress}
          onRefresh={loadSlotstreamStatus}
          onSaveLaunch={saveSlotstreamLaunch}
          onStart={runtimeStartSlotstream}
          onStop={runtimeStopSlotstream}
          onInstall={runtimeInstallSlotstream}
          onDownloadModel={slotstreamDownloadModel}
          onCancelDownload={cancelSlotstreamDownload}
          download={slotstreamDownload}
        />
      </div>

      {/* MTPLX — PM2-managed native-MTP runtime (Apple Silicon) */}
      <div ref={mtplxSectionRef}>
        <MtplxServerCard
          status={mtplxStatus}
          loading={loading}
          busy={busy}
          actionInProgress={actionInProgress}
          onRefresh={loadMtplxStatus}
          onSaveLaunch={saveMtplxLaunch}
          onStart={runtimeStartMtplx}
          onStop={runtimeStopMtplx}
          onInstall={runtimeInstallMtplx}
          onSearchModels={mtplxSearch}
          onPullModel={mtplxPull}
          onRemoveModel={mtplxRemove}
          download={mtplxDownload}
        />
      </div>

      {/* Speculative Decoding & Custom Runtimes (DFlash 2 / llama.cpp) */}
      <div ref={llamaSectionRef} className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Zap size={16} className="text-port-accent" />
            <h2 className="text-sm font-medium text-gray-300">Speculative Decoding & Custom Runtimes (DFlash 2 / llama.cpp)</h2>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={loadLlamaStatus}
              disabled={llamaLoading}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-400 hover:text-white transition-colors"
              title="Refresh llama-server status"
              aria-label="Refresh llama-server status"
            >
              <RefreshCw size={13} className={llamaLoading ? 'animate-spin' : ''} />
            </button>
            <Link
              to="/ai"
              className="text-xs text-port-accent hover:underline flex items-center gap-1"
            >
              OpenCode llama TUI in AI Providers <ExternalLink size={11} />
            </Link>
          </div>
        </div>

        <p className="text-xs text-gray-400 leading-relaxed">
          Speculative decoding pairs a small drafter with your target model for 2–3× faster generation at identical output. You can launch and manage a local <code className="text-gray-300">llama-server</code> from PortOS and connect using the <strong className="text-white">OpenCode llama TUI</strong> provider. <strong className="text-white">DSpark</strong> (<code className="text-gray-300">draft-dspark</code>) works on a stock llama.cpp{llamaInstallCommand ? <> (<code className="text-gray-300">{llamaInstallCommand}</code>)</> : null}; the DFlash 2 presets need a from-source build of an unmerged llama.cpp branch. No drafter GGUF to hand? The <code className="text-gray-300">ngram-*</code> spec types under Advanced options draft from the context window alone.
        </p>

        {llamaStatus?.running ? (
          <div className="bg-port-bg border border-port-success/30 rounded-lg p-3 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="text-xs text-gray-300 space-y-1">
                <p><span className="text-gray-500">Endpoint:</span> <code className="text-port-success">{llamaStatus.endpoint}</code></p>
                {llamaStatus.config?.model && (
                  <p><span className="text-gray-500">Base Model:</span> <code className="text-gray-300">{llamaStatus.config.model}</code></p>
                )}
                {llamaStatus.config?.draftModel && (
                  <p><span className="text-gray-500">Drafter:</span> <code className="text-port-accent">{llamaStatus.config.draftModel}</code></p>
                )}
                {llamaStatus.config && (
                  <p>
                    <span className="text-gray-500">Model id:</span>{' '}
                    <code className="text-port-accent">{llamaStatus.config.alias || 'dflash'}</code>
                    {' '}— Providers must send this name. Change it under Advanced options before starting.
                  </p>
                )}
                {/* Split out from the Drafter line: an `ngram-*` launch runs
                    speculative decoding with no drafter at all, so hanging the
                    spec type off that line hid it exactly when it was the only
                    thing configured. */}
                <p>
                  <span className="text-gray-500">Spec Type:</span>{' '}
                  {llamaStatus.config?.specType
                    ? <code className="text-port-accent">{llamaStatus.config.specType}</code>
                    : <span className="text-gray-500">none — speculative decoding off</span>}
                </p>
              </div>
              {/* `managed` is a THREE-state field: `true` ours, `false`
                  somebody else's, `null` PM2 could not be read. A plain
                  truthiness test told a user whose own daemon PortOS had merely
                  failed to read that they had started it in a terminal — and
                  hid the Stop button for a server PortOS does own. */}
              {llamaStatus.managed === true ? (
                <button
                  onClick={handleStopLlama}
                  disabled={llamaLoading}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-port-error/20 hover:bg-port-error/30 text-port-error text-xs font-medium rounded-lg transition-colors disabled:opacity-50 shrink-0"
                >
                  {llamaLoading ? <BrailleSpinner /> : <PowerOff size={13} />}
                  Stop Server
                </button>
              ) : llamaStatus.managed === false ? (
                <span className="text-xs text-gray-500 italic">
                  Running as external process
                </span>
              ) : (
                <span className="text-xs text-gray-500 italic">
                  PM2 status could not be read — this may not be an external server
                </span>
              )}
            </div>
          </div>
        ) : llamaStatus?.installed ? (
          <form onSubmit={handleStartLlama} className="bg-port-bg border border-port-border/70 rounded-lg p-3 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <span className="text-xs font-medium text-gray-300">Launch Speculative Decoding Server</span>
              <div className="flex items-center gap-1.5">
                <FormField label="Preset" labelClassName="text-[11px] text-gray-500" className="flex items-center gap-1.5">
                  <select
                    id="llama-preset-select"
                    aria-label="Preset"
                    onChange={(e) => handlePresetSelect(e.target.value)}
                    value={llamaPresetId}
                    className="bg-port-card border border-port-border rounded px-2 py-1 text-xs text-port-accent focus:outline-none"
                  >
                    {specPresets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </FormField>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <FormField label="Target Base Model (GGUF Path) *" labelClassName="text-[11px] text-gray-400 block mb-1">
                <input
                  id="llama-base-model"
                  aria-label="Target Base Model (GGUF Path)"
                  type="text"
                  value={llamaForm.model}
                  onChange={(e) => setLlamaField('model', e.target.value)}
                  placeholder={activeSpecPreset?.model?.path || 'models/your-target-Q4_K_M.gguf'}
                  className="w-full bg-port-card border border-port-border rounded px-2.5 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-port-accent"
                />
              </FormField>
              <FormField label="Draft Model (Optional)" labelClassName="text-[11px] text-gray-400 block mb-1">
                <input
                  id="llama-draft-model"
                  aria-label="Draft Model (Optional)"
                  type="text"
                  value={llamaForm.draftModel}
                  onChange={(e) => setLlamaField('draftModel', e.target.value)}
                  placeholder={activeSpecPreset?.draftModel?.path || 'models/your-drafter.gguf'}
                  className="w-full bg-port-card border border-port-border rounded px-2.5 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-port-accent"
                />
              </FormField>
            </div>

            {activeSpecWeights.length > 0 && (
              <div className="space-y-1.5 pt-2 border-t border-port-border/40">
                <p className="text-[11px] text-gray-500">
                  Weights on this machine — each GGUF is a separate multi-gigabyte download from Hugging Face, fetched into the path above.
                </p>
                {activeSpecWeights.map((entry) => (
                  <SpecDecodeWeightRow
                    key={entry.role}
                    entry={entry}
                    progress={llamaDownloads[downloadKey(llamaPresetId, entry.role)]}
                    onDownload={handleDownloadSpecModel}
                    onCancel={handleCancelSpecModelDownload}
                    disabled={llamaLoading}
                  />
                ))}
              </div>
            )}

            {showLlamaAdvanced && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 border-t border-port-border/40 text-xs">
                <FormField label="Port" labelClassName="text-[11px] text-gray-400 block mb-1">
                  <input
                    id="llama-port"
                    aria-label="Port"
                    type="number"
                    value={llamaForm.port}
                    onChange={(e) => setLlamaNumber('port', e.target.value)}
                    className="w-full bg-port-card border border-port-border rounded px-2 py-1 text-xs text-white"
                  />
                </FormField>
                <FormField label="Context Size" labelClassName="text-[11px] text-gray-400 block mb-1">
                  <input
                    id="llama-ctx-size"
                    aria-label="Context Size"
                    type="number"
                    value={llamaForm.ctxSize}
                    onChange={(e) => setLlamaNumber('ctxSize', e.target.value)}
                    className="w-full bg-port-card border border-port-border rounded px-2 py-1 text-xs text-white"
                  />
                </FormField>
                <FormField label="GPU Layers (-ngl)" labelClassName="text-[11px] text-gray-400 block mb-1">
                  <input
                    id="llama-gpu-layers"
                    aria-label="GPU Layers (-ngl)"
                    type="number"
                    value={llamaForm.nGpuLayers}
                    onChange={(e) => setLlamaNumber('nGpuLayers', e.target.value)}
                    className="w-full bg-port-card border border-port-border rounded px-2 py-1 text-xs text-white"
                  />
                </FormField>
                <FormField label="Parallel slots" labelClassName="text-[11px] text-gray-400 block mb-1" className="col-span-2">
                  <input
                    id="llama-parallel"
                    aria-label="Parallel slots"
                    type="number"
                    min={1}
                    max={16}
                    value={llamaForm.parallel}
                    onChange={(e) => setLlamaNumber('parallel', e.target.value)}
                    className="w-full bg-port-card border border-port-border rounded px-2 py-1 text-xs text-white"
                  />
                  <p className="text-[11px] text-gray-500 mt-1">
                    llama.cpp divides context across this many request slots. 1 is right for a TUI agent.
                  </p>
                </FormField>
                <FormField label="Spec Type" labelClassName="text-[11px] text-gray-400 block mb-1" className="col-span-2 sm:col-span-4">
                  <input
                    id="llama-spec-type"
                    aria-label="Spec Type"
                    type="text"
                    list="llama-spec-type-options"
                    value={llamaForm.specType}
                    onChange={(e) => setLlamaField('specType', e.target.value)}
                    className="w-full bg-port-card border border-port-border rounded px-2 py-1 text-xs text-white"
                  />
                  <datalist id="llama-spec-type-options">
                    {specTypeSuggestions.map((entry) => (
                      <option key={entry.id} value={entry.id}>{entry.note}</option>
                    ))}
                  </datalist>
                  <p className="text-[11px] text-gray-500 mt-1">
                    Comma-separate to run several at once, e.g. <code className="text-gray-400">draft-dflash,ngram-map-k</code>.
                    Only <code className="text-gray-400">draft-*</code> types need a drafter GGUF — the{' '}
                    <code className="text-gray-400">ngram-*</code> ones speculate from the tokens already in context, so they run
                    with the Drafter field empty.
                  </p>
                  {specTypeNotice && (
                    <p className="text-[11px] text-port-warning mt-1">{specTypeNotice}</p>
                  )}
                </FormField>
                <FormField label="Model id (alias)" labelClassName="text-[11px] text-gray-400 block mb-1">
                  <input
                    id="llama-alias"
                    aria-label="Model id (alias)"
                    type="text"
                    value={llamaForm.alias}
                    onChange={(e) => setLlamaForm((prev) => ({ ...prev, alias: e.target.value }))}
                    className="w-full bg-port-card border border-port-border rounded px-2 py-1 text-xs text-white"
                  />
                </FormField>

                {/* Performance tuning. Unlike the fields above, these have no
                    PortOS default — an empty one is stripped from the launch
                    line so llama.cpp applies its own. Measure what a change
                    actually bought on Models → Performance. */}
                <p className="col-span-2 sm:col-span-4 text-[11px] text-gray-500 pt-1 border-t border-port-border/40">
                  Performance tuning — leave a field empty for llama.cpp&apos;s own default.{' '}
                  <Link to="/models/performance" className="text-port-accent hover:underline">Measure the difference</Link>{' '}
                  after changing one.
                </p>
                <FormField label="Batch size (-b)" labelClassName="text-[11px] text-gray-400 block mb-1">
                  <input
                    id="llama-batch-size"
                    aria-label="Batch size (-b)"
                    type="number"
                    placeholder="default"
                    value={llamaForm.batchSize}
                    onChange={(e) => setLlamaNumber('batchSize', e.target.value)}
                    className="w-full bg-port-card border border-port-border rounded px-2 py-1 text-xs text-white"
                  />
                </FormField>
                <FormField label="Micro-batch (-ub)" labelClassName="text-[11px] text-gray-400 block mb-1">
                  <input
                    id="llama-ubatch-size"
                    aria-label="Micro-batch (-ub)"
                    type="number"
                    placeholder="default"
                    value={llamaForm.ubatchSize}
                    onChange={(e) => setLlamaNumber('ubatchSize', e.target.value)}
                    className="w-full bg-port-card border border-port-border rounded px-2 py-1 text-xs text-white"
                  />
                </FormField>
                <FormField label="CPU threads (-t)" labelClassName="text-[11px] text-gray-400 block mb-1">
                  <input
                    id="llama-threads"
                    aria-label="CPU threads (-t)"
                    type="number"
                    placeholder="default"
                    value={llamaForm.threads}
                    onChange={(e) => setLlamaNumber('threads', e.target.value)}
                    className="w-full bg-port-card border border-port-border rounded px-2 py-1 text-xs text-white"
                  />
                </FormField>
                <div className="flex items-end gap-2 pb-1">
                  <input
                    id="llama-flash-attn"
                    type="checkbox"
                    checked={llamaForm.flashAttn}
                    onChange={(e) => setLlamaForm((prev) => ({ ...prev, flashAttn: e.target.checked }))}
                    className="accent-port-accent"
                  />
                  <label htmlFor="llama-flash-attn" className="text-[11px] text-gray-400">Flash attention</label>
                </div>
                <FormField label="KV cache K" labelClassName="text-[11px] text-gray-400 block mb-1">
                  <select
                    id="llama-cache-type-k"
                    aria-label="KV cache K"
                    value={llamaForm.cacheTypeK}
                    onChange={(e) => setLlamaField('cacheTypeK', e.target.value)}
                    className="w-full bg-port-card border border-port-border rounded px-2 py-1 text-xs text-white"
                  >
                    <option value="">default</option>
                    {LLAMA_CACHE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </FormField>
                <FormField label="KV cache V" labelClassName="text-[11px] text-gray-400 block mb-1">
                  <select
                    id="llama-cache-type-v"
                    aria-label="KV cache V"
                    value={llamaForm.cacheTypeV}
                    onChange={(e) => setLlamaField('cacheTypeV', e.target.value)}
                    className="w-full bg-port-card border border-port-border rounded px-2 py-1 text-xs text-white"
                  >
                    <option value="">default</option>
                    {LLAMA_CACHE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </FormField>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowLlamaAdvanced((prev) => !prev)}
                className="text-[11px] text-gray-500 hover:text-gray-300 flex items-center gap-1"
              >
                {showLlamaAdvanced ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                {showLlamaAdvanced ? 'Hide options' : 'Advanced options (port, ctx, GPU layers, parallel slots, model id, spec type, performance tuning)'}
              </button>
              <div className="flex items-center gap-2">
                {llamaStartBlocked && (
                  <span className="text-[11px] text-port-warning text-right">
                    {llamaStartBlockedReason}
                  </span>
                )}
                <button
                  type="submit"
                  disabled={llamaLoading || llamaStartBlocked}
                  title={llamaModelMissing
                    ? 'Target Base Model (GGUF Path) is required before the server can start'
                    : llamaStartBlocked
                      ? `${llamaStartBlockedReason} — llama.cpp can't load a GGUF that isn't on disk`
                      : 'Launch llama-server with these settings'}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent text-xs font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                >
                  {llamaLoading ? <BrailleSpinner /> : <Power size={13} />}
                  Start Speculative Server
                </button>
              </div>
            </div>
          </form>
        ) : (
          <div className="bg-port-warning/10 border border-port-warning/30 rounded-lg p-3 text-xs text-port-warning flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-1">
              <p className="font-semibold">llama-server was not detected on system PATH.</p>
              <p className="text-gray-300">
                {llamaInstallCommand
                  ? <>Install it with <code className="text-gray-300">{llamaInstallCommand}</code>, or compile the DFlash 2-enabled branch from source.</>
                  : <>Install it from your platform&apos;s package manager, or compile the DFlash 2-enabled branch from source.</>}
              </p>
            </div>
            <button
              onClick={handleInstallLlama}
              disabled={llamaLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent text-xs font-medium rounded-lg transition-colors disabled:opacity-50 shrink-0"
            >
              {llamaLoading ? <BrailleSpinner /> : <Download size={13} />}
              Install llama.cpp
            </button>
          </div>
        )}

        {llamaStatus?.recentLogs?.length > 0 && (
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => setShowLlamaLogs((prev) => !prev)}
              className="text-[11px] text-gray-500 hover:text-gray-300 flex items-center gap-1"
            >
              <Terminal size={11} />
              {showLlamaLogs ? 'Hide server logs' : `View server logs (${llamaStatus.recentLogs.length} lines)`}
            </button>
            {showLlamaLogs && (
              <pre className="text-[10px] text-gray-400 bg-port-bg border border-port-border/60 p-2.5 rounded max-h-40 overflow-y-auto font-mono whitespace-pre-wrap break-all">
                {llamaStatus.recentLogs.join('\n')}
              </pre>
            )}
          </div>
        )}
      </div>
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
