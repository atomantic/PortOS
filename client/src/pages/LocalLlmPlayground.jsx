import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSocketResource } from '../hooks/useSocketResource.js';
import useMounted from '../hooks/useMounted';
import { Link, useSearchParams } from 'react-router';
import { ArrowLeft, ArrowRightLeft, MessageSquare, Play, RefreshCw, Send, X } from 'lucide-react';
import PlaygroundModelSidebar from '../components/localLlm/PlaygroundModelSidebar';
import PlaygroundResults from '../components/localLlm/PlaygroundResults';
import ModelsTabsHeader, { ModelsSectionLayout } from '../components/models/ModelsTabsHeader';
import CollapsibleSection from '../components/ui/CollapsibleSection';
import TabPills from '../components/ui/TabPills';
import toast from '../components/ui/Toast';
import { localLlmTargetKey } from '../lib/localLlmTargetKey';
import { filterHardwareCompatibleModels } from '../utils/systemCapabilities';
import {
  compareLocalLlmModels,
  getLoadedLlmModels,
  getLocalLlmCatalog,
  getLocalLlmStatus,
  getLocalRuntimeModels,
  streamLocalLlmTest,
} from '../services/apiLocalLlm.js';
import { getNavPageForPath } from '../../../server/lib/navManifest.js';
import { LOCAL_RUNTIME_LABELS } from '../../../server/lib/modelPinMembership.js';

const PLAYGROUND_MODES = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'compare', label: 'Compare', icon: ArrowRightLeft },
];
const LOADED_EVENTS = ['loaded-models:changed'];

// Managed backends come from `/status`; every other runtime id and its label comes from `/runtime-models`.
const BACKEND_LABEL = { ollama: LOCAL_RUNTIME_LABELS.ollama, lmstudio: LOCAL_RUNTIME_LABELS.lmstudio };
const MANAGED_BACKENDS = ['ollama', 'lmstudio'];
const NO_RUNTIMES = Object.freeze([]);
// A saved `?targets=` link may name any runtime the server serves; the server's schema is the real gate, so the
// client only checks the id's shape and lets the picker drop a target no listed runtime serves.
const isBackendId = (value) => typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value);
const DEFAULT_PROMPT = 'Write a short, vivid paragraph about a lighthouse computer waking up at dawn.';
// Single source for the timeout choices so the collapsed Advanced-options
// summary names the selected one without re-deriving the label from the ms.
const TIMEOUT_OPTIONS = [
  { value: 60000, label: '1 minute', short: '1 min' },
  { value: 180000, label: '3 minutes', short: '3 min' },
  { value: 300000, label: '5 minutes', short: '5 min' },
  { value: 600000, label: '10 minutes', short: '10 min' },
];
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
          .filter((t) => t && isBackendId(t.backend) && typeof t.modelId === 'string' && t.modelId)
          .slice(0, 6);
      }
    } catch {
      return [];
    }
  }

  const backend = searchParams.get('backend');
  const modelId = searchParams.get('model');
  if (isBackendId(backend) && modelId) return [{ backend, modelId }];
  return [];
}

export default function LocalLlmPlayground() {
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState(null);
  const [catalogByBackend, setCatalogByBackend] = useState({});
  // `null` until /runtime-models answers, so the stale-selection prune below waits for it.
  const [runtimeRows, setRuntimeRows] = useState(null);
  const [runtimeError, setRuntimeError] = useState('');
  const [loadingManaged, setLoadingManaged] = useState(true);
  const [loadingRuntimes, setLoadingRuntimes] = useState(true);
  const loadingStatus = loadingManaged || loadingRuntimes;
  const [modelLoadError, setModelLoadError] = useState('');
  // Ollama models currently resident in VRAM/unified memory (from `/api/ps`),
  // observed so the sidebar can flag which models are warm — and which one is
  // actively serving the in-flight run.

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
  // Models sidebar is always shown on xl+; on smaller screens it is a
  // disclosure. It starts CLOSED so the prompt and the Run button are the first
  // things a narrow viewport shows — the whole inventory expanded ahead of them
  // pushed Run ~2,400px down a 375×812 screen (#7232). The effect below reopens
  // it whenever there is no selection, so the prerequisite is never hidden.

  const mountedRef = useMounted();
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

  // The managed pair (/status) and the endpoint runtimes (/runtime-models) load independently: a stopped runtime can
  // make its listing slow, and either request failing must not hide what the other already returned.
  const loadStatus = useCallback(() => {
    setLoadingManaged(true);
    setLoadingRuntimes(true);
    setModelLoadError('');
    setRuntimeError('');
    getLocalRuntimeModels({ silent: true })
      .then((r) => {
        if (!mountedRef.current) return;
        setRuntimeRows(r?.runtimes ?? NO_RUNTIMES);
      })
      .catch((err) => {
        if (!mountedRef.current) return;
        // A failed listing keeps the last good rows (or none yet); it is never an empty inventory.
        setRuntimeRows((previous) => previous ?? NO_RUNTIMES);
        setRuntimeError(err?.message || 'Failed to list runtime models');
      })
      .finally(() => { if (mountedRef.current) setLoadingRuntimes(false); });
    return getLocalLlmStatus({ silent: true })
      .then(async (nextStatus) => {
        if (!mountedRef.current) return;
        setStatus(nextStatus);
        const backendsWithModels = MANAGED_BACKENDS.filter((backend) => (nextStatus?.[backend]?.models || []).length > 0);
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
      .finally(() => { if (mountedRef.current) setLoadingManaged(false); });
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const loadedResource = useSocketResource(
    () => getLoadedLlmModels({ silent: true }),
    { namespace: 'loaded-models', events: LOADED_EVENTS },
  );
  const loadedModels = loadedResource.data?.ollama || [];
  const loadedUnknown = loadedResource.error || loadedResource.data?.sourceErrors?.includes('ollama');

  const installedTargets = useMemo(() => {
    const models = [];
    for (const backend of MANAGED_BACKENDS) {
      const catalogById = new Map((catalogByBackend[backend] || []).map((entry) => [normalizeCatalogId(backend, entry.id), entry]));
      for (const model of filterHardwareCompatibleModels(status?.[backend]?.models)) {
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
    // A runtime that is not answering contributes no targets: its row renders as "not running" instead.
    for (const runtime of runtimeRows || []) {
      if (runtime.offline) continue;
      for (const model of runtime.models || []) {
        models.push({ backend: runtime.id, modelId: model.id, name: model.id });
      }
    }
    return models;
  }, [catalogByBackend, runtimeRows, status]);

  const runtimeLabels = useMemo(
    () => ({ ...BACKEND_LABEL, ...Object.fromEntries((runtimeRows || []).map((r) => [r.id, r.label])) }),
    [runtimeRows],
  );
  const backendLabel = (backend) => runtimeLabels[backend] || backend;
  const offlineRuntimes = useMemo(() => (runtimeRows || []).filter((r) => r.offline || (r.models || []).length === 0), [runtimeRows]);

  // Map each warm Ollama model to its installed-row key so the sidebar can
  // match it. `/api/ps` reports the same tagged name `/api/tags` does, so the
  // shared `normalizeCatalogId` reconciles `:latest` and casing on both sides.
  const loadedByKey = useMemo(() => {
    const map = new Map();
    for (const m of loadedUnknown ? [] : loadedModels) {
      const key = normalizeCatalogId('ollama', m.id || m.name);
      if (key) map.set(key, m);
    }
    return map;
  }, [loadedModels, loadedUnknown]);

  useEffect(() => {
    if (loadingStatus || status == null || runtimeRows == null) return;
    const installedKeys = new Set(installedTargets.map(localLlmTargetKey));
    setSelectedTargets((previous) => {
      // A runtime whose listing failed (whole request, or its own row's `error`) has an unknown inventory, not an
      // empty one: keep its targets so a transient failure cannot swap the selected model for another backend's.
      const inventoryUnknown = (backend) => !MANAGED_BACKENDS.includes(backend)
        && (Boolean(runtimeError) || Boolean(runtimeRows.find((r) => r.id === backend)?.error));
      const next = previous.filter((target) => installedKeys.has(localLlmTargetKey(target)) || inventoryUnknown(target.backend));
      return next.length === previous.length ? previous : next;
    });
  }, [installedTargets, loadingStatus, runtimeError, runtimeRows, status]);

  useEffect(() => {
    if (selectedTargets.length > 0 || installedTargets.length === 0) return;
    setSelectedTargets([{ backend: installedTargets[0].backend, modelId: installedTargets[0].modelId }]);
  }, [installedTargets, selectedTargets.length]);

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

  // Same idea for the collapsed Advanced options header — the tuning that is
  // out of sight still reports its current values, so a stale temperature or a
  // set system prompt can't silently shape a run.
  const advancedSummary = useMemo(() => {
    const parts = [];
    if (systemPrompt.trim()) parts.push('system prompt set');
    parts.push(`temp ${numOr(temperature, 0.3)}`);
    parts.push(`${numOr(maxTokens, 1000)} tokens`);
    const timeout = TIMEOUT_OPTIONS.find((option) => option.value === numOr(timeoutMs, 300000));
    if (timeout) parts.push(timeout.short);
    if (activeMode === 'compare') parts.push(runMode === 'parallel' ? 'parallel' : 'round robin');
    return parts.join(' · ');
  }, [activeMode, maxTokens, runMode, systemPrompt, temperature, timeoutMs]);

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
    <ModelsSectionLayout activeTab="playground">
      <div className="flex items-center justify-between gap-3 p-4 border-b border-port-border">
        <div className="flex items-center gap-3 min-w-0">
          <Link to="/models/llms" className="p-2 rounded-lg bg-port-card border border-port-border text-gray-400 hover:text-white" title={`Back to ${getNavPageForPath('/models/llms')?.breadcrumb || 'its management page'}`}>
            <ArrowLeft size={16} />
          </Link>
          <div className="min-w-0">
            <h1 className="text-lg md:text-2xl font-bold text-white truncate">Local LLM Playground</h1>
            <p className="text-xs md:text-sm text-gray-500 truncate">
              {selectedTargets.length} model{selectedTargets.length === 1 ? '' : 's'} selected
              {loadedUnknown && <span className="text-port-warning"> · Memory status unavailable</span>}
              {!loadedUnknown && loadedModels.length > 0 && (
                <span className="text-port-success"> · {loadedModels.length} in memory</span>
              )}
            </p>
          </div>
        </div>
        <button onClick={() => { loadStatus(); loadedResource.refetch(); }} disabled={loadingStatus} className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-2 text-gray-400 hover:text-white transition-colors" title="Refresh models" aria-label="Refresh models">
          <RefreshCw size={16} className={loadingStatus ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* This page keeps its own `/local-llm/playground` path (it predates the
          Models section and lives in ⌘K history), so without the section's tab
          bar arriving here would strand the user outside it. */}
      <ModelsTabsHeader activeTab="playground" />

      <div className="min-h-0 min-w-0 flex-1 overflow-auto p-4 space-y-4">
        <div className="grid grid-cols-1 xl:grid-cols-[320px_1fr] gap-4">
          <PlaygroundModelSidebar
            backends={[...MANAGED_BACKENDS, ...(runtimeRows || []).map((runtime) => runtime.id)]}
            backendLabel={backendLabel}
            installedTargets={installedTargets}
            selectedTargets={selectedTargets}
            toggleTarget={toggleTarget}
            runningKeys={runningKeys}
            getLoadedOllamaModel={(modelId) => loadedByKey.get(normalizeCatalogId('ollama', modelId))}
            offlineRuntimes={offlineRuntimes}
            loadingStatus={loadingStatus}
            modelLoadError={modelLoadError}
            runtimeError={runtimeError}
          />

          <section className="min-w-0 space-y-4">
            <TabPills
              tabs={PLAYGROUND_MODES}
              activeTab={activeMode}
              onChange={setActiveMode}
              variant="pills"
              size="sm"
              ariaLabel="Playground mode"
              controlsIdPrefix="playground-mode-panel"
            />
            <div role="tabpanel" id={`playground-mode-panel-${activeMode}`} aria-labelledby={`tab-${activeMode}`} className="space-y-4">
              <section className="bg-port-card border border-port-border rounded-lg p-4 space-y-4">
                {/* Prompt then Run, with nothing optional between them: the tuning
                    fields used to sit above the action, which put Run below the
                    fold even once the model list was collapsed (#7232). */}
                <div className="space-y-2">
                  <label htmlFor="local-llm-prompt" className="block text-xs text-gray-500">Prompt</label>
                  <textarea
                    id="local-llm-prompt"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={7}
                    className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-port-accent resize-y"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  {busy ? (
                    <button
                      onClick={cancelRun}
                      className="w-full sm:w-auto flex items-center justify-center gap-2 px-4 py-2 bg-port-error/15 hover:bg-port-error/25 text-port-error text-sm font-medium rounded-lg"
                    >
                      <X size={15} />
                      Cancel
                    </button>
                  ) : (
                    <button
                      onClick={activeMode === 'chat' ? runChat : runCompare}
                      disabled={activeMode === 'chat' ? !canRunChat : !canCompare}
                      className="w-full sm:w-auto flex items-center justify-center gap-2 px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent text-sm font-medium rounded-lg disabled:opacity-50"
                    >
                      {activeMode === 'chat' ? <Send size={15} /> : <Play size={15} />}
                      {activeMode === 'chat' ? 'Run chat' : 'Run comparison'}
                    </button>
                  )}
                  {activeMode === 'compare' && selectedTargets.length > 0 && (
                    <span className="text-xs text-gray-500">
                      Runs against {selectedTargets.length} model{selectedTargets.length === 1 ? '' : 's'}
                    </span>
                  )}
                  {/* The run's missing prerequisite is named beside the disabled
                      button rather than left for the user to infer from the
                      collapsed inventory; the effect above has also reopened the
                      picker when the inventory is empty. */}
                  {!loadingStatus && selectedTargets.length === 0 && (
                    <span className="text-xs text-port-warning">
                      {installedTargets.length === 0 ? (
                        <>
                          No local models installed —{' '}
                          <Link to="/models/llms" className="text-port-accent hover:underline">install one</Link>
                          {' '}to run a prompt.
                        </>
                      ) : 'No model selected — pick one under Models.'}
                    </span>
                  )}
                </div>

                <CollapsibleSection
                  id="local-llm-advanced"
                  label="Advanced options"
                  summary={advancedSummary}
                  size="bar"
                  className="border-t border-port-border"
                  bodyClassName="pt-1 pb-1 space-y-3"
                >
                  <div className="space-y-1">
                    <label htmlFor="local-llm-system" className="block text-xs text-gray-500">System prompt</label>
                    <textarea
                      id="local-llm-system"
                      value={systemPrompt}
                      onChange={(e) => setSystemPrompt(e.target.value)}
                      rows={3}
                      className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-port-accent resize-y"
                      placeholder="Optional"
                    />
                  </div>
                  <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))]">
                    <div className="space-y-1">
                      <label className="block text-xs text-gray-500" htmlFor="local-llm-temperature">Temperature</label>
                      <input id="local-llm-temperature" type="number" min="0" max="2" step="0.1" value={temperature} onChange={(e) => setTemperature(e.target.value)} className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white" />
                    </div>
                    <div className="space-y-1">
                      <label className="block text-xs text-gray-500" htmlFor="local-llm-max-tokens">Max tokens</label>
                      <input id="local-llm-max-tokens" type="number" min="1" max="8192" step="64" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white" />
                    </div>
                    <div className="space-y-1">
                      <label className="block text-xs text-gray-500" htmlFor="local-llm-timeout">Timeout</label>
                      <select id="local-llm-timeout" value={timeoutMs} onChange={(e) => setTimeoutMs(Number(e.target.value))} className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white">
                        {TIMEOUT_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </div>
                    {activeMode === 'compare' && (
                      <div className="space-y-1">
                        <label className="block text-xs text-gray-500" htmlFor="local-llm-mode">Execution</label>
                        <select id="local-llm-mode" value={runMode} onChange={(e) => setRunMode(e.target.value)} className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white">
                          <option value="round-robin">Round robin</option>
                          <option value="parallel">Parallel</option>
                        </select>
                      </div>
                    )}
                  </div>
                </CollapsibleSection>
              </section>

              <PlaygroundResults
                activeMode={activeMode}
                streamingChat={streamingChat}
                chatResults={chatResults}
                compareResult={compareResult}
                backendLabel={backendLabel}
              />
            </div>
          </section>
        </div>
      </div>
    </ModelsSectionLayout>
  );
}
