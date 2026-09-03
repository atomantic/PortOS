import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router';
import { Download, RefreshCw, Search, Plus, ExternalLink, Star, Play, AlertTriangle } from 'lucide-react';
import toast from '../ui/Toast';
import FormField from '../ui/FormField';
import BrailleSpinner from '../BrailleSpinner';
import { formatAgeDays, formatContextLength, timeAgo, recommendedRamGb, formatDateNumeric } from '../../utils/formatters';
import { localLlmTargetKey } from '../../lib/localLlmTargetKey';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';
import useDownloadPreflightConfirm from '../../hooks/useDownloadPreflightConfirm';
import useLocalLlmStatus from '../../hooks/useLocalLlmStatus';
import { getLocalLlmCatalog, getLocalLlmHuggingFaceSearch, installLocalLlmModel, deleteLocalLlmModel, upgradeLocalLlmBackend, controlOllamaService, installAudioModel, previewLocalLlmDownload } from '../../services/api';
import CapabilityBadges from '../models/CapabilityBadges.jsx';
import LocalLlmInstalledModels from './LocalLlmInstalledModels.jsx';
import DownloadPreflightConfirm from '../models/DownloadPreflightConfirm.jsx';
import { LOCAL_LLM_BACKENDS as BACKENDS, localLlmBackendLabel as labelFor } from '../../lib/localLlmBackends.js';

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

// Find, install, compare and remove the model weights available to Ollama and
// LM Studio. Mounted only while the Model Library pill is selected, so the
// catalog is never queried for a reader who is looking at the runtimes.
export default function LocalLlmLibraryView() {
  const navigate = useNavigate();
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
  // id of the installed model awaiting a delete confirmation (two-step inline
  // confirm — deleting weights is an irreversible multi-GB rm -rf / DELETE).
  const { isConfirming: isConfirmingDelete, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();
  const [compareTargets, setCompareTargets] = useState([]);
  const catalogRequestId = useRef(0);
  const { confirm: downloadConfirm, request: requestWeightDownload, cancel: cancelDownloadConfirm, confirmRun: runDownloadConfirm } = useDownloadPreflightConfirm();
  // The catalog reload the shared hook fires after an action (or a `complete`
  // progress frame) depends on state this hook returns, so it is reached
  // through a ref rather than a closure — that also keeps `runAction` stable
  // across every keystroke in the search box.
  const reloadCatalogRef = useRef(null);
  const reloadCatalog = useCallback(() => reloadCatalogRef.current?.(), []);
  const {
    status, selected, setSelected, runAction, installBackend: installRuntimeBackend,
    actionInProgress, busy, progressMsg, setProgressMsg,
  } = useLocalLlmStatus({ onReload: reloadCatalog });

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
    reloadCatalogRef.current = () => loadCatalog(selected, query, catalogSource, activeCategory);
  });

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
  const startInstall = (modelId, { force = false } = {}) => runAction(
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
  const install = (modelId, opts = {}) => requestWeightDownload({
    title: opts.force ? 'Redownload local model' : 'Install local model',
    preview: () => previewLocalLlmDownload({ kind: 'install', backend: selected, modelId }, { silent: true }),
    run: () => startInstall(modelId, opts),
  });
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
    setUpgradeFlow({ modelId, phase: 'upgrading' });
    runAction(
      'upgrade-ollama',
      () => upgradeLocalLlmBackend('ollama'),
      (r) => r?.note ? `Ollama upgraded — ${r.note}` : 'Ollama upgraded'
    ).then((r) => {
      if (r?.success && modelId) {
        setUpgradeFlow({ modelId, phase: 'retrying' });
        startInstall(modelId);
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
    <section id="llm-management-panel-library" role="tabpanel" aria-labelledby="tab-library" className="space-y-4">
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
              {selectedData.installed
                ? `${labelFor(selected)} isn't running — ${selected === 'ollama' ? 'use the controls to start it or keep it running at login.' : 'launch the app and enable the local server.'}`
                : `${labelFor(selected)} isn't installed yet.`}
            </span>
            {!selectedData.installed && selectedData.canAutoInstall && (
              <button
                onClick={() => installRuntimeBackend(selected)}
                disabled={busy}
                className={`${btnClass} bg-port-accent/20 hover:bg-port-accent/30 text-port-accent`}
              >
                {actionInProgress === `runtime-install-${selected}` ? <BrailleSpinner /> : <Download size={12} />}
                Install {labelFor(selected)}
              </button>
            )}
            {!selectedData.installed && !selectedData.canAutoInstall && selectedData.downloadUrl && (
              <a
                href={selectedData.downloadUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={`${btnClass} bg-port-border hover:bg-port-border/70 text-white no-underline`}
              >
                <ExternalLink size={12} />
                Download {labelFor(selected)}
              </a>
            )}
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
