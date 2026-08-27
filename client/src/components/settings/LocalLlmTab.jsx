import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router';
import { Cpu, Box, Download, RefreshCw, Search, Plus, ExternalLink, Star, Link2, Copy, Play, Power, PowerOff, AlertTriangle, Zap, ChevronDown, ChevronUp, Terminal } from 'lucide-react';
import toast from '../ui/Toast';
import FormField from '../ui/FormField';
import BrailleSpinner from '../BrailleSpinner';
import { formatAgeDays, formatBytes, formatContextLength, timeAgo, recommendedRamGb, formatDateNumeric } from '../../utils/formatters';
import { localLlmTargetKey } from '../../lib/localLlmTargetKey';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';
import {
  getLocalLlmStatus, getLocalLlmCatalog, getLocalLlmHuggingFaceSearch, installLocalLlmModel,
  deleteLocalLlmModel, migrateLocalLlmBackend, installLocalLlmBackend, upgradeLocalLlmBackend, controlOllamaService,
  installAudioModel, patchSettingsSlice, getLlamaServerStatus, getLlamaServerUpdateStatus, startLlamaServer, stopLlamaServer, installLlamaServer, upgradeLlamaServer,
  downloadSpecDecodeModel, cancelSpecDecodeModelDownload, controlLmStudioService, getMtplxServerStatus, stopMtplxServer, installMtplx,
  searchMtplxModels, pullMtplxModel, removeMtplxModel,
  saveRuntimeStartupList
} from '../../services/api';
import socket from '../../services/socket';
import CapabilityBadges from '../models/CapabilityBadges.jsx';
import SpecDecodeWeightRow from './SpecDecodeWeightRow.jsx';
import RuntimeServersCard from './RuntimeServersCard.jsx';
import MtplxServerCard from './MtplxServerCard.jsx';
import LocalLlmBackendCard from './LocalLlmBackendCard.jsx';
import LocalLlmInstalledModels from './LocalLlmInstalledModels.jsx';

const BACKENDS = [
  { id: 'ollama', label: 'Ollama', icon: Cpu },
  { id: 'lmstudio', label: 'LM Studio', icon: Box }
];
const labelFor = (id) => BACKENDS.find((b) => b.id === id)?.label || id;

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

const btnClass = 'flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded transition-colors disabled:opacity-50';

const CATEGORY_LABELS = {
  general: 'General purpose',
  coding: 'Coding & agents',
  reasoning: 'Reasoning & analysis',
  vision: 'Image Analysis',
  chat: 'Chat & voice',
  writing: 'Fiction & writing',
  audio: 'Audio & Music',
  embedding: 'Text Embeddings',
  lightweight: 'Small & Fast',
  multilingual: 'Multilingual'
};
const CATEGORY_ORDER = ['general', 'coding', 'writing', 'reasoning', 'vision', 'chat', 'lightweight', 'multilingual', 'embedding', 'audio'];
const categoryLabel = (id) => CATEGORY_LABELS[id] || id;
const primaryCategoryFor = (model) => model?.category || 'general';
const recommendationCategoriesFor = (model) => {
  const categories = model?.recommendedFor;
  return Array.isArray(categories) && categories.length ? categories : [primaryCategoryFor(model)];
};
const isRecommendedForCategory = (model, category) => recommendationCategoriesFor(model).includes(category);

// A model suited to AGENT / CoS tasks (coding agents, the Creative Director
// treatment/plan agents) needs BOTH native tool calling AND enough coding /
// instruction-following muscle to drive a multi-step loop. A chat-only
// tool-caller (e.g. a small function-calling voice brain) clears `tools` but
// isn't an agent workhorse, and a `code` model without `tools` narrates instead
// of acting — so we require both. Keyed off catalog capabilities (server truth),
// NOT a hard-coded model list, so new agentic models light up automatically.
const isAgentRecommendedModel = (capabilities) =>
  Array.isArray(capabilities)
  && capabilities.includes('tools')
  && capabilities.includes('code');

// Server-computed per-quant fit verdict → badge styling + short label. Drives
// the RAM-fit hint on the quant picker so a too-large build reads as a warning.
const FIT_META = {
  comfortable: { label: 'fits comfortably', cls: 'text-port-success' },
  tight: { label: 'tight fit', cls: 'text-port-warning' },
  'too-large': { label: 'exceeds RAM', cls: 'text-port-error' },
  // Only ever produced by a MEASUREMENT — the size estimate cannot know that a
  // backend refuses a model outright, and no amount of free RAM changes it.
  incompatible: { label: 'backend refused it', cls: 'text-port-error' },
};

// The fit badge is a size ESTIMATE (weights + ~20% overhead vs. usable memory)
// until the model has actually been run here, at which point the measurement
// replaces it. The tooltip has to say which one the reader is looking at —
// "fits comfortably" from arithmetic and "fits comfortably" from a real run are
// very different claims — and it names the disagreement when there is one,
// because that is the most useful thing the measurement can say.
function fitTitle(source, entry) {
  if (source !== 'measured') {
    const stale = entry?.measuredFit && entry?.stale
      ? ` A previous measurement (${FIT_META[entry.measuredFit]?.label || entry.measuredFit}) was taken on a different machine state, so the estimate stands.`
      : '';
    return `Estimated fit on this machine — model weights + ~20% overhead vs. usable memory.${stale}`;
  }
  const measuredAt = entry?.assessedAt ? ` on ${formatDateNumeric(entry.assessedAt)}` : '';
  const disagree = entry?.disagrees
    ? ` The size estimate said "${FIT_META[entry.estimatedFit]?.label || entry.estimatedFit}".`
    : '';
  return `Measured on this machine${measuredAt} — PortOS ran this model rather than estimating from its file size.${disagree}`;
}

// Model format badge — GGUF (llama.cpp, cross-backend) vs. MLX (Apple's native
// format, LM Studio on Apple Silicon only). Shown so the user knows what they're
// installing when both formats appear in the same result list.
const FORMAT_META = {
  gguf: { label: 'GGUF', title: 'GGUF — llama.cpp format, runs on Ollama and LM Studio', cls: 'border-port-border text-gray-400' },
  mlx: { label: 'MLX', title: "MLX — Apple's native format, installs via LM Studio on Apple Silicon", cls: 'border-port-accent/40 text-port-accent' },
};


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

export function LocalLlmTab() {
  const navigate = useNavigate();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState('ollama');
  const [catalogSource, setCatalogSource] = useState('recommended');
  const [catalog, setCatalog] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  // Total unified/system memory (GB) reported by the HF search, used to caption
  // the RAM-aware quant defaults. null until the first Hugging Face search.
  const [systemMemoryGb, setSystemMemoryGb] = useState(null);
  // Per-result quant override: { [repoKey]: installId }. Empty → use each
  // result's RAM-aware default (`m.id`). Cleared whenever the catalog reloads.
  const [selectedVariants, setSelectedVariants] = useState({});
  const [activeCategory, setActiveCategory] = useState('all');
  const [query, setQuery] = useState('');
  const [manualId, setManualId] = useState('');
  const [actionInProgress, setActionInProgress] = useState(null);
  const [progressMsg, setProgressMsg] = useState('');
  const [confirmAction, setConfirmAction] = useState(null);
  // id of the installed model awaiting a delete confirmation (two-step inline
  // confirm — deleting weights is an irreversible multi-GB rm -rf / DELETE).
  const { isConfirming: isConfirmingDelete, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();
  const [compareTargets, setCompareTargets] = useState([]);
  const progressTimer = useRef(null);
  const statusRequestId = useRef(0);
  const catalogRequestId = useRef(0);
  const selectedInitialized = useRef(false);

  const [llamaStatus, setLlamaStatus] = useState(null);
  const [mtplxStatus, setMtplxStatus] = useState(null);
  // Live byte progress for an in-flight `mtplx pull`, driven by the socket. One
  // at a time on purpose: a checkpoint is tens of gigabytes, so two concurrent
  // pulls just make both slower.
  const [mtplxDownload, setMtplxDownload] = useState(null);
  const [llamaLoading, setLlamaLoading] = useState(false);
  // Anchor for the unified server card's "Configure" action — llama-server needs
  // a model path, so its Start lives in the launcher rather than in that row.
  const llamaSectionRef = useRef(null);
  const mtplxSectionRef = useRef(null);
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

  const loadStatus = useCallback(() => {
    const requestId = ++statusRequestId.current;
    setLoading(true);
    loadLlamaStatus();
    loadMtplxStatus();
    return getLocalLlmStatus({ silent: true })
      .then((s) => {
        if (requestId !== statusRequestId.current) return;
        setStatus(s);
        // Default the model-management view to the active backend on first load.
        if (!selectedInitialized.current && s?.backend) {
          setSelected(s.backend);
          selectedInitialized.current = true;
        }
      })
      .catch(() => {
        if (requestId === statusRequestId.current) toast.error('Failed to load local LLM status');
      })
      .finally(() => {
        if (requestId === statusRequestId.current) setLoading(false);
      });
  }, [loadLlamaStatus, loadMtplxStatus]);

  // `source` and `category` are required rather than defaulted from state: a
  // state default would put them in the dep list, so `loadCatalog`'s identity
  // would change on every category click and re-trigger the debounce effect —
  // the exact refetch the effect below is written to avoid. Every call site
  // passes both.
  const loadCatalog = useCallback((backend, q, source, category) => {
    const requestId = ++catalogRequestId.current;
    setCatalogLoading(true);
    setCatalogError('');
    const request = source === 'huggingface'
      ? getLocalLlmHuggingFaceSearch(backend, q, category, 18)
      : getLocalLlmCatalog(backend, q, { variants: true });
    return request
      .then((r) => {
        if (requestId !== catalogRequestId.current) return;
        setCatalog(r.models || []);
        if (Number.isFinite(r.systemMemoryGb)) setSystemMemoryGb(r.systemMemoryGb);
        // A fresh result set invalidates any per-card quant overrides.
        setSelectedVariants({});
      })
      .catch((err) => {
        if (requestId !== catalogRequestId.current) return;
        setCatalog([]);
        setCatalogError(source === 'huggingface' ? (err?.message || 'Hugging Face search failed') : '');
      })
      .finally(() => {
        if (requestId === catalogRequestId.current) setCatalogLoading(false);
      });
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

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
  // Debounce so typing in the search box doesn't fire a request per keystroke.
  //
  // `activeCategory` is a trigger for the Hugging Face source ONLY — the live
  // search asks the Hub for that category's models, so switching tabs is a new
  // query. The curated catalog sends just backend+q and filters by category on
  // the client (see visibleCatalogGroups), so refetching on a tab click would
  // re-request a byte-identical list AND re-run the server's ~36-repo variant
  // enrichment. `catalogCategoryKey` is the category when it matters and a
  // constant when it doesn't, which keeps the whole effect one code path.
  const catalogCategoryKey = catalogSource === 'huggingface' ? activeCategory : 'client-filtered';
  useEffect(() => {
    const t = setTimeout(() => loadCatalog(selected, query, catalogSource, activeCategory), catalogSource === 'huggingface' ? 450 : 250);
    return () => clearTimeout(t);
    // `activeCategory` is intentionally absent: `catalogCategoryKey` IS it
    // whenever the source consumes it, so the effect re-runs (with a fresh
    // closure) exactly when the category matters. On the curated source the
    // closure can hold a stale category, which is harmless because that branch
    // of loadCatalog never reads the argument.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, query, catalogSource, catalogCategoryKey, loadCatalog]);

  useEffect(() => {
    const handleProgress = (data) => {
      // `localLlm:progress` is a shared channel. Measurement frames (`assessment`,
      // `assessment-sweep`) belong to the Performance tab and say nothing about
      // what is installed here — and an overnight sweep emits a `complete` frame
      // per model, so answering them would reload the status AND re-query the
      // Hugging Face catalog once per measured model, all night. This tab owns
      // the unscoped install/migrate/upgrade frames only.
      if (data?.scope === 'assessment' || data?.scope === 'assessment-sweep') return;
      clearTimeout(progressTimer.current);
      setProgressMsg(data.message || '');
      if (data.event === 'complete') {
        progressTimer.current = setTimeout(() => setProgressMsg(''), 3000);
        loadStatus();
        loadCatalog(selected, query, catalogSource, activeCategory);
      }
      if (data.event === 'error') {
        progressTimer.current = setTimeout(() => setProgressMsg(''), 5000);
      }
    };
    socket.on('localLlm:progress', handleProgress);
    return () => {
      socket.off('localLlm:progress', handleProgress);
      clearTimeout(progressTimer.current);
    };
  }, [loadStatus, loadCatalog, selected, query, catalogSource, activeCategory]);

  const runAction = useCallback((key, fn, successMsg, options = {}) => {
    const { onError, clearConfirm = true, ollamaService = false } = options;
    if (clearConfirm) setConfirmAction(null);
    setActionInProgress(key);
    return fn()
      .then((result) => {
        if (successMsg) toast.success(typeof successMsg === 'function' ? successMsg(result) : successMsg);
        // Optimistic repaint for the Ollama service controls only. Every runtime
        // start/stop result carries `running` — llama-server's and MTPLX's too —
        // so the CALLER declares this, rather than it being inferred from the
        // response shape; otherwise stopping MTPLX would paint Ollama as stopped
        // until the refetch lands.
        if (ollamaService && typeof result?.running === 'boolean') {
          setStatus((prev) => prev ? ({
            ...prev,
            ollama: {
              ...prev.ollama,
              installed: true,
              available: result.running
            }
          }) : prev);
        }
        loadStatus();
        loadCatalog(selected, query, catalogSource, activeCategory);
        return result;
      })
      .catch((err) => {
        // Caller-handled errors (e.g. OLLAMA_OUTDATED → offer to upgrade) ask us
        // to skip the default toast and run their own handler instead. The error
        // toast from apiCore has already fired unless the caller passed {silent}
        // through fn — onError just gets to consume the structured code/context.
        if (typeof onError === 'function') onError(err);
      })
      .finally(() => setActionInProgress(null));
  }, [loadStatus, loadCatalog, selected, query, catalogSource, activeCategory]);

  const busy = actionInProgress != null;

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
  const installRuntimeBackend = (backend) => runAction(
    `runtime-install-${backend}`,
    () => installLocalLlmBackend(backend),
    (r) => r?.note ? `Installed ${labelFor(backend)} — ${r.note}` : `Installed ${labelFor(backend)}`
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
  // MTPLX has no Start action: the first PortOS request routed to it starts it.
  // What the card saves is the launch line that on-demand start will replay.
  const saveMtplxLaunch = (launch) => runAction(
    'runtime-save-mtplx-launch',
    () => patchSettingsSlice('localLlm.mtplx', { launch }),
    'Saved — MTPLX will start on these options when a request needs it'
  ).then(loadMtplxStatus);

  // The idle window is a plain settings write for both daemons; only what
  // happens when it elapses differs (llama.cpp unloads in place on its next
  // start, MTPLX is stopped and lazily restarted).
  const saveIdleWindow = (runtime, minutes) => runAction(
    `runtime-idle-${runtime}`,
    () => patchSettingsSlice(`localLlm.${runtime}`, { idleMinutes: minutes }),
    minutes === 0
      ? `${runtime === 'llama' ? 'llama.cpp' : 'MTPLX'} will stay loaded while idle`
      : `${runtime === 'llama' ? 'llama.cpp' : 'MTPLX'} releases its model after ${minutes} idle minute${minutes === 1 ? '' : 's'}`
  ).then(runtime === 'llama' ? loadLlamaStatus : loadMtplxStatus);
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
  const mtplxPull = (model) => runAction(
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
  const mtplxRemove = (model) => runAction(
    `mtplx-remove-${model}`,
    () => removeMtplxModel(model),
    (r) => `${r?.model || model} removed${r?.bytesFreed ? ` — ${formatBytes(r.bytesFreed)} freed` : ''}`,
  ).then(loadMtplxStatus);
  const saveRuntimeStartup = () => runAction(
    'runtime-save-startup',
    () => saveRuntimeStartupList(),
    'Saved — the PM2 processes running now will come back after a reboot'
  ).then(() => { loadLlamaStatus(); loadMtplxStatus(); });
  const scrollTo = (ref) => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const selectedData = status?.[selected];
  const selectedOllamaStartupAction = selectedData?.service?.supported ? 'enable' : 'start';
  const selectedOllamaStartupLabel = selectedData?.service?.supported ? 'Run at Startup' : 'Start Ollama';
  const installedModels = selectedData?.models || [];
  const catalogCategories = useMemo(() => {
    const counts = new Map();
    for (const model of catalog) {
      for (const category of recommendationCategoriesFor(model)) {
        counts.set(category, (counts.get(category) || 0) + 1);
      }
    }
    // Hugging Face is searched per-category server-side, so a default GGUF query
    // never surfaces audio results — expose the full category set as filter
    // buttons (count shown only when known) so the user can navigate to
    // categories like Audio & Music. Curated counts include every lane a model
    // is recommended for; the unfiltered groups below still use one primary
    // lane per model, so broad models never duplicate in All.
    const ids = catalogSource === 'huggingface'
      ? CATEGORY_ORDER
      : CATEGORY_ORDER.filter((id) => counts.has(id));
    return ids.map((id) => ({ id, label: categoryLabel(id), count: counts.has(id) ? counts.get(id) : null }));
  }, [catalog, catalogSource]);
  const visibleCatalogGroups = useMemo(() => {
    const filterCategory = catalogSource === 'huggingface' ? 'all' : activeCategory;
    const categoryIds = filterCategory === 'all'
      ? CATEGORY_ORDER.filter((category) => catalog.some((model) => primaryCategoryFor(model) === category))
      : [filterCategory];
    return categoryIds
      .map((category) => ({
        category,
        label: categoryLabel(category),
        // A featured recommendation leads every relevant lane, including the
        // broad All view, instead of being buried by the catalog's source order.
        models: catalog
          .filter((model) => (
            filterCategory === 'all'
              ? primaryCategoryFor(model) === category
              : isRecommendedForCategory(model, category)
          ))
          .sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)))
      }))
      .filter((group) => group.models.length > 0);
  }, [activeCategory, catalog, catalogCategories, catalogSource]);

  // Active auto-upgrade flow (Ollama outdated → 412 on pull). Stays set while we
  // download / install / relaunch so the warning banner can show live status.
  // `{ modelId, phase: 'upgrading' | 'retrying' | 'failed', error? }`.
  const [upgradeFlow, setUpgradeFlow] = useState(null);

  // LM Studio's REST fallback returns { pending: true } — the download was only
  // queued, not finished — so don't claim "installed" in that case. Install is
  // silent so an OLLAMA_OUTDATED failure can take over the UI with the upgrade
  // banner instead of stacking a useless toast with the auto-upgrade flow.
  const install = (modelId, { force = false } = {}) => runAction(
    `install-${modelId}`,
    () => installLocalLlmModel(selected, modelId, { silent: true, force }),
    (r) => r?.pending ? `${modelId} download started` : `${modelId} ${force ? 'redownloaded' : 'installed'}`,
    {
      onError: (err) => {
        if (err?.code === 'OLLAMA_OUTDATED' && selected === 'ollama') {
          // Don't wait for a click — just upgrade. The user already said "install
          // this model"; needing a newer Ollama to do it is an implementation
          // detail, not a separate decision.
          upgradeOllamaAndRetry(modelId);
        } else if (err?.code === 'SHARDED_GGUF') {
          // Ollama can't pull a multi-part GGUF (#5245). The catalog disables
          // Install for known-sharded quants, but a pull-by-name still lands here —
          // explain the fix rather than echoing Ollama's raw 400.
          toast.error('Ollama can’t install sharded (multi-part) GGUFs. Pick a smaller single-file quant, or install this build on LM Studio.');
        } else {
          // Any other failure: restore the default toast we suppressed.
          toast.error(err?.message || 'Install failed');
        }
      },
      clearConfirm: false
    }
  );
  // Audio/music models don't run on Ollama/LM Studio — they install into the
  // shared audio-model registry (server/services/audioModels.js) via the Music
  // studio's streaming HF-download endpoint, so the Music studio picks them up.
  // The download streams SSE frames; surface progress in the same banner as the
  // socket-driven install progress, and treat an `error` frame as failure.
  const installAudio = (model) => {
    let failed = false;
    return runAction(
      `install-${model.id}`,
      async () => {
        await installAudioModel(
          { engine: model.engine, repo: model.repository, name: model.name },
          (ev) => {
            if (ev?.type === 'stage') setProgressMsg(ev.stage || '');
            else if (ev?.type === 'progress') setProgressMsg(`${ev.file || 'downloading'} — ${Math.round((ev.progress || 0) * 100)}%`);
            else if (ev?.type === 'error') { failed = true; toast.error(ev.message || 'Download failed'); }
          },
        );
        // installAudioModel resolves even after an error frame (it only throws on
        // a non-OK response) — re-throw so runAction skips the success toast.
        if (failed) throw Object.assign(new Error('audio install failed'), { handled: true });
      },
      `${model.name} installed — available in the Music studio`,
      { onError: (err) => { if (!err?.handled) toast.error(err?.message || 'Install failed'); }, clearConfirm: false },
    ).finally(() => setProgressMsg(''));
  };
  const remove = (modelId) => runAction(`delete-${modelId}`, () => deleteLocalLlmModel(selected, modelId), `${modelId} deleted`)
    .then((result) => {
      // Drop the just-deleted model from any pending comparison (runAction
      // resolves undefined on failure, so only prune on a real success) — else
      // openCompare ships a dead modelId the playground would error on.
      if (!result) return;
      const key = localLlmTargetKey({ backend: selected, modelId });
      setCompareTargets((prev) => prev.filter((t) => localLlmTargetKey(t) !== key));
    });
  const toggleCompareTarget = (backend, modelId) => {
    const key = localLlmTargetKey({ backend, modelId });
    setCompareTargets((prev) => {
      if (prev.some((t) => localLlmTargetKey(t) === key)) {
        return prev.filter((t) => localLlmTargetKey(t) !== key);
      }
      if (prev.length >= 6) {
        toast.error('Compare up to 6 models at once');
        return prev;
      }
      return [...prev, { backend, modelId }];
    });
  };
  const openCompare = () => {
    const params = new URLSearchParams();
    params.set('targets', JSON.stringify(compareTargets));
    params.set('mode', 'compare');
    navigate(`/local-llm/playground?${params.toString()}`);
  };

  // Upgrade Ollama in place (direct .app download on macOS; brew elsewhere) and
  // retry the original model install once Ollama is back online. `upgradeFlow`
  // drives the prominent warning banner so the user sees what's happening; the
  // socket-driven `progressMsg` provides per-step detail inside the same banner.
  const upgradeOllamaAndRetry = (modelId) => {
    setConfirmAction(null);
    setUpgradeFlow({ modelId, phase: 'upgrading' });
    runAction(
      'upgrade-ollama',
      () => upgradeLocalLlmBackend('ollama'),
      (r) => r?.note ? `Ollama upgraded — ${r.note}` : 'Ollama upgraded'
    ).then((r) => {
      if (r?.success && modelId) {
        setUpgradeFlow({ modelId, phase: 'retrying' });
        install(modelId);
        // install() either succeeds (its own success toast + status reload covers
        // it) or re-enters the OLLAMA_OUTDATED branch above and resets the flow.
        // Clear after a beat so the banner doesn't linger past the retry kickoff.
        setTimeout(() => setUpgradeFlow((cur) => (cur?.phase === 'retrying' ? null : cur)), 1500);
      } else if (!r?.success) {
        setUpgradeFlow({ modelId, phase: 'failed', error: r?.error });
      }
    }).catch((err) => {
      setUpgradeFlow({ modelId, phase: 'failed', error: err?.message });
    });
  };

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
  const llamaStartBlockedReason = llamaModelMissing
    ? 'Enter a Target Base Model path to enable Start'
    : baseWeightMissing
      ? 'Download the base model to enable Start'
      : draftWeightMissing
        ? 'Download the drafter, or clear the field to run without it'
        : '';

  const handleDownloadSpecModel = async (role) => {
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
    <div className="space-y-4">
      {/* One start/stop/install surface for every local server PortOS can run */}
      <RuntimeServersCard
        status={status}
        llamaStatus={llamaStatus}
        mtplxStatus={mtplxStatus}
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
        onStopMtplx={runtimeStopMtplx}
        onSaveStartup={saveRuntimeStartup}
        onSaveIdleWindow={saveIdleWindow}
      />

      {/* Backends — model catalog, default marker, cross-backend import */}
      <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-gray-300">Local LLM Backends</h2>
          <button onClick={loadStatus} disabled={loading} className="p-1.5 text-gray-400 hover:text-white transition-colors" title="Refresh" aria-label="Refresh local LLM status">
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

            {upgradeFlow && (
              <div className="bg-port-warning/10 border-2 border-port-warning/60 rounded-lg p-4 space-y-2" role="alert">
                <div className="flex items-start gap-3">
                  <AlertTriangle size={20} className="text-port-warning mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0 space-y-1">
                    <p className="text-sm font-semibold text-port-warning">
                      {upgradeFlow.phase === 'failed' ? 'Ollama upgrade failed' : 'Upgrading Ollama'}
                    </p>
                    <p className="text-xs text-gray-300">
                      {upgradeFlow.phase === 'upgrading' && `${upgradeFlow.modelId} needs a newer Ollama than the one installed. Downloading the latest Ollama and replacing the installed app — this can take a minute.`}
                      {upgradeFlow.phase === 'retrying' && `Ollama is up to date — retrying the ${upgradeFlow.modelId} download now.`}
                      {upgradeFlow.phase === 'failed' && (upgradeFlow.error || 'See the server logs for details.')}
                    </p>
                    {progressMsg && upgradeFlow.phase !== 'failed' && (
                      <p className="text-xs text-port-warning/90 flex items-center gap-2 pt-1">
                        <BrailleSpinner /> {progressMsg}
                      </p>
                    )}
                    {upgradeFlow.phase === 'failed' && (
                      <p className="text-xs text-gray-400 pt-1">
                        You can also upgrade manually from <a href="https://ollama.com/download" target="_blank" rel="noopener noreferrer" className="text-port-accent hover:underline inline-flex items-center gap-1">ollama.com/download <ExternalLink size={10} /></a>.
                      </p>
                    )}
                  </div>
                  {upgradeFlow.phase === 'failed' && (
                    <button onClick={() => setUpgradeFlow(null)} className="text-xs text-gray-400 hover:text-white transition-colors" aria-label="Dismiss">
                      Dismiss
                    </button>
                  )}
                </div>
              </div>
            )}

            {progressMsg && !upgradeFlow && (
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

      {/* MTPLX — PM2-managed native-MTP runtime (Apple Silicon) */}
      <div ref={mtplxSectionRef}>
        <MtplxServerCard
          status={mtplxStatus}
          loading={loading}
          busy={busy}
          actionInProgress={actionInProgress}
          onRefresh={loadMtplxStatus}
          onSaveLaunch={saveMtplxLaunch}
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
              className="p-1 text-gray-400 hover:text-white transition-colors"
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
          Speculative decoding pairs a small drafter with your target model for 2–3× faster generation at identical output. You can launch and manage a local <code className="text-gray-300">llama-server</code> from PortOS and connect using the <strong className="text-white">OpenCode llama TUI</strong> provider. <strong className="text-white">DSpark</strong> (<code className="text-gray-300">draft-dspark</code>) works on a stock <code className="text-gray-300">brew install llama.cpp</code>; the DFlash 2 presets need a from-source build of an unmerged llama.cpp branch. No drafter GGUF to hand? The <code className="text-gray-300">ngram-*</code> spec types under Advanced options draft from the context window alone.
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
                Install via Homebrew or compile the DFlash 2-enabled branch from source.
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
              <pre className="text-[10px] text-gray-400 bg-port-bg border border-port-border/60 p-2.5 rounded max-h-40 overflow-y-auto font-mono whitespace-pre-wrap">
                {llamaStatus.recentLogs.join('\n')}
              </pre>
            )}
          </div>
        )}
      </div>

      {/* Models — backend picker + catalog/install + installed list */}
      <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-sm font-medium text-gray-300">Models</h2>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <div className="flex items-center gap-1.5">
              {['recommended', 'huggingface'].map((source) => (
                <button
                  key={source}
                  onClick={() => { setCatalogSource(source); setActiveCategory('all'); }}
                  className={`px-2.5 py-1 text-xs rounded transition-colors ${catalogSource === source ? 'bg-port-accent/20 text-port-accent' : 'bg-port-bg text-gray-400 hover:text-white'}`}
                >
                  {source === 'recommended' ? 'Recommended' : 'Hugging Face'}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              {BACKENDS.map((b) => (
                <button
                  key={b.id}
                  onClick={() => { setSelected(b.id); setActiveCategory('all'); }}
                  className={`px-2.5 py-1 text-xs rounded transition-colors ${selected === b.id ? 'bg-port-accent/20 text-port-accent' : 'bg-port-bg text-gray-400 hover:text-white'}`}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {selectedData && !selectedData.available && !selectedData.disabled && (
          <div className="flex items-center gap-2 flex-wrap text-xs text-port-warning">
            <span>
              {labelFor(selected)} isn't running — {selectedData.installed
                ? (selected === 'ollama' ? 'use the controls to start it or keep it running at login.' : 'launch the app and enable the local server.')
                : 'install it first (Models → LLMs prompts at setup, or run `npm run setup:llm`).'}
            </span>
            {selected === 'ollama' && selectedData.installed && selectedData.canControl && (
              <button
                onClick={() => runAction(
                  `ollama-service-${selectedOllamaStartupAction}-models`,
                  () => controlOllamaService(selectedOllamaStartupAction),
                  selectedOllamaStartupAction === 'enable' ? 'Ollama will run at login' : 'Ollama is running',
                  { ollamaService: true }
                )}
                disabled={busy}
                className={`${btnClass} bg-port-accent/20 hover:bg-port-accent/30 text-port-accent`}
              >
                {actionInProgress === `ollama-service-${selectedOllamaStartupAction}-models` ? <BrailleSpinner /> : <Play size={12} />}
                {selectedOllamaStartupLabel}
              </button>
            )}
          </div>
        )}
        {selectedData?.available && selectedData?.modelsError && (
          <p className="text-xs text-port-warning">
            Couldn't list {labelFor(selected)} models (showing what's available): {selectedData.modelsError}
          </p>
        )}

        {/* Free-text install + search */}
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="flex-1 flex items-center gap-2 bg-port-bg border border-port-border rounded-lg px-3 focus-within:border-port-accent">
            <Search size={14} className="text-gray-500" />
            <FormField label={`Search the ${labelFor(selected)} model catalog`} labelClassName="sr-only" className="flex-1">
            <input
              id="llm-catalog-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={catalogSource === 'huggingface' ? (activeCategory === 'audio' ? 'Search Hugging Face audio models…' : 'Search Hugging Face GGUF models…') : `Search the ${labelFor(selected)} catalog…`}
              className="w-full flex-1 bg-transparent py-2 text-sm text-white placeholder-gray-600 focus:outline-none"
            />
            </FormField>
          </div>
          <div className="flex items-center gap-2">
            <FormField label={`Install a ${labelFor(selected)} model by id`} labelClassName="sr-only" className="flex-1 sm:w-56">
            <input
              id="llm-manual-install"
              value={manualId}
              onChange={(e) => setManualId(e.target.value)}
              placeholder={selected === 'ollama' ? 'pull by name e.g. llama3.2' : 'publisher/Model-GGUF'}
              className="w-full flex-1 sm:w-56 bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-port-accent"
            />
            </FormField>
            <button
              onClick={() => { const id = manualId.trim(); if (id) { install(id); setManualId(''); } }}
              disabled={busy || !manualId.trim()}
              className="flex items-center gap-1.5 px-3 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent text-sm font-medium rounded-lg disabled:opacity-50"
            >
              <Plus size={14} /> Install
            </button>
          </div>
        </div>

        {catalogCategories.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setActiveCategory('all')}
              className={`px-2.5 py-1 text-xs rounded transition-colors ${activeCategory === 'all' ? 'bg-port-accent/20 text-port-accent' : 'bg-port-bg text-gray-400 hover:text-white'}`}
            >
              All ({catalog.length})
            </button>
            {catalogCategories.map((category) => (
              <button
                key={category.id}
                onClick={() => setActiveCategory(category.id)}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${activeCategory === category.id ? 'bg-port-accent/20 text-port-accent' : 'bg-port-bg text-gray-400 hover:text-white'}`}
              >
                {category.label}{category.count != null ? ` (${category.count})` : ''}
              </button>
            ))}
          </div>
        )}

        {catalogLoading && (
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <BrailleSpinner />
            {catalogSource === 'huggingface' ? 'Searching Hugging Face' : 'Loading recommendations'}
          </div>
        )}
        {catalogError && (
          <p className="text-xs text-port-warning">{catalogError}</p>
        )}
        {Number.isFinite(systemMemoryGb) && catalog.some((m) => Array.isArray(m.variants) && m.variants.length > 1) && (
          <p className="text-[11px] text-gray-500">
            This machine has {systemMemoryGb} GB of memory — the default quant is the highest-fidelity build that fits. Use the Quant menu on a result to choose a smaller or larger one.
          </p>
        )}

        {/* Catalog cards */}
        <div className="space-y-4">
          {visibleCatalogGroups.map((group) => (
            <div key={group.category} className="space-y-2">
              {activeCategory === 'all' && (
                <h3 className="text-xs font-medium text-gray-400">{group.label}</h3>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {group.models.map((m) => {
                  const isHf = m.source === 'huggingface';
                  const isAudio = m.category === 'audio';
                  const repositoryUrl = m.repository ? `https://huggingface.co/${m.repository}` : null;
                  // Multi-quant repos let the user trade their RAM for fidelity.
                  // `chosenId` is the selected variant's install id (defaulting to
                  // the server's RAM-aware pick `m.id`); the card's size/RAM/fit
                  // reflect that choice.
                  const variants = (!isAudio && Array.isArray(m.variants)) ? m.variants : [];
                  const hasVariantPicker = variants.length > 1;
                  // The server marks the RAM-aware default with `recommended`, so it
                  // wins as the default selection. (For live HF results it equals
                  // `m.id`; for curated entries `m.id` is the stable catalog id, which
                  // may itself be a non-default variant — so `recommended` must take
                  // precedence over `m.id`, or the RAM-aware pick never applies.) Fall
                  // back to `m.id`-as-variant, then `m.id`, so the controlled <select>
                  // always has a matching option.
                  const idMatchesVariant = variants.some((v) => v.installId === m.id);
                  const recommendedId = variants.find((v) => v.recommended)?.installId;
                  // Only honor a saved selection if it still matches a current variant —
                  // variant install ids are backend-specific (`repo@Q…` vs `hf.co/repo:Q…`),
                  // so a selection made before a backend switch must not leak through as a
                  // stale id (which would null out chosenVariant and install the wrong id).
                  const savedSelection = selectedVariants[m.key];
                  const validSelection = variants.some((v) => v.installId === savedSelection) ? savedSelection : null;
                  const chosenId = validSelection || recommendedId || (idMatchesVariant ? m.id : null) || m.id;
                  const chosenVariant = variants.find((v) => v.installId === chosenId) || null;
                  // Installed state is per-quant (Ollama tracks each separately),
                  // so gate Install on the SELECTED variant, not the result default.
                  const chosenInstalled = chosenVariant ? chosenVariant.installed : m.installed;
                  // A sharded quant can't be pulled by the active backend (Ollama
                  // #5245) — disable Install with the server's reason rather than
                  // letting the user hit the raw 400. (The server only sets
                  // `unsupportedReason` when the variant is unsupported.)
                  const chosenUnsupported = chosenVariant?.unsupportedReason ?? null;
                  const size = chosenVariant?.size || m.size;
                  const sizeBytes = chosenVariant?.sizeBytes ?? m.sizeBytes;
                  // Curated entries fetched without `?variants=1` carry no
                  // variant list at all — the server puts a measured fit on the
                  // model itself there, so fall back to it rather than dropping
                  // the only evidence that exists.
                  const fitEntry = chosenVariant || m;
                  const fit = fitEntry?.fit;
                  const fitMeta = fit ? FIT_META[fit] : null;
                  const fitMeasured = fitEntry?.fitSource === 'measured';
                  const ram = recommendedRamGb(sizeBytes, size);
                  const ctxLabel = formatContextLength(m.contextLength);
                  const createdMs = new Date(m.createdAt).getTime();
                  const updatedMs = new Date(m.updatedAt).getTime();
                  return (
                  <div key={m.key || m.id} className={`flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-3 rounded-lg p-3 ${m.featured ? 'bg-port-accent/5 border border-port-accent/60 ring-1 ring-port-accent/20' : 'bg-port-bg border border-port-border'}`}>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-white break-words">
                        {m.name} <span className="text-xs text-gray-500">· {m.params}</span>
                        {m.featured && (
                          <span
                            title={m.featured.description || 'Flagship local recommendation'}
                            className="ml-1.5 align-middle inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border border-port-accent/60 bg-port-accent/15 text-port-accent"
                          >
                            <Star size={9} className="fill-current" /> {m.featured.label || 'Featured'}
                          </span>
                        )}
                        {FORMAT_META[m.format] && (
                          <span
                            title={FORMAT_META[m.format].title}
                            className={`ml-1.5 align-middle text-[10px] px-1 py-0.5 rounded border ${FORMAT_META[m.format].cls}`}
                          >
                            {FORMAT_META[m.format].label}
                          </span>
                        )}
                        {isAgentRecommendedModel(m.capabilities) && (
                          <span
                            title="Recommended for agent & CoS tasks — has native tool calling plus coding strength, so it can actually drive multi-step agent work (unlike chat-only or tool-less models)."
                            className="ml-1.5 align-middle inline-flex items-center gap-0.5 text-[10px] px-1 py-0.5 rounded border border-port-accent/50 text-port-accent"
                          >
                            <Star size={9} className="fill-current" /> Agents
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 break-all">{chosenId}</div>
                      <div className="text-xs text-gray-500 mt-0.5">{m.description}</div>
                      {m.featured?.description && (
                        <div className="text-xs text-port-accent mt-1">{m.featured.description}</div>
                      )}
                      {m.note && <div className="text-[11px] text-port-warning/90 mt-0.5">{m.note}</div>}
                      {hasVariantPicker && (
                        <FormField label="Quant" labelClassName="text-[11px] text-gray-500" className="flex items-center gap-1.5 flex-wrap mt-1">
                          <select
                            id={`quant-${m.key}`}
                            value={chosenId}
                            onChange={(e) => setSelectedVariants((prev) => ({ ...prev, [m.key]: e.target.value }))}
                            disabled={busy}
                            className="text-[11px] bg-port-card border border-port-border rounded px-1.5 py-0.5 text-gray-300 max-w-[16rem]"
                            title="Pick a quantization — higher quants are larger but higher fidelity"
                          >
                            {variants.map((v) => (
                              <option key={v.installId} value={v.installId}>
                                {v.quant}{v.size ? ` · ${v.size}` : ''}{v.installed ? ' · installed' : ''}{v.recommended ? ' · recommended' : ''}{v.fit === 'too-large' ? ' · exceeds RAM' : ''}{v.fit === 'incompatible' ? ' · backend refused it' : ''}{v.fitSource === 'measured' ? ' · measured' : ''}{v.unsupported === 'sharded' ? ' · sharded (not on Ollama)' : ''}
                              </option>
                            ))}
                          </select>
                          {fitMeta && (
                            <span className={`text-[11px] ${fitMeta.cls}`} title={fitTitle(fitEntry?.fitSource, fitEntry)}>
                              {fitMeta.label}{fitMeasured ? ' (measured)' : ''}
                            </span>
                          )}
                        </FormField>
                      )}
                      <div className="flex items-center gap-1.5 flex-wrap text-[11px] text-gray-600 mt-1">
                        <span className="text-gray-500">{categoryLabel(m.category)}</span>
                        <span>{size}</span>
                        {/* Single-variant cards (e.g. MLX) have no quant picker, so
                            surface the RAM-fit hint here instead of in the picker row. */}
                        {fitMeta && !hasVariantPicker && (
                          <span className={fitMeta.cls} title={fitTitle(fitEntry?.fitSource, fitEntry)}>
                            {fitMeta.label}{fitMeasured ? ' (measured)' : ''}
                          </span>
                        )}
                        {ctxLabel && (
                          <span title="Native context window (max tokens)">{ctxLabel}</span>
                        )}
                        {ram && (
                          <span title="Approx RAM/VRAM to run this model — weights + ~20% overhead">
                            ~{ram} GB RAM
                          </span>
                        )}
                        {isHf && <span>{m.downloads?.toLocaleString?.() || 0} downloads</span>}
                        {isHf && Number.isFinite(createdMs) && (
                          <span
                            title={`Published ${formatDateNumeric(createdMs)}${Number.isFinite(updatedMs) ? ` · updated ${timeAgo(m.updatedAt)}` : ''}`}
                          >
                            published {formatAgeDays(m.createdAt)}
                          </span>
                        )}
                        {isHf && m.license && <span>{m.license}</span>}
                        <CapabilityBadges capabilities={m.capabilities} />
                      </div>
                    </div>
                    {/* Mobile: actions sit on their own row under the details so
                        the name/id column isn't squeezed into a narrow column.
                        Desktop keeps them stacked at the card's right edge. */}
                    <div className="flex flex-row sm:flex-col items-center sm:items-end gap-2 sm:gap-1 shrink-0 justify-end flex-wrap">
                      {chosenInstalled ? (
                        <>
                          <span className="text-xs px-2 py-1 text-port-success">Installed</span>
                          {!isAudio && (selected !== 'lmstudio' || /@/.test(chosenId || '')) && (
                            <button
                              onClick={() => install(chosenId, { force: true })}
                              disabled={busy}
                              title="Pull this build again. Updated GGUF files keep the same name, so an existing install will not refresh until you redownload."
                              className="px-2.5 py-1 text-xs bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                            >
                              {actionInProgress === `install-${chosenId}` ? <BrailleSpinner /> : <RefreshCw size={12} />}
                              Redownload
                            </button>
                          )}
                        </>
                      ) : m.installable === false ? (
                        // Audio models with no PortOS runtime (or a fixed-checkpoint
                        // engine like ACE-Step) are discovery-only — "Visit" below.
                        null
                      ) : (
                        <button
                          onClick={() => (isAudio ? installAudio(m) : install(chosenId))}
                          disabled={busy || !!chosenUnsupported}
                          title={chosenUnsupported || undefined}
                          className="px-2.5 py-1 text-xs bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                        >
                          {actionInProgress === `install-${chosenId}` ? <BrailleSpinner /> : <Download size={12} />}
                          Install
                        </button>
                      )}
                      {chosenUnsupported && !chosenInstalled && (
                        <span className="text-[11px] text-port-warning text-right max-w-[12rem] leading-snug" title={chosenUnsupported}>
                          Sharded — use LM Studio or a smaller quant
                        </span>
                      )}
                      {repositoryUrl && (
                        <a
                          href={repositoryUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={m.gated ? 'Open Hugging Face to accept repository terms' : 'Open the model page on Hugging Face'}
                          className="px-2.5 py-1 text-xs bg-port-border/60 hover:bg-port-border text-gray-300 rounded flex items-center gap-1"
                        >
                          <ExternalLink size={12} />
                          {m.gated ? 'Accept terms' : 'Visit'}
                        </a>
                      )}
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>
          ))}
          {catalog.length === 0 && (
            <p className="text-xs text-gray-500">No catalog matches{query ? ` for "${query}"` : ''}.</p>
          )}
          {catalog.length > 0 && visibleCatalogGroups.length === 0 && (
            <p className="text-xs text-gray-500">No {categoryLabel(activeCategory)} matches{query ? ` for "${query}"` : ''}.</p>
          )}
        </div>

        <LocalLlmInstalledModels
          actionInProgress={actionInProgress}
          backend={selected}
          busy={busy}
          cancelDelete={cancelDelete}
          compareTargets={compareTargets}
          confirmDelete={confirmDelete}
          install={install}
          isConfirmingDelete={isConfirmingDelete}
          models={installedModels}
          onCompare={openCompare}
          onToggleCompare={toggleCompareTarget}
          remove={remove}
          requestDelete={requestDelete}
        />
      </div>
    </div>
  );
}

export default LocalLlmTab;
