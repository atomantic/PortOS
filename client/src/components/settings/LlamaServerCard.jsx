import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ChevronDown, ChevronUp, Download, ExternalLink, Power, PowerOff, RefreshCw, Zap } from 'lucide-react';
import toast from '../ui/Toast';
import FormField from '../ui/FormField';
import BrailleSpinner from '../BrailleSpinner';
import { PORTS } from '../../lib/ports.js';
import {
  cancelSpecDecodeModelDownload, downloadSpecDecodeModel, previewLocalLlmDownload, removeSpecDecodeModel,
} from '../../services/apiLocalLlm.js';
import socket from '../../services/socket';
import SpecDecodeWeightRow from './SpecDecodeWeightRow.jsx';
import RuntimeLogDisclosure from './RuntimeLogDisclosure.jsx';

// The speculative-decoding presets come from the server
// (`server/lib/specDecodePresets.js`, surfaced on the llama-server status
// response) rather than a table here: each preset names a multi-gigabyte GGUF,
// and only the server knows which Hugging Face repo it comes from, whether it
// is already on disk, and how to fetch it. A client-side copy would inevitably
// list a path the Download button had no source for.
const DEFAULT_SPEC_PRESET_ID = 'qwen3.8-27b-dspark';
const downloadKey = (presetId, role) => `${presetId}:${role}`;
// The projector is the one weight a launch is fine WITHOUT — no `--mmproj` just
// means text-only. So unlike the base model and the drafter, its path is seeded
// only once the GGUF is actually on disk: seeding a path that isn't there would
// block Start on an optional 629 MB download, behind a field that lives under
// Advanced. Downloading it from the row below fills this in (see startSpecDownload).
const seededProjectorPath = (preset) => (preset?.projector?.exists ? preset.projector.path : '');
// Each entry carries its own `role`, so the rows come straight off the preset
// rather than from a second copy of the role list.
const specWeightEntries = (preset) => [preset?.model, preset?.draftModel, preset?.projector].filter((e) => e?.path);

// Defaults for the advanced numeric fields. They are applied when the server is
// launched rather than on every keystroke: a controlled number input that coerces
// as you type snaps back to its default the moment you clear it to retype.
// The launcher port comes from the shared PORTS map. 8080 is a common
// IPFS / Tomcat / local-dashboard port and is not a safe default for a managed
// daemon.
const DEFAULT_LLAMA_ALIAS = 'dflash';
const LLAMA_NUMBER_DEFAULTS = { port: PORTS.LLAMA_SERVER, ctxSize: 32768, nGpuLayers: 99, parallel: 1 };
// Optional llama.cpp tuning flags — unlike the fields above these have NO
// PortOS default: an untouched one is stripped from the launch payload so
// llama.cpp applies its own. Mirrors `server/lib/localModelTuning.js`.
const LLAMA_TUNING_FIELDS = ['batchSize', 'ubatchSize', 'threads', 'cacheTypeK', 'cacheTypeV'];
// KV-cache types llama.cpp accepts for --cache-type-k/-v; '' means "leave it off".
const LLAMA_CACHE_TYPES = ['f16', 'q8_0', 'q4_0'];

export default function LlamaServerCard({
  status: llamaStatus, busy, actionInProgress, onRefresh, onStart, onStop, onInstall,
  requestWeightDownload, onDownloadActivityChange,
}) {
  const llamaBusy = actionInProgress?.endsWith('-llama');
  const [llamaPresetId, setLlamaPresetId] = useState(DEFAULT_SPEC_PRESET_ID);
  const [llamaForm, setLlamaForm] = useState({
    model: '',
    draftModel: '',
    // llama.cpp's `--mmproj` vision sidecar. Empty = text-only, which is what a
    // preset with no projector launches.
    projector: '',
    specType: 'draft-dspark',
    port: LLAMA_NUMBER_DEFAULTS.port,
    host: '127.0.0.1',
    ctxSize: 32768,
    nGpuLayers: 99,
    alias: DEFAULT_LLAMA_ALIAS,
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
  // The LIVE preset id. A multi-gigabyte download outlives many renders, so a
  // handler resuming from its await must compare against this rather than the
  // `llamaPresetId` its own closure captured — that one can only ever equal the
  // value the handler already started with.
  const llamaPresetIdRef = useRef(llamaPresetId);
  llamaPresetIdRef.current = llamaPresetId;
  const [showLlamaAdvanced, setShowLlamaAdvanced] = useState(false);

  const downloading = Object.keys(llamaDownloads).length > 0;
  useEffect(() => {
    onDownloadActivityChange(downloading);
  }, [downloading, onDownloadActivityChange]);

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
      projector: seededProjectorPath(preset),
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
        onRefresh();
        return;
      }
      setLlamaDownloads((prev) => ({
        ...prev,
        [key]: { received: frame.received || 0, total: frame.total || 0 },
      }));
    };
    socket.on('llamaServer:download', handleDownloadProgress);
    return () => socket.off('llamaServer:download', handleDownloadProgress);
  }, [onRefresh]);

  // Hand-editing a path the preset supplied means the form no longer describes
  // that preset — say Custom rather than keep claiming the preset is in effect.
  const setLlamaField = (field, value) => {
    setLlamaPresetId('custom');
    setLlamaForm((prev) => ({
      ...prev,
      ...(field === 'model' && activeSpecPreset?.localBuild && prev.alias === activeSpecPreset.alias
        ? { alias: DEFAULT_LLAMA_ALIAS } : {}),
      [field]: value,
    }));
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
  // Every role's form field is named after the role, so no mapping is needed —
  // adding `projector` to the vocabulary did not add a branch here.
  const missingWeight = (role) => {
    const entry = activeSpecPreset?.[role];
    return Boolean(entry?.path && !entry.exists && entry.path === (llamaForm[role] || '').trim());
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
  // No spec type turns vision on or off: a projector path in the field is one the
  // launch line will carry, so an undownloaded one blocks Start unconditionally —
  // the server would reject it with LLAMA_MODEL_FILE_MISSING anyway.
  const projectorWeightMissing = missingWeight('projector');
  const llamaStartBlocked = llamaModelMissing || baseWeightMissing || draftWeightMissing || projectorWeightMissing;
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
        : projectorWeightMissing
          ? 'Download the vision projector, or clear the field to run text-only'
          : '';

  const startSpecDownload = async (role) => {
    const presetId = llamaPresetId;
    const key = downloadKey(presetId, role);
    setLlamaDownloads((prev) => ({ ...prev, [key]: { received: 0, total: 0 } }));
    try {
      // Custom catch below owns the failure toast — `silent` keeps apiCore from
      // firing a second one for the same error.
      const res = await downloadSpecDecodeModel(presetId, role, { silent: true });
      // A shipped preset field is empty or still `models/<file>`. Adopt the
      // path the download wrote (the hub snapshot for those presets) so the
      // next start uses it. A hand-entered path outside `models/` stays.
      if (res?.path && presetId === llamaPresetIdRef.current) {
        setLlamaForm((prev) => {
          const current = String(prev[role] || '').trim().replace(/\\/g, '/');
          if (current && !current.startsWith('models/')) return prev;
          return { ...prev, [role]: res.path };
        });
      }
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
      const status = await onRefresh();
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
      onRefresh();
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
      onRefresh();
    }
  };

  const handleDeleteSpecModel = async (role) => {
    try {
      const presetId = llamaPresetId;
      const res = await removeSpecDecodeModel(presetId, role, { silent: true });
      // Deleting the sidecar is the inverse of fetching it, so release the field
      // it armed — otherwise the path stays behind and blocks Start on a file the
      // user just chose to remove, with the only Clear button under Advanced.
      if (res?.path && presetId === llamaPresetIdRef.current) {
        setLlamaForm((prev) => (
          String(prev[role] || '').trim() === String(res.path).trim() ? { ...prev, [role]: '' } : prev
        ));
      }
      toast.success(res?.path ? `Deleted ${res.path}` : 'Weight file deleted');
    } catch (err) {
      toast.error(err?.message || 'Could not delete the weight file');
    } finally {
      onRefresh();
    }
  };

  const handleStartLlama = (e) => {
    e?.preventDefault?.();
    // Submitting with Enter bypasses the disabled button, so re-check here.
    if (busy) return;
    if (llamaModelMissing) {
      toast.error('Please specify a base model path (e.g. models/Qwen3.8-27B-Q4_K_M.gguf)');
      return;
    }
    if (baseWeightMissing || draftWeightMissing || projectorWeightMissing) {
      toast.error(`${llamaStartBlockedReason} — the GGUF isn't on this machine yet.`);
      return;
    }
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
    return onStart(config);
  };

  const handlePresetSelect = (presetId) => {
    const preset = specPresets.find((p) => p.id === presetId);
    if (!preset) return;
    setLlamaPresetId(preset.id);
    // `custom` carries no paths — it exists so hand-entered fields keep a label.
    if (preset.model?.path || preset.draftModel?.path || preset.projector?.path) {
      setLlamaForm((prev) => ({
        ...prev,
        model: preset.model?.path || '',
        draftModel: preset.draftModel?.path || '',
        projector: seededProjectorPath(preset),
        specType: preset.specType || prev.specType,
        // Do not keep the previous preset's model alias or context on a different target.
        alias: preset.alias ?? (prev.alias === activeSpecPreset?.alias ? DEFAULT_LLAMA_ALIAS : prev.alias),
        ctxSize: preset.ctxSize ?? (prev.ctxSize === activeSpecPreset?.ctxSize ? LLAMA_NUMBER_DEFAULTS.ctxSize : prev.ctxSize),
      }));
    }
  };

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Zap size={16} className="text-port-accent" />
          <h2 className="text-sm font-medium text-gray-300">Speculative Decoding & Custom Runtimes (DFlash 2 / llama.cpp)</h2>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={onRefresh}
            disabled={busy}
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-400 hover:text-white transition-colors"
            title="Refresh llama-server status"
            aria-label="Refresh llama-server status"
          >
            <RefreshCw size={13} className={llamaBusy ? 'animate-spin' : ''} />
          </button>
          <Link
            to="/ai"
            className="text-xs text-port-accent hover:underline flex items-center gap-1"
          >
            OpenCode llama TUI in AI Providers <ExternalLink size={11} />
          </Link>
        </div>
      </div>

      <details>
        <summary className="min-h-[44px] content-center cursor-pointer text-xs text-gray-400">About speculative decoding and presets</summary>
      <p className="text-xs text-gray-400 leading-relaxed">
        Speculative decoding pairs a small drafter with your target model for 2–3× faster generation at identical output. You can launch and manage a local <code className="text-gray-300">llama-server</code> from PortOS and connect using the <strong className="text-white">OpenCode llama TUI</strong> provider. <strong className="text-white">DSpark</strong> (<code className="text-gray-300">draft-dspark</code>) works on a stock llama.cpp{llamaInstallCommand ? <> (<code className="text-gray-300">{llamaInstallCommand}</code>)</> : null}; the DFlash 2 presets need a from-source build of an unmerged llama.cpp branch. No drafter GGUF to hand? The <code className="text-gray-300">ngram-*</code> spec types under Advanced options draft from the context window alone.
      </p>
      </details>

      {!llamaStatus ? (
        <p role="status" className="text-sm text-gray-400">llama.cpp status is unavailable. Refresh status before configuring this runtime.</p>
      ) : llamaStatus.running ? (
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
              {/* Only shown when one is loaded. A launch with no `--mmproj` is
                  text-only, and "Vision: none" on every non-multimodal run
                  would be noise on the card's most-read lines. */}
              {llamaStatus.config?.projector && (
                <p><span className="text-gray-500">Vision projector:</span> <code className="text-port-accent">{llamaStatus.config.projector}</code></p>
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
                onClick={onStop}
                disabled={busy}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-port-error/20 hover:bg-port-error/30 text-port-error text-xs font-medium rounded-lg transition-colors disabled:opacity-50 shrink-0"
              >
                {llamaBusy ? <BrailleSpinner /> : <PowerOff size={13} />}
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
                  className="bg-port-card border border-port-border rounded px-2 py-1 text-xs text-port-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-port-accent"
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
                {activeSpecPreset?.localBuild
                  ? 'Weights were converted locally from the original checkpoint.'
                  : 'Weights on this machine — each GGUF is a separate multi-gigabyte download from Hugging Face, fetched into the path above.'}
              </p>
              {activeSpecWeights.map((entry) => (
                <SpecDecodeWeightRow
                  key={entry.role}
                  entry={entry}
                  progress={llamaDownloads[downloadKey(llamaPresetId, entry.role)]}
                  onDownload={handleDownloadSpecModel}
                  onCancel={handleCancelSpecModelDownload}
                  onDelete={handleDeleteSpecModel}
                  disabled={busy}
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
              {/* Under Advanced rather than beside the two model paths: only a
                  multimodal GGUF has a projector at all, so for most presets
                  this field is permanently empty and would only crowd the
                  fold. It is independent of Spec Type — nothing about
                  speculative decoding turns vision on or off. */}
              <FormField label="Vision Projector / --mmproj (Optional)" labelClassName="text-[11px] text-gray-400 block mb-1" className="col-span-2 sm:col-span-4">
                <input
                  id="llama-projector"
                  aria-label="Vision Projector / --mmproj (Optional)"
                  type="text"
                  value={llamaForm.projector}
                  onChange={(e) => setLlamaField('projector', e.target.value)}
                  placeholder={activeSpecPreset?.projector?.path || 'models/your-model-mmproj-Q8_0.gguf'}
                  className="w-full bg-port-card border border-port-border rounded px-2 py-1 text-xs text-white placeholder-gray-600"
                />
                <p className="text-[11px] text-gray-500 mt-1">
                  A multimodal model&apos;s vision tower ships as a separate <code className="text-gray-400">mmproj</code> GGUF.
                  Leave this empty to launch text-only — the model still loads and answers, it just cannot see images.
                </p>
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
            <div className="flex flex-wrap items-center gap-2">
              {llamaStartBlocked && (
                <span className="text-[11px] text-port-warning">
                  {llamaStartBlockedReason}
                </span>
              )}
              <button
                type="submit"
                disabled={busy || llamaStartBlocked}
                title={llamaModelMissing
                  ? 'Target Base Model (GGUF Path) is required before the server can start'
                  : llamaStartBlocked
                    ? `${llamaStartBlockedReason} — llama.cpp can't load a GGUF that isn't on disk`
                    : 'Launch llama-server with these settings'}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent text-xs font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              >
                {llamaBusy ? <BrailleSpinner /> : <Power size={13} />}
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
            onClick={onInstall}
            disabled={busy}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent text-xs font-medium rounded-lg transition-colors disabled:opacity-50 shrink-0"
          >
            {llamaBusy ? <BrailleSpinner /> : <Download size={13} />}
            Install llama.cpp
          </button>
        </div>
      )}

      <RuntimeLogDisclosure logs={llamaStatus?.recentLogs} />
    </div>
  );
}
