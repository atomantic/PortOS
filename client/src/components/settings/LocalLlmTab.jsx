import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Cpu, Box, ArrowRightLeft, Download, Trash2, RefreshCw, Search, Plus, ExternalLink, Star, Link2, Copy, Play, Square, Power, PowerOff, Eye, Wrench, Brain, Code2, MessageSquare, Boxes, AlertTriangle, FlaskConical, Music, ArrowUpCircle } from 'lucide-react';
import toast from '../ui/Toast';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import BrailleSpinner from '../BrailleSpinner';
import { formatBytes, formatContextLength, timeAgo, recommendedRamGb } from '../../utils/formatters';
import { localLlmTargetKey } from '../../lib/localLlmTargetKey';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';
import {
  getLocalLlmStatus, getLocalLlmCatalog, getLocalLlmHuggingFaceSearch, installLocalLlmModel,
  deleteLocalLlmModel, switchLocalLlmBackend, migrateLocalLlmBackend, installLocalLlmBackend, upgradeLocalLlmBackend, controlOllamaService,
  installAudioModel
} from '../../services/api';
import socket from '../../services/socket';
import MemoryManagement from './MemoryManagement.jsx';

const BACKENDS = [
  { id: 'ollama', label: 'Ollama', icon: Cpu },
  { id: 'lmstudio', label: 'LM Studio', icon: Box }
];
const labelFor = (id) => BACKENDS.find((b) => b.id === id)?.label || id;

const btnClass = 'flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded transition-colors disabled:opacity-50';

const CATEGORY_LABELS = {
  chat: 'Chat',
  reasoning: 'Reasoning',
  coding: 'Coding',
  vision: 'Image Analysis',
  audio: 'Audio & Music',
  embedding: 'Text Embeddings',
  lightweight: 'Small & Fast',
  multilingual: 'Multilingual'
};
const CATEGORY_ORDER = ['reasoning', 'coding', 'vision', 'audio', 'embedding', 'chat', 'lightweight', 'multilingual'];
const categoryLabel = (id) => CATEGORY_LABELS[id] || id;

// Render model capabilities as colored icons (LM Studio style) instead of text.
// `cls` is the icon color; the bordered chip uses the same hue at low opacity.
const CAPABILITY_META = {
  chat: { Icon: MessageSquare, label: 'Chat', cls: 'text-gray-400 border-gray-500/50' },
  code: { Icon: Code2, label: 'Code', cls: 'text-sky-400 border-sky-400/50' },
  reasoning: { Icon: Brain, label: 'Reasoning', cls: 'text-emerald-400 border-emerald-400/50' },
  vision: { Icon: Eye, label: 'Vision', cls: 'text-amber-400 border-amber-400/50' },
  embeddings: { Icon: Boxes, label: 'Embeddings', cls: 'text-violet-400 border-violet-400/50' },
  tools: { Icon: Wrench, label: 'Tool use', cls: 'text-blue-400 border-blue-400/50' },
  audio: { Icon: Music, label: 'Audio generation', cls: 'text-pink-400 border-pink-400/50' },
};

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
};

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

// Shared capability-icon row for both catalog/search-result cards and the
// installed-models list, so the two surfaces render the same badges the same way.
function CapabilityBadges({ capabilities }) {
  return (capabilities || []).map((capability) => {
    const meta = CAPABILITY_META[capability];
    if (!meta) {
      return <span key={capability} className="px-1.5 py-0.5 bg-port-border/60 rounded">{capability}</span>;
    }
    const Icon = meta.Icon;
    return (
      <span
        key={capability}
        title={meta.label}
        aria-label={meta.label}
        className={`inline-flex items-center justify-center w-5 h-5 rounded border ${meta.cls}`}
      >
        <Icon size={12} />
      </span>
    );
  });
}

function BackendCard({ backend, status, isDefault, busy, actionInProgress, runAction, setConfirmAction }) {
  const data = status?.[backend.id];
  const Icon = backend.icon;
  const other = backend.id === 'ollama' ? 'lmstudio' : 'ollama';
  const otherData = status?.[other];
  const statusLabel = data?.available ? 'Running' : data?.installed ? 'Installed (stopped)' : 'Not installed';
  const statusColor = data?.available ? 'bg-port-success' : data?.installed ? 'bg-port-warning' : 'bg-gray-600';
  const startupService = backend.id === 'ollama' ? data?.service : null;
  const runsAtStartup = Boolean(startupService?.runAtStartup);

  return (
    <div className="bg-port-bg border border-port-border rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Icon size={14} />
          {backend.label}
        </div>
        <div className="flex items-center gap-1.5">
          {isDefault && (
            <span
              className="text-xs px-1.5 py-0.5 bg-port-accent/20 text-port-accent rounded"
              title="PortOS routes local-LLM runs here by default. This is independent of whether the server is running (see the status dot)."
            >
              Default
            </span>
          )}
          <span className={`w-2 h-2 rounded-full ${statusColor}`} title={statusLabel} />
        </div>
      </div>

      <div className="text-sm text-white">{statusLabel}</div>
      <div className="text-xs text-gray-400">
        {data?.modelCount ?? 0} model{(data?.modelCount ?? 0) === 1 ? '' : 's'} installed
        {data?.version && <> · v{data.version}</>}
        {backend.id === 'ollama' && data?.updateAvailable && data?.latestVersion && (
          <span className="text-port-warning" title={`Ollama v${data.latestVersion} is available (you have v${data.version})`}>
            {' · '}v{data.latestVersion} available
          </span>
        )}
        {startupService?.supported && <> · {runsAtStartup ? 'runs at login' : 'startup off'}</>}
      </div>

      {!data?.installed && (
        <div className="flex flex-wrap gap-1.5 pt-1 border-t border-port-border/50">
          {data?.canAutoInstall ? (
            <button
              onClick={() => runAction(
                `install-backend-${backend.id}`,
                () => installLocalLlmBackend(backend.id),
                (r) => r?.note ? `Installed ${backend.label} — ${r.note}` : `Installed ${backend.label}`
              )}
              disabled={busy}
              className={`${btnClass} bg-port-accent/20 hover:bg-port-accent/30 text-port-accent`}
              title="Install via Homebrew (macOS) / official installer (Linux)"
            >
              {actionInProgress === `install-backend-${backend.id}` ? <BrailleSpinner /> : <Download size={12} />}
              Install {backend.label}
            </button>
          ) : (
            <a
              href={data?.downloadUrl}
              target="_blank"
              rel="noreferrer"
              className={`${btnClass} bg-port-border hover:bg-port-border/70 text-white no-underline`}
            >
              <ExternalLink size={12} />
              Get {backend.label}
            </a>
          )}
        </div>
      )}

      {data?.installed && (
        <div className="flex flex-wrap gap-1.5 pt-1 border-t border-port-border/50">
          {backend.id === 'ollama' && data?.canControl && (
            <button
              onClick={() => runAction(
                `ollama-service-${data.available ? 'stop' : 'start'}`,
                () => controlOllamaService(data.available ? 'stop' : 'start'),
                data.available ? 'Ollama stopped' : 'Ollama is running'
              )}
              disabled={busy}
              className={`${btnClass} ${data.available ? 'bg-port-warning/20 hover:bg-port-warning/30 text-port-warning' : 'bg-port-accent/20 hover:bg-port-accent/30 text-port-accent'}`}
              title={data.available ? 'Stop the local Ollama server' : 'Start the local Ollama server'}
            >
              {actionInProgress === `ollama-service-${data.available ? 'stop' : 'start'}`
                ? <BrailleSpinner />
                : data.available ? <Square size={12} /> : <Play size={12} />}
              {data.available ? 'Stop' : 'Start'} Ollama
            </button>
          )}
          {backend.id === 'ollama' && data?.updateAvailable && (
            data?.canUpgrade ? (
              <button
                onClick={() => runAction(
                  'upgrade-ollama',
                  () => upgradeLocalLlmBackend('ollama'),
                  (r) => r?.note ? `Ollama updated — ${r.note}` : `Ollama updated to v${data.latestVersion}`
                )}
                disabled={busy}
                className={`${btnClass} bg-port-success/20 hover:bg-port-success/30 text-port-success`}
                title={`Update Ollama from v${data.version} to v${data.latestVersion} in place (downloads the latest release and restarts it)`}
              >
                {actionInProgress === 'upgrade-ollama' ? <BrailleSpinner /> : <ArrowUpCircle size={12} />}
                Update to v{data.latestVersion}
              </button>
            ) : (
              <a
                href={data.downloadUrl}
                target="_blank"
                rel="noreferrer"
                className={`${btnClass} bg-port-warning/20 hover:bg-port-warning/30 text-port-warning no-underline`}
                title={`Ollama v${data.latestVersion} is available — automatic updates aren't supported on this platform`}
              >
                <ArrowUpCircle size={12} />
                Update available
              </a>
            )
          )}
          {backend.id === 'ollama' && startupService?.supported && (
            <button
              onClick={() => runAction(
                `ollama-service-${runsAtStartup ? 'disable' : 'enable'}`,
                () => controlOllamaService(runsAtStartup ? 'disable' : 'enable'),
                runsAtStartup ? 'Ollama background service disabled' : 'Ollama will run at login'
              )}
              disabled={busy}
              className={`${btnClass} ${runsAtStartup ? 'bg-port-warning/20 hover:bg-port-warning/30 text-port-warning' : 'bg-port-accent/20 hover:bg-port-accent/30 text-port-accent'}`}
              title={runsAtStartup ? 'Stop the Homebrew service and remove the launch-at-login registration' : 'Start Ollama with Homebrew services so it runs in the background at login'}
            >
              {actionInProgress === `ollama-service-${runsAtStartup ? 'disable' : 'enable'}`
                ? <BrailleSpinner />
                : runsAtStartup ? <PowerOff size={12} /> : <Power size={12} />}
              {runsAtStartup ? 'Disable Startup' : 'Run at Startup'}
            </button>
          )}
          {!isDefault && (
            <button
              onClick={() => runAction(`switch-${backend.id}`, () => switchLocalLlmBackend(backend.id), `${backend.label} is now the default backend`)}
              disabled={busy}
              className={`${btnClass} bg-port-border hover:bg-port-border/70 text-white`}
              title="Route PortOS local-LLM runs here by default — doesn't move any models or stop the other backend"
            >
              {actionInProgress === `switch-${backend.id}` ? <BrailleSpinner /> : <Star size={12} />}
              Set as Default
            </button>
          )}
          {otherData?.available && (
            <button
              onClick={() => setConfirmAction({
                type: 'migrate',
                to: backend.id,
                from: other,
                label: `Bring ${labelFor(other)}'s models onto ${backend.label}?`,
                detail: `Provisions the ${otherData.modelCount ?? 0} model${(otherData.modelCount ?? 0) === 1 ? '' : 's'} on ${labelFor(other)} onto ${backend.label} — your default backend is unchanged. Link shares each GGUF on disk (no extra space, falls back to a copy across filesystems); Copy makes an independent duplicate. Portable single-file GGUF models move with no re-download; MLX-format, sharded, or multimodal models that can't be shared/copied are re-pulled.`
              })}
              disabled={busy}
              className={`${btnClass} bg-port-accent/20 hover:bg-port-accent/30 text-port-accent`}
              title={`Copy or link the models installed on ${labelFor(other)} onto ${backend.label}`}
            >
              <ArrowRightLeft size={12} />
              Import from {labelFor(other)}
            </button>
          )}
        </div>
      )}
    </div>
  );
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

  const loadStatus = useCallback(() => {
    const requestId = ++statusRequestId.current;
    setLoading(true);
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
  }, []);

  const loadCatalog = useCallback((backend, q, source = catalogSource, category = activeCategory) => {
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
  }, [activeCategory, catalogSource]);

  useEffect(() => { loadStatus(); }, [loadStatus]);
  // Debounce so typing in the search box doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => loadCatalog(selected, query, catalogSource, activeCategory), catalogSource === 'huggingface' ? 450 : 250);
    return () => clearTimeout(t);
  }, [selected, query, catalogSource, activeCategory, loadCatalog]);

  useEffect(() => {
    const handleProgress = (data) => {
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
    const { onError, clearConfirm = true } = options;
    if (clearConfirm) setConfirmAction(null);
    setActionInProgress(key);
    return fn()
      .then((result) => {
        if (successMsg) toast.success(typeof successMsg === 'function' ? successMsg(result) : successMsg);
        if (typeof result?.running === 'boolean') {
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
  const selectedData = status?.[selected];
  const selectedOllamaStartupAction = selectedData?.service?.supported ? 'enable' : 'start';
  const selectedOllamaStartupLabel = selectedData?.service?.supported ? 'Run at Startup' : 'Start Ollama';
  const installedModels = selectedData?.models || [];
  const compareTargetKeys = useMemo(() => new Set(compareTargets.map(localLlmTargetKey)), [compareTargets]);
  const catalogCategories = useMemo(() => {
    const counts = new Map();
    for (const model of catalog) counts.set(model.category || 'chat', (counts.get(model.category || 'chat') || 0) + 1);
    // Hugging Face is searched per-category server-side, so a default GGUF query
    // never surfaces audio results — expose the full category set as filter
    // buttons (count shown only when known) so the user can navigate to
    // categories like Audio & Music. The curated local catalog stays
    // counts-driven (its categories are fixed and fully present).
    const ids = catalogSource === 'huggingface'
      ? CATEGORY_ORDER
      : CATEGORY_ORDER.filter((id) => counts.has(id));
    return ids.map((id) => ({ id, label: categoryLabel(id), count: counts.has(id) ? counts.get(id) : null }));
  }, [catalog, catalogSource]);
  const visibleCatalogGroups = useMemo(() => {
    const filterCategory = catalogSource === 'huggingface' ? 'all' : activeCategory;
    const categoryIds = filterCategory === 'all'
      ? catalogCategories.map((c) => c.id)
      : [filterCategory];
    return categoryIds
      .map((category) => ({
        category,
        label: categoryLabel(category),
        models: catalog.filter((model) => (model.category || 'chat') === category)
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
  const install = (modelId) => runAction(
    `install-${modelId}`,
    () => installLocalLlmModel(selected, modelId, { silent: true }),
    (r) => r?.pending ? `${modelId} download started` : `${modelId} installed`,
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

  return (
    <div className="space-y-4">
      <MemoryManagement />
      {/* Backends — status + switch/migrate */}
      <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-gray-300">Local LLM Backends</h2>
          <button onClick={loadStatus} disabled={loading} className="p-1.5 text-gray-400 hover:text-white transition-colors" title="Refresh" aria-label="Refresh local LLM status">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <p className="text-xs text-gray-500">
          Both backends can be installed and running at the same time — <span className="text-gray-400">Default</span> just sets which one PortOS routes local-LLM runs to. Use <span className="text-gray-400">Import from…</span> to copy or link models between them without re-downloading.
        </p>

        {loading && !status ? (
          <BrailleSpinner text="Loading local LLM status" />
        ) : status ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {BACKENDS.map((b) => (
                <BackendCard
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

        {selectedData && !selectedData.available && (
          <div className="flex items-center gap-2 flex-wrap text-xs text-port-warning">
            <span>
              {labelFor(selected)} isn't running — {selectedData.installed
                ? (selected === 'ollama' ? 'use the controls to start it or keep it running at login.' : 'launch the app and enable the local server.')
                : 'install it first (Settings → Local LLMs prompts at setup, or run `npm run setup:llm`).'}
            </span>
            {selected === 'ollama' && selectedData.installed && selectedData.canControl && (
              <button
                onClick={() => runAction(
                  `ollama-service-${selectedOllamaStartupAction}-models`,
                  () => controlOllamaService(selectedOllamaStartupAction),
                  selectedOllamaStartupAction === 'enable' ? 'Ollama will run at login' : 'Ollama is running'
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
            <label htmlFor="llm-catalog-search" className="sr-only">{`Search the ${labelFor(selected)} model catalog`}</label>
            <input
              id="llm-catalog-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={catalogSource === 'huggingface' ? (activeCategory === 'audio' ? 'Search Hugging Face audio models…' : 'Search Hugging Face GGUF models…') : `Search the ${labelFor(selected)} catalog…`}
              className="flex-1 bg-transparent py-2 text-sm text-white placeholder-gray-600 focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="llm-manual-install" className="sr-only">{`Install a ${labelFor(selected)} model by id`}</label>
            <input
              id="llm-manual-install"
              value={manualId}
              onChange={(e) => setManualId(e.target.value)}
              placeholder={selected === 'ollama' ? 'pull by name e.g. llama3.2' : 'publisher/Model-GGUF'}
              className="flex-1 sm:w-56 bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-port-accent"
            />
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
                  const fit = chosenVariant?.fit;
                  const fitMeta = fit ? FIT_META[fit] : null;
                  const ram = recommendedRamGb(sizeBytes, size);
                  const ctxLabel = formatContextLength(m.contextLength);
                  const createdMs = new Date(m.createdAt).getTime();
                  const updatedMs = new Date(m.updatedAt).getTime();
                  return (
                  <div key={m.key || m.id} className="flex items-start gap-3 bg-port-bg border border-port-border rounded-lg p-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-white truncate">
                        {m.name} <span className="text-xs text-gray-500">· {m.params}</span>
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
                      <div className="text-xs text-gray-500 truncate">{chosenId}</div>
                      <div className="text-xs text-gray-500 mt-0.5">{m.description}</div>
                      {m.note && <div className="text-[11px] text-port-warning/90 mt-0.5">{m.note}</div>}
                      {hasVariantPicker && (
                        <div className="flex items-center gap-1.5 flex-wrap mt-1">
                          <label htmlFor={`quant-${m.key}`} className="text-[11px] text-gray-500">Quant</label>
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
                                {v.quant}{v.size ? ` · ${v.size}` : ''}{v.installed ? ' · installed' : ''}{v.recommended ? ' · recommended' : ''}{v.fit === 'too-large' ? ' · exceeds RAM' : ''}{v.unsupported === 'sharded' ? ' · sharded (not on Ollama)' : ''}
                              </option>
                            ))}
                          </select>
                          {fitMeta && <span className={`text-[11px] ${fitMeta.cls}`} title="Fit on this machine — model weights + ~20% overhead vs. usable memory">{fitMeta.label}</span>}
                        </div>
                      )}
                      <div className="flex items-center gap-1.5 flex-wrap text-[11px] text-gray-600 mt-1">
                        <span className="text-gray-500">{categoryLabel(m.category)}</span>
                        <span>{size}</span>
                        {/* Single-variant cards (e.g. MLX) have no quant picker, so
                            surface the RAM-fit hint here instead of in the picker row. */}
                        {fitMeta && !hasVariantPicker && (
                          <span className={fitMeta.cls} title="Fit on this machine — model weights + ~20% overhead vs. usable memory">{fitMeta.label}</span>
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
                            title={`Published ${new Date(createdMs).toLocaleDateString()}${Number.isFinite(updatedMs) ? ` · updated ${timeAgo(m.updatedAt)}` : ''}`}
                          >
                            published {timeAgo(m.createdAt)}
                          </span>
                        )}
                        {isHf && m.license && <span>{m.license}</span>}
                        <CapabilityBadges capabilities={m.capabilities} />
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      {chosenInstalled ? (
                        <span className="text-xs px-2 py-1 text-port-success">Installed</span>
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
                      {isHf && m.repository && (
                        <a
                          href={`https://huggingface.co/${m.repository}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open the model page on Hugging Face"
                          className="px-2.5 py-1 text-xs bg-port-border/60 hover:bg-port-border text-gray-300 rounded flex items-center gap-1"
                        >
                          <ExternalLink size={12} />
                          Visit
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

        {/* Installed models */}
        <div className="space-y-2 pt-2 border-t border-port-border/50">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h3 className="text-xs font-medium text-gray-400">Installed on {labelFor(selected)} ({installedModels.length})</h3>
            {compareTargets.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">{compareTargets.length} selected</span>
                <button
                  onClick={openCompare}
                  disabled={compareTargets.length < 2}
                  className="px-2.5 py-1 text-xs bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded disabled:opacity-50 flex items-center gap-1"
                >
                  <ArrowRightLeft size={12} />
                  Compare selected
                </button>
              </div>
            )}
          </div>
          {installedModels.length === 0 ? (
            <p className="text-xs text-gray-500">No models installed yet.</p>
          ) : installedModels.map((m) => (
            <div key={m.id} className="flex items-center gap-3 bg-port-bg border border-port-border rounded-lg p-3">
              <label className="shrink-0 flex items-center" title={`Include ${m.name || m.id} in a comparison`}>
                <input
                  type="checkbox"
                  checked={compareTargetKeys.has(localLlmTargetKey({ backend: selected, modelId: m.id }))}
                  onChange={() => toggleCompareTarget(selected, m.id)}
                  className="h-4 w-4 accent-port-accent"
                  aria-label={`Select ${m.name || m.id} for comparison`}
                />
              </label>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-white truncate">{m.name}</div>
                <div className="text-xs text-gray-500 truncate">
                  {[m.params, m.quantization, m.family, formatContextLength(m.contextLength)].filter(Boolean).join(' · ')}
                </div>
                {(m.capabilities || []).length > 0 && (
                  <div className="flex items-center gap-1 flex-wrap mt-1">
                    <CapabilityBadges capabilities={m.capabilities} />
                  </div>
                )}
              </div>
              {m.size != null && <span className="text-xs text-gray-400 shrink-0">{formatBytes(m.size)}</span>}
              <Link
                to={`/local-llm/playground?backend=${encodeURIComponent(selected)}&model=${encodeURIComponent(m.id)}`}
                className="px-2.5 py-1 text-xs bg-port-accent-2/15 hover:bg-port-accent-2/25 text-port-accent-2 rounded flex items-center gap-1 shrink-0 no-underline"
                title={`Chat with ${m.name || m.id}`}
              >
                <FlaskConical size={12} />
                Chat
              </Link>
              {isConfirmingDelete(m.id) ? (
                <ConfirmButtonPair
                  prompt="Delete?"
                  confirmIcon={Trash2}
                  busy={busy}
                  className="shrink-0"
                  onConfirm={() => confirmDelete(() => remove(m.id))}
                  onCancel={cancelDelete}
                />
              ) : (
                <button
                  onClick={() => requestDelete(m.id)}
                  disabled={busy}
                  className="px-2.5 py-1 text-xs bg-port-error/20 hover:bg-port-error/40 text-port-error rounded disabled:opacity-50 flex items-center gap-1 shrink-0"
                  aria-label={`Delete ${m.name}`}
                >
                  {actionInProgress === `delete-${m.id}` ? <BrailleSpinner /> : <Trash2 size={12} />}
                  Delete
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default LocalLlmTab;
