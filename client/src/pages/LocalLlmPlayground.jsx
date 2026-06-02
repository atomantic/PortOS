import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRightLeft, Check, Clock, Copy, Gauge, MessageSquare, Play, RefreshCw, Send, TriangleAlert, X } from 'lucide-react';
import BrailleSpinner from '../components/BrailleSpinner';
import toast from '../components/ui/Toast';
import { copyToClipboard } from '../lib/clipboard';
import { localLlmTargetKey } from '../lib/localLlmTargetKey';
import { compareLocalLlmModels, getLocalLlmStatus, testLocalLlmModel } from '../services/api';

const BACKEND_LABEL = { ollama: 'Ollama', lmstudio: 'LM Studio' };
const DEFAULT_PROMPT = 'Write a short, vivid paragraph about a lighthouse computer waking up at dawn.';

function formatMs(ms) {
  if (ms == null) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatRate(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${value.toFixed(value >= 10 ? 1 : 2)} chars/s`;
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
          <pre className="text-sm text-gray-200 whitespace-pre-wrap break-words font-sans leading-relaxed max-h-72 overflow-auto">{result.text}</pre>
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

export default function LocalLlmPlayground() {
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [modelLoadError, setModelLoadError] = useState('');
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
  const [compareResult, setCompareResult] = useState(null);

  const mountedRef = useRef(true);
  // Holds the AbortController for the in-flight run so the Cancel button can
  // abort the client fetch (which closes the server-side stream early). Cleared
  // in each run's .finally(). Abort the live request on unmount too.
  const runControllerRef = useRef(null);
  useEffect(() => () => {
    mountedRef.current = false;
    runControllerRef.current?.abort();
  }, []);

  const cancelRun = () => runControllerRef.current?.abort();

  const loadStatus = useCallback(() => {
    setLoadingStatus(true);
    setModelLoadError('');
    return getLocalLlmStatus({ silent: true })
      .then(setStatus)
      .catch((err) => setModelLoadError(err?.message || 'Failed to load local models'))
      .finally(() => setLoadingStatus(false));
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const installedTargets = useMemo(() => {
    const models = [];
    for (const backend of ['ollama', 'lmstudio']) {
      for (const model of status?.[backend]?.models || []) {
        models.push({ backend, modelId: model.id, name: model.name || model.id, meta: model });
      }
    }
    return models;
  }, [status]);

  useEffect(() => {
    if (selectedTargets.length > 0 || installedTargets.length === 0) return;
    setSelectedTargets([{ backend: installedTargets[0].backend, modelId: installedTargets[0].modelId }]);
  }, [installedTargets, selectedTargets.length]);

  const selectedKeys = useMemo(() => new Set(selectedTargets.map(localLlmTargetKey)), [selectedTargets]);
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
    testLocalLlmModel({ ...target, prompt: prompt.trim(), ...options() }, { silent: true, signal: controller.signal })
      .then((result) => {
        if (!mountedRef.current) return;
        setChatResults((prev) => [result, ...prev]);
        if (result.error) toast.error(result.error);
      })
      // A user-initiated cancel rejects the fetch with AbortError — don't surface
      // it as a failure; the request was stopped on purpose.
      .catch((err) => { if (mountedRef.current && !controller.signal.aborted) toast.error(err?.message || 'Model test failed'); })
      .finally(() => {
        if (runControllerRef.current === controller) runControllerRef.current = null;
        if (mountedRef.current) setBusy(false);
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
            <h1 className="text-2xl font-bold text-white">Local LLM Playground</h1>
            <p className="text-sm text-gray-500 truncate">{selectedTargets.length} model{selectedTargets.length === 1 ? '' : 's'} selected</p>
          </div>
        </div>
        <button onClick={loadStatus} disabled={loadingStatus} className="p-2 text-gray-400 hover:text-white transition-colors" title="Refresh models" aria-label="Refresh models">
          <RefreshCw size={16} className={loadingStatus ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        <div className="grid grid-cols-1 xl:grid-cols-[320px_1fr] gap-4">
          <aside className="bg-port-card border border-port-border rounded-lg p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-gray-300">Models</h2>
              {loadingStatus && <BrailleSpinner />}
            </div>
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
                        return (
                          <button
                            key={localLlmTargetKey(target)}
                            onClick={() => toggleTarget(target)}
                            className={`w-full min-h-12 flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${selected ? 'border-port-accent/60 bg-port-accent/10' : 'border-port-border bg-port-bg hover:border-gray-600'}`}
                          >
                            <span className={`w-5 h-5 rounded border flex items-center justify-center shrink-0 ${selected ? 'border-port-accent bg-port-accent/20 text-port-accent' : 'border-gray-600 text-transparent'}`}>
                              <Check size={13} />
                            </span>
                            <span className="min-w-0">
                              <span className="block text-sm text-white truncate">{target.name}</span>
                              <span className="block text-xs text-gray-500 truncate">{target.modelId}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
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
                {chatResults.length === 0 ? (
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
