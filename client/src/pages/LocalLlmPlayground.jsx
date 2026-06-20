import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRightLeft, Brain, Check, ChevronDown, Clock, Copy, Cpu, Gauge, MessageSquare, Play, RefreshCw, Send, TriangleAlert, X } from 'lucide-react';
import BrailleSpinner from '../components/BrailleSpinner';
import PlaygroundOutput from '../components/localLlm/PlaygroundOutput';
import toast from '../components/ui/Toast';
import { copyToClipboard } from '../lib/clipboard';
import { localLlmTargetKey } from '../lib/localLlmTargetKey';
import { formatBytes, recommendedRamGb, timeUntil } from '../utils/formatters';
import { compareLocalLlmModels, getLoadedLlmModels, getLocalLlmCatalog, getLocalLlmStatus, streamLocalLlmTest } from '../services/api';

const BACKEND_LABEL = { ollama: 'Ollama', lmstudio: 'LM Studio' };
const DEFAULT_PROMPT = 'Write a short, vivid paragraph about a lighthouse computer waking up at dawn.';
const CATEGORY_LABELS = {
  chat: 'Chat',
  reasoning: 'Reasoning',
  coding: 'Coding',
  vision: 'Image Analysis',
  embedding: 'Text Embeddings',
  lightweight: 'Small & Fast',
  multilingual: 'Multilingual',
};
const CAPABILITY_LABELS = {
  chat: 'Chat',
  code: 'Code',
  reasoning: 'Reasoning',
  vision: 'Vision',
  embeddings: 'Embeddings',
  tools: 'Tool use',
  multilingual: 'Multilingual',
  classification: 'Classification',
};

function formatMs(ms) {
  if (ms == null) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatRate(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${value.toFixed(value >= 10 ? 1 : 2)} chars/s`;
}

// Ollama auto-evicts an idle model after `keep_alive` (5m default). `/api/ps`
// returns the absolute eviction time as `expires_at`; render it as a short
// "frees in 5m" countdown so the badge says when the slot frees itself. Reuses
// the shared future-relative formatter, returning null (badge hidden) once the
// slot has expired or no eviction time is reported.
function formatExpiresIn(expiresAt) {
  const rel = timeUntil(expiresAt, null);
  return rel ? rel.replace(/^in /, 'frees in ') : null;
}

function modelSizeLabel(model) {
  if (Number.isFinite(model?.size)) return formatBytes(model.size);
  return model?.catalog?.size || '';
}

function getUseCaseTags(model) {
  const tags = [];
  if (model?.catalog?.category) tags.push(CATEGORY_LABELS[model.catalog.category] || model.catalog.category);
  for (const capability of model?.catalog?.capabilities || []) {
    const label = CAPABILITY_LABELS[capability] || capability;
    if (!tags.includes(label)) tags.push(label);
  }
  return tags;
}

function normalizeCatalogId(backend, id) {
  const value = String(id || '').trim().toLowerCase();
  if (backend === 'ollama') return value.replace(/:latest$/, '');
  return value.split('/').pop().replace(/[-.]gguf$/i, '');
}

// Number inputs hold raw strings; an emptied field is '' and `Number('')` is 0,
// which would silently send temperature 0 or fail maxTokens' min(1) server-side.
// Fall back to the field's default when the value isn't a finite, non-empty number.
function numOr(value, fallback) {
  if (value === '' || value == null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseTargetsParam(searchParams) {
  const rawTargets = searchParams.get('targets');
  if (rawTargets) {
    try {
      const parsed = JSON.parse(rawTargets);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((t) => (t.backend === 'ollama' || t.backend === 'lmstudio') && typeof t.modelId === 'string' && t.modelId)
          .slice(0, 6);
      }
    } catch {
      return [];
    }
  }

  const backend = searchParams.get('backend');
  const modelId = searchParams.get('model');
  if ((backend === 'ollama' || backend === 'lmstudio') && modelId) return [{ backend, modelId }];
  return [];
}

// Tiny status pill used for the sidebar memory badges (In memory / Processing /
// frees-in). Keeps the shared chrome in one place; callers pass only the color.
function Pill({ className, children }) {
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] leading-none ${className}`}>
      {children}
    </span>
  );
}

function Metric({ icon: Icon, label, value }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-gray-400">
      <Icon size={13} className="text-gray-500" />
      <span>{label}</span>
      <span className="text-gray-200">{value}</span>
    </div>
  );
}

function ResultPanel({ result }) {
  const ok = !result?.error;
  // A failed run that still streamed tokens before it stopped (e.g. a timeout) —
  // show the partial output alongside the error rather than hiding it.
  const hasPartial = Boolean(result?.error && result?.text);
  return (
    <section className={`border rounded-lg bg-port-bg p-3 space-y-3 ${ok ? 'border-port-border' : 'border-port-error/40'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-white truncate">{result.modelId}</div>
          <div className="text-xs text-gray-500">{BACKEND_LABEL[result.backend] || result.backend}</div>
        </div>
        <span className={`text-xs px-2 py-1 rounded ${ok ? 'bg-port-success/15 text-port-success' : hasPartial ? 'bg-port-warning/15 text-port-warning' : 'bg-port-error/15 text-port-error'}`}>
          {ok ? 'Done' : hasPartial ? 'Partial' : 'Failed'}
        </span>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <Metric icon={Clock} label="TTFT" value={formatMs(result.timings?.ttftMs)} />
        <Metric icon={Gauge} label="Total" value={formatMs(result.timings?.totalMs)} />
        <Metric icon={MessageSquare} label="Speed" value={formatRate(result.timings?.charsPerSecond)} />
      </div>

      {result.error && (
        <p className="text-sm text-port-error whitespace-pre-wrap">{result.error}</p>
      )}
      {result.text && (
        <div className="space-y-1">
          {hasPartial && <div className="text-xs text-port-warning">Partial output before the run stopped</div>}
          <div className="max-h-[28rem] overflow-auto">
            <PlaygroundOutput text={result.text} />
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {result.runId && (
          <Link to={`/devtools/runs?run=${encodeURIComponent(result.runId)}`} className="text-xs text-port-accent hover:underline">
            Run {result.runId.slice(0, 8)}
          </Link>
        )}
        {result.text && (
          <button
            onClick={() => copyToClipboard(result.text, 'Copied output')}
            className="text-xs text-gray-400 hover:text-white flex items-center gap-1"
          >
            <Copy size={12} />
            Copy
          </button>
        )}
      </div>
    </section>
  );
}

// Live panel shown while a chat run streams tokens. Replaced by a final
// ResultPanel (with timings) once the run settles. Reasoning (a reasoning
// model's chain-of-thought) streams on its own channel and renders in a
// distinct "Thinking" block above the answer, so the answer text stays clean.
function StreamingPanel({ stream }) {
  const hasReasoning = Boolean(stream.reasoning);
  const hasText = Boolean(stream.text);
  return (
    <section className="border border-port-accent/40 rounded-lg bg-port-bg p-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-white truncate">{stream.modelId}</div>
          <div className="text-xs text-gray-500">{BACKEND_LABEL[stream.backend] || stream.backend}</div>
        </div>
        <span className="flex items-center gap-2 text-xs px-2 py-1 rounded bg-port-accent/15 text-port-accent">
          <BrailleSpinner />
          {!hasText && hasReasoning ? 'Thinking' : 'Streaming'}
        </span>
      </div>
      {hasReasoning && (
        <div className="rounded-lg border border-port-border bg-port-card/40 p-2 space-y-1">
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <Brain size={12} className="text-gray-600" />
            Thinking
          </div>
          <div className="max-h-48 overflow-auto text-xs text-gray-400 whitespace-pre-wrap break-words">
            {stream.reasoning}
          </div>
        </div>
      )}
      {hasText
        ? <div className="max-h-[28rem] overflow-auto"><PlaygroundOutput text={stream.text} /></div>
        : !hasReasoning && <div className="text-sm text-gray-500">Waiting for the first token…</div>}
    </section>
  );
}

export default function LocalLlmPlayground() {
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState(null);
  const [catalogByBackend, setCatalogByBackend] = useState({});
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [modelLoadError, setModelLoadError] = useState('');
  // Ollama models currently resident in VRAM/unified memory (from `/api/ps`),
  // polled so the sidebar can flag which models are warm — and which one is
  // actively serving the in-flight run.
  const [loadedModels, setLoadedModels] = useState([]);
  const [selectedTargets, setSelectedTargets] = useState(() => parseTargetsParam(searchParams));
  const [activeMode, setActiveMode] = useState(() => searchParams.get('mode') === 'compare' ? 'compare' : 'chat');
  const [runMode, setRunMode] = useState('round-robin');
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [temperature, setTemperature] = useState(0.3);
  const [maxTokens, setMaxTokens] = useState(1000);
  const [timeoutMs, setTimeoutMs] = useState(300000);
  const [busy, setBusy] = useState(false);
  const [chatResults, setChatResults] = useState([]);
  const [streamingChat, setStreamingChat] = useState(null);
  const [compareResult, setCompareResult] = useState(null);
  // Models sidebar is always shown on xl+; on smaller screens it collapses so
  // the prompt/controls stay above the fold. Open by default on first load.
  const [modelsOpen, setModelsOpen] = useState(true);

  const mountedRef = useRef(true);
  // Holds the AbortController for the in-flight run so the Cancel button can
  // abort the client fetch (which closes the server-side stream early). Cleared
  // in each run's .finally(). Abort the live request on unmount too.
  const runControllerRef = useRef(null);
  // Streaming tokens arrive faster than is worth re-rendering for (each render
  // re-parses the whole accumulated output). Accumulate into refs and flush to
  // state on a ~80ms timer so the live panel updates smoothly without an
  // O(n²) re-parse storm on long outputs. Content and reasoning stream on
  // separate channels so a reasoning model's chain-of-thought renders live in
  // its own block instead of polluting the answer text.
  const streamBufRef = useRef('');
  const reasoningBufRef = useRef('');
  const flushTimerRef = useRef(null);
  useEffect(() => () => {
    mountedRef.current = false;
    runControllerRef.current?.abort();
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
  }, []);

  const flushStream = () => {
    flushTimerRef.current = null;
    if (!mountedRef.current) return;
    const text = streamBufRef.current;
    const reasoning = reasoningBufRef.current;
    setStreamingChat((prev) => (prev ? { ...prev, text, reasoning } : prev));
  };

  const cancelRun = () => runControllerRef.current?.abort();

  const loadStatus = useCallback(() => {
    setLoadingStatus(true);
    setModelLoadError('');
    return getLocalLlmStatus({ silent: true })
      .then(async (nextStatus) => {
        if (!mountedRef.current) return;
        setStatus(nextStatus);
        const backendsWithModels = ['ollama', 'lmstudio'].filter((backend) => (nextStatus?.[backend]?.models || []).length > 0);
        const catalogs = await Promise.all(backendsWithModels.map((backend) =>
          getLocalLlmCatalog(backend).then((result) => [backend, result?.models || []]).catch(() => [backend, []])
        ));
        if (!mountedRef.current) return;
        setCatalogByBackend(Object.fromEntries(catalogs));
      })
      .catch((err) => {
        if (!mountedRef.current) return;
        setCatalogByBackend({});
        setModelLoadError(err?.message || 'Failed to load local models');
      })
      .finally(() => { if (mountedRef.current) setLoadingStatus(false); });
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const refreshLoaded = useCallback(() => {
    return getLoadedLlmModels({ silent: true })
      .then((res) => { if (mountedRef.current) setLoadedModels(res?.ollama || []); })
      .catch(() => { if (mountedRef.current) setLoadedModels([]); });
  }, []);

  // Poll which models are warm in memory. A faster cadence while a run is busy
  // so the "serving" flag and freed-slot countdown stay live; relaxed when idle.
  useEffect(() => {
    refreshLoaded();
    const interval = setInterval(refreshLoaded, busy ? 2000 : 6000);
    return () => clearInterval(interval);
  }, [refreshLoaded, busy]);

  const installedTargets = useMemo(() => {
    const models = [];
    for (const backend of ['ollama', 'lmstudio']) {
      const catalogById = new Map((catalogByBackend[backend] || []).map((entry) => [normalizeCatalogId(backend, entry.id), entry]));
      for (const model of status?.[backend]?.models || []) {
        models.push({
          backend,
          modelId: model.id,
          name: model.name || model.id,
          size: model.size,
          params: model.params,
          quantization: model.quantization,
          family: model.family,
          meta: model,
          catalog: catalogById.get(normalizeCatalogId(backend, model.id)) || null,
        });
      }
    }
    return models;
  }, [catalogByBackend, status]);

  // Map each warm Ollama model to its installed-row key so the sidebar can
  // match it. `/api/ps` reports the same tagged name `/api/tags` does, so the
  // shared `normalizeCatalogId` reconciles `:latest` and casing on both sides.
  const loadedByKey = useMemo(() => {
    const map = new Map();
    for (const m of loadedModels) {
      const key = normalizeCatalogId('ollama', m.id || m.name);
      if (key) map.set(key, m);
    }
    return map;
  }, [loadedModels]);

  useEffect(() => {
    if (selectedTargets.length > 0 || installedTargets.length === 0) return;
    setSelectedTargets([{ backend: installedTargets[0].backend, modelId: installedTargets[0].modelId }]);
  }, [installedTargets, selectedTargets.length]);

  const selectedKeys = useMemo(() => new Set(selectedTargets.map(localLlmTargetKey)), [selectedTargets]);
  // `/api/ps` reports what's resident but not which model is mid-generation, so
  // derive the "processing" flag from our own in-flight run: the streaming chat
  // target, or every target in a busy comparison. Intentionally backend-agnostic
  // — an LM Studio model driven by a comparison shows "Processing" too (the
  // memory-residency badges above it stay Ollama-only since `/api/ps` is).
  const runningKeys = useMemo(() => {
    if (!busy) return new Set();
    if (activeMode === 'chat') return streamingChat ? new Set([localLlmTargetKey(streamingChat)]) : new Set();
    return new Set(selectedTargets.map(localLlmTargetKey));
  }, [busy, activeMode, streamingChat, selectedTargets]);
  const primaryTarget = selectedTargets[0] || null;
  const canRunChat = Boolean(primaryTarget && prompt.trim());
  const canCompare = selectedTargets.length > 0 && prompt.trim();

  const toggleTarget = (target) => {
    const key = localLlmTargetKey(target);
    setSelectedTargets((prev) => {
      if (prev.some((t) => localLlmTargetKey(t) === key)) return prev.filter((t) => localLlmTargetKey(t) !== key);
      if (prev.length >= 6) {
        toast.error('Compare up to 6 models at once');
        return prev;
      }
      return [...prev, { backend: target.backend, modelId: target.modelId }];
    });
  };

  const options = () => ({
    systemPrompt,
    temperature: numOr(temperature, 0.3),
    maxTokens: numOr(maxTokens, 1000),
    timeoutMs: numOr(timeoutMs, 300000),
  });

  const runChat = () => {
    if (!canRunChat) return;
    const controller = new AbortController();
    runControllerRef.current = controller;
    setBusy(true);
    const target = primaryTarget;
    streamBufRef.current = '';
    reasoningBufRef.current = '';
    setStreamingChat({ backend: target.backend, modelId: target.modelId, text: '', reasoning: '' });
    streamLocalLlmTest(
      { ...target, prompt: prompt.trim(), ...options() },
      {
        signal: controller.signal,
        onToken: (delta, kind) => {
          if (!mountedRef.current || !delta) return;
          if (kind === 'reasoning') reasoningBufRef.current += delta;
          else streamBufRef.current += delta;
          if (!flushTimerRef.current) flushTimerRef.current = setTimeout(flushStream, 80);
        },
      },
    )
      .then((result) => {
        if (!mountedRef.current || !result) return;
        setChatResults((prev) => [result, ...prev]);
        if (result.error) toast.error(result.error);
      })
      // A user-initiated cancel rejects the fetch with AbortError — don't surface
      // it as a failure; the request was stopped on purpose.
      .catch((err) => { if (mountedRef.current && !controller.signal.aborted) toast.error(err?.message || 'Model test failed'); })
      .finally(() => {
        if (runControllerRef.current === controller) runControllerRef.current = null;
        // Drop any pending flush — the final result replaces the live panel.
        if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
        if (mountedRef.current) {
          setBusy(false);
          setStreamingChat(null);
        }
      });
  };

  const runCompare = () => {
    if (!canCompare) return;
    const controller = new AbortController();
    runControllerRef.current = controller;
    setBusy(true);
    setCompareResult(null);
    compareLocalLlmModels({
      mode: runMode,
      prompt: prompt.trim(),
      targets: selectedTargets,
      options: options(),
    }, { silent: true, signal: controller.signal })
      .then((result) => {
        if (!mountedRef.current) return;
        setCompareResult(result);
        if ((result.results || []).some((r) => r.error)) toast.error('Some model runs failed');
      })
      .catch((err) => { if (mountedRef.current && !controller.signal.aborted) toast.error(err?.message || 'Comparison failed'); })
      .finally(() => {
        if (runControllerRef.current === controller) runControllerRef.current = null;
        if (mountedRef.current) setBusy(false);
      });
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-3 p-4 border-b border-port-border">
        <div className="flex items-center gap-3 min-w-0">
          <Link to="/settings/local-llm" className="p-2 rounded-lg bg-port-card border border-port-border text-gray-400 hover:text-white" title="Back to Local LLMs">
            <ArrowLeft size={16} />
          </Link>
          <div className="min-w-0">
            <h1 className="text-lg md:text-2xl font-bold text-white truncate">Local LLM Playground</h1>
            <p className="text-xs md:text-sm text-gray-500 truncate">
              {selectedTargets.length} model{selectedTargets.length === 1 ? '' : 's'} selected
              {loadedModels.length > 0 && (
                <span className="text-port-success"> · {loadedModels.length} in memory</span>
              )}
            </p>
          </div>
        </div>
        <button onClick={() => { loadStatus(); refreshLoaded(); }} disabled={loadingStatus} className="p-2 text-gray-400 hover:text-white transition-colors" title="Refresh models" aria-label="Refresh models">
          <RefreshCw size={16} className={loadingStatus ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        <div className="grid grid-cols-1 xl:grid-cols-[320px_1fr] gap-4">
          <aside className="bg-port-card border border-port-border rounded-lg p-4 space-y-4">
            <button
              type="button"
              onClick={() => setModelsOpen((v) => !v)}
              className="w-full flex items-center justify-between gap-2 xl:cursor-default"
              aria-expanded={modelsOpen}
            >
              <span className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-300">Models</span>
                <span className="text-xs text-gray-500 xl:hidden">({selectedTargets.length} selected)</span>
              </span>
              <span className="flex items-center gap-2">
                {loadingStatus && <BrailleSpinner />}
                <ChevronDown size={16} className={`text-gray-500 xl:hidden transition-transform ${modelsOpen ? '' : '-rotate-90'}`} />
              </span>
            </button>
            <div className={`${modelsOpen ? 'block' : 'hidden'} xl:block space-y-4`}>
            {installedTargets.length === 0 && !loadingStatus ? (
              <p className={`text-sm ${modelLoadError ? 'text-port-warning' : 'text-gray-500'}`}>
                {modelLoadError || 'No installed local models found.'}
              </p>
            ) : (
              <div className="space-y-3">
                {['ollama', 'lmstudio'].map((backend) => {
                  const models = installedTargets.filter((target) => target.backend === backend);
                  if (models.length === 0) return null;
                  return (
                    <div key={backend} className="space-y-2">
                      <div className="text-xs text-gray-500">{BACKEND_LABEL[backend]}</div>
                      {models.map((target) => {
                        const selected = selectedKeys.has(localLlmTargetKey(target));
                        const size = modelSizeLabel(target);
                        const ram = recommendedRamGb(target?.size, target?.catalog?.size);
                        const tags = getUseCaseTags(target);
                        const loaded = backend === 'ollama' ? loadedByKey.get(normalizeCatalogId('ollama', target.modelId)) : null;
                        const running = runningKeys.has(localLlmTargetKey(target));
                        const freesIn = loaded ? formatExpiresIn(loaded.expiresAt) : null;
                        const detailParts = [
                          target.catalog?.params || target.params,
                          size,
                          ram ? `~${ram} GB RAM` : null,
                        ].filter(Boolean);
                        return (
                          <button
                            key={localLlmTargetKey(target)}
                            onClick={() => toggleTarget(target)}
                            className={`w-full min-h-12 flex items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${selected ? 'border-port-accent/60 bg-port-accent/10' : 'border-port-border bg-port-bg hover:border-gray-600'}`}
                          >
                            <span className={`w-5 h-5 mt-0.5 rounded border flex items-center justify-center shrink-0 ${selected ? 'border-port-accent bg-port-accent/20 text-port-accent' : 'border-gray-600 text-transparent'}`}>
                              <Check size={13} />
                            </span>
                            <span className="min-w-0 flex-1 space-y-1">
                              <span className="block text-sm text-white truncate">{target.name}</span>
                              <span className="block text-xs text-gray-500 truncate">{target.modelId}</span>
                              {(loaded || running) && (
                                <span className="flex flex-wrap items-center gap-1 pt-0.5">
                                  {running ? (
                                    <Pill className="bg-port-accent/15 text-port-accent">
                                      <BrailleSpinner />
                                      Processing
                                    </Pill>
                                  ) : (
                                    <Pill className="bg-port-success/15 text-port-success">
                                      <Cpu size={10} />
                                      In memory{Number.isFinite(loaded?.sizeVram) ? ` · ${formatBytes(loaded.sizeVram)}` : ''}
                                    </Pill>
                                  )}
                                  {!running && freesIn && (
                                    <Pill className="bg-port-border/70 text-gray-400">{freesIn}</Pill>
                                  )}
                                </span>
                              )}
                              {detailParts.length > 0 && (
                                <span className="block text-[11px] text-gray-400 truncate">{detailParts.join(' · ')}</span>
                              )}
                              {target.catalog?.description && (
                                <span className="block text-[11px] leading-snug text-gray-500">{target.catalog.description}</span>
                              )}
                              {tags.length > 0 && (
                                <span className="flex flex-wrap gap-1 pt-0.5">
                                  {tags.slice(0, 5).map((tag) => (
                                    <span key={tag} className="px-1.5 py-0.5 rounded bg-port-border/70 text-[10px] leading-none text-gray-400">
                                      {tag}
                                    </span>
                                  ))}
                                </span>
                              )}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
            </div>
          </aside>

          <main className="space-y-4">
            <section className="bg-port-card border border-port-border rounded-lg p-4 space-y-4">
              <div className="flex items-center gap-2 flex-wrap">
                {[
                  { id: 'chat', label: 'Chat', icon: MessageSquare },
                  { id: 'compare', label: 'Compare', icon: ArrowRightLeft },
                ].map((tab) => {
                  const Icon = tab.icon;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => setActiveMode(tab.id)}
                      className={`px-3 py-1.5 text-sm rounded-lg flex items-center gap-1.5 ${activeMode === tab.id ? 'bg-port-accent/20 text-port-accent' : 'bg-port-bg text-gray-400 hover:text-white'}`}
                    >
                      <Icon size={14} />
                      {tab.label}
                    </button>
                  );
                })}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
                <div className="space-y-3">
                  <label htmlFor="local-llm-system" className="block text-xs text-gray-500">System prompt</label>
                  <textarea
                    id="local-llm-system"
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    rows={3}
                    className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-port-accent resize-y"
                    placeholder="Optional"
                  />
                  <label htmlFor="local-llm-prompt" className="block text-xs text-gray-500">Prompt</label>
                  <textarea
                    id="local-llm-prompt"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={7}
                    className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-port-accent resize-y"
                  />
                </div>

                <div className="space-y-3">
                  <label className="block text-xs text-gray-500" htmlFor="local-llm-temperature">Temperature</label>
                  <input id="local-llm-temperature" type="number" min="0" max="2" step="0.1" value={temperature} onChange={(e) => setTemperature(e.target.value)} className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white" />
                  <label className="block text-xs text-gray-500" htmlFor="local-llm-max-tokens">Max tokens</label>
                  <input id="local-llm-max-tokens" type="number" min="1" max="8192" step="64" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white" />
                  <label className="block text-xs text-gray-500" htmlFor="local-llm-timeout">Timeout</label>
                  <select id="local-llm-timeout" value={timeoutMs} onChange={(e) => setTimeoutMs(Number(e.target.value))} className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white">
                    <option value={60000}>1 minute</option>
                    <option value={180000}>3 minutes</option>
                    <option value={300000}>5 minutes</option>
                    <option value={600000}>10 minutes</option>
                  </select>
                  {activeMode === 'compare' && (
                    <>
                      <label className="block text-xs text-gray-500" htmlFor="local-llm-mode">Execution</label>
                      <select id="local-llm-mode" value={runMode} onChange={(e) => setRunMode(e.target.value)} className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white">
                        <option value="round-robin">Round robin</option>
                        <option value="parallel">Parallel</option>
                      </select>
                    </>
                  )}
                  {busy ? (
                    <button
                      onClick={cancelRun}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-port-error/15 hover:bg-port-error/25 text-port-error text-sm font-medium rounded-lg"
                    >
                      <X size={15} />
                      Cancel
                    </button>
                  ) : (
                    <button
                      onClick={activeMode === 'chat' ? runChat : runCompare}
                      disabled={activeMode === 'chat' ? !canRunChat : !canCompare}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent text-sm font-medium rounded-lg disabled:opacity-50"
                    >
                      {activeMode === 'chat' ? <Send size={15} /> : <Play size={15} />}
                      {activeMode === 'chat' ? 'Run chat' : 'Run comparison'}
                    </button>
                  )}
                </div>
              </div>
            </section>

            {activeMode === 'chat' ? (
              <section className="space-y-3">
                {streamingChat && <StreamingPanel stream={streamingChat} />}
                {chatResults.length === 0 && !streamingChat ? (
                  <div className="bg-port-card border border-port-border rounded-lg p-5 text-sm text-gray-500 flex items-center gap-2">
                    <TriangleAlert size={16} className="text-gray-600" />
                    Pick a model, enter a prompt, and run a chat test.
                  </div>
                ) : chatResults.map((result, idx) => <ResultPanel key={`${result.runId || idx}-${result.modelId}`} result={result} />)}
              </section>
            ) : (
              <section className="space-y-3">
                {compareResult ? (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                    {compareResult.results.map((result, idx) => <ResultPanel key={`${result.runId || idx}-${result.modelId}`} result={result} />)}
                  </div>
                ) : (
                  <div className="bg-port-card border border-port-border rounded-lg p-5 text-sm text-gray-500 flex items-center gap-2">
                    <TriangleAlert size={16} className="text-gray-600" />
                    Select one or more models and run the same prompt through them.
                  </div>
                )}
              </section>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
