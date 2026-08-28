import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle, ChevronRight, Feather, Lightbulb, Repeat2, RotateCcw, Save, Sparkles, Timer } from 'lucide-react';
import { evaluateRhetoricAttempt, getLoadedLlmModels, submitTrainingEntry, updatePostConfig } from '../../../services/api';
import useProviderModels from '../../../hooks/useProviderModels';
import { isEmbeddingModel, isLocalEndpoint, isLocalInstanceProvider, isOllamaBackedProvider, localBackendForProvider, mergeModelLists } from '../../../utils/providers';
import ProviderModelSelector from '../../ProviderModelSelector';
import toast from '../../ui/Toast';
import { uuidv4 } from '../../../lib/uuid';

const TRAINING_MODULE = 'rhetoric';
const ROUND_SIZE = 5;
const TRAINING_TYPES = {
  meter: 'rhetoric-meter',
  diacope: 'rhetoric-diacope',
  chiasmus: 'rhetoric-chiasmus',
  progressia: 'rhetoric-progressia',
  brainstorm: 'rhetoric-brainstorm',
};

export const RHETORIC_MODES = [
  {
    id: 'meter', label: 'Iambic Pentameter', icon: Timer, color: 'text-cyan-400', bgColor: 'bg-cyan-500/20',
    description: 'Write a ten-syllable line with a rising da-DUM pulse.',
    example: 'The rain returns to silver every street.',
    prompts: [
      'Write a line about an empty train station.',
      'Write a line that turns from doubt to hope.',
      'Write a line containing the word “winter”.',
      'Write a line spoken by someone keeping a secret.',
      'Write a line that ends on a strong one-syllable noun.',
    ],
    checklist: ['about ten syllables', 'mostly iambic (da-DUM) feet', 'a clear image or thought'],
  },
  {
    id: 'diacope', label: 'Diacope', icon: Feather, color: 'text-amber-400', bgColor: 'bg-amber-500/20',
    description: 'Make emphasis through repetition separated by a word or phrase.',
    example: 'Run, for the door is closing. Run!',
    prompts: [
      'Write a warning using “stay”.',
      'Write a plea using “listen”.',
      'Write a defiant line using “no”.',
      'Write a comic line using “again”.',
      'Write a sentence where the repeated word changes meaning.',
    ],
    checklist: ['the repeated word is exact or intentionally varied', 'a meaningful gap separates the repetitions', 'the repetition adds urgency or emphasis'],
  },
  {
    id: 'chiasmus', label: 'Chiasmus', icon: Repeat2, color: 'text-rose-400', bgColor: 'bg-rose-500/20',
    description: 'Cross a phrase’s terms or structure so the second half mirrors the first in reverse.',
    example: 'We shape our tools, and thereafter our tools shape us.',
    prompts: [
      'Write a line about learning that reverses its key terms.',
      'Turn a choice between freedom and safety into a crossed sentence.',
      'Write a compact chiasmus about listening and speaking.',
      'Use a reversal to show a friendship changing over time.',
      'Write a comic chiasmus about making plans and plans making trouble.',
    ],
    checklist: ['two paired terms or structures appear in reverse order', 'the reversal changes or sharpens the thought', 'the syntax stays clear when read aloud'],
  },
  {
    id: 'progressia', label: 'Progressia', icon: ChevronRight, color: 'text-purple-400', bgColor: 'bg-purple-500/20',
    description: 'Build an idea step by step until the final phrase lands harder.',
    example: 'A spark became a flame, a flame became a signal.',
    prompts: [
      'Escalate a whisper into a public alarm.',
      'Build a three-step progression from want to need to obsession.',
      'Turn a small kindness into a changed life.',
      'Escalate a disagreement without using the word “anger”.',
      'Build from a single drop of water to a flood.',
    ],
    checklist: ['at least three discernible steps', 'each step intensifies or transforms the last', 'the final step feels earned'],
  },
  {
    id: 'brainstorm', label: 'Rhetorical Brainstorm', icon: Lightbulb, color: 'text-green-400', bgColor: 'bg-green-500/20',
    description: 'Generate several angles quickly, then choose the one with voltage.',
    example: 'One subject, three stances: praise it, attack it, confess about it.',
    prompts: [
      'Brainstorm three openings for a story about a locked room.',
      'Argue for, against, and sideways about convenience.',
      'Find three metaphors for a difficult conversation.',
      'Write three headlines for the same surprising event.',
      'Describe one ordinary object as sacred, dangerous, and ridiculous.',
    ],
    checklist: ['at least three distinct attempts', 'the angles are genuinely different', 'one version takes an unexpected turn'],
  },
];

const modeFor = (id) => RHETORIC_MODES.find((mode) => mode.id === id) || null;
const newRoundId = () => uuidv4();
const evaluatorProviderFilter = (provider) => provider?.enabled !== false;
const LOCAL_MODEL_BACKENDS = [
  { id: 'ollama', label: 'Ollama' },
  { id: 'lmstudio', label: 'LM Studio' },
];
const EMBEDDING_CAPABILITIES = new Set(['embedding', 'embeddings']);

const isGenerationLoadedModel = (model) => {
  const type = typeof model?.type === 'string' ? model.type.toLowerCase() : '';
  if (EMBEDDING_CAPABILITIES.has(type)) return false;
  if (Array.isArray(model?.capabilities) && model.capabilities.length > 0) {
    return !model.capabilities.some((capability) => EMBEDDING_CAPABILITIES.has(String(capability).toLowerCase()));
  }
  if (type) return true;
  return !isEmbeddingModel(model?.id || model?.name || '');
};

const normalizeLoadedLocalModels = (status, sourceErrors = []) => LOCAL_MODEL_BACKENDS.flatMap(({ id: backend, label }) => (
  !sourceErrors.includes(backend) && Array.isArray(status?.[backend])
    ? status[backend]
      .filter((model) => typeof model?.id === 'string' && model.id.trim())
      .map((model) => ({
        backend,
        backendLabel: label,
        id: model.id,
        name: model.name || model.id,
        type: model.type,
        capabilities: model.capabilities,
      }))
    : []
));

const configuredProviderEndpoints = (provider) => {
  const endpoints = [];
  if (typeof provider?.endpoint === 'string' && provider.endpoint.trim()) endpoints.push(provider.endpoint);
  const anthropicBaseUrl = provider?.envVars?.ANTHROPIC_BASE_URL;
  if (typeof anthropicBaseUrl === 'string' && anthropicBaseUrl.trim()) endpoints.push(anthropicBaseUrl);
  const openCodeConfig = provider?.envVars?.OPENCODE_CONFIG_CONTENT;
  if (typeof openCodeConfig === 'string' && openCodeConfig.trim()) {
    const openCodeEndpoints = [...openCodeConfig.matchAll(/"baseURL"\s*:\s*"([^"]+)"/g)].map((match) => match[1]);
    if (openCodeEndpoints.length === 0) return null;
    endpoints.push(...openCodeEndpoints);
  }
  return endpoints;
};

const backendForProvider = (provider) => {
  if (!provider || !isLocalInstanceProvider(provider)) return null;
  const endpoints = configuredProviderEndpoints(provider);
  if (!endpoints || endpoints.some((endpoint) => !isLocalEndpoint(endpoint))) return null;
  return isOllamaBackedProvider(provider) ? 'ollama' : localBackendForProvider(provider);
};

const pickLoadedEvaluatorModel = (models, providers, activeProviderId, sourceErrors) => {
  const available = models.filter((model) => (
    !sourceErrors.includes(model.backend)
    && isGenerationLoadedModel(model)
    && providers.some((provider) => backendForProvider(provider) === model.backend)
  ));
  const activeBackend = backendForProvider(providers.find((provider) => provider.id === activeProviderId));
  const selected = available.find((model) => model.backend === activeBackend) || available[0] || null;
  if (!selected) return null;
  const provider = providers.find((candidate) => (
    candidate.id === activeProviderId && backendForProvider(candidate) === selected.backend
  )) || providers.find((candidate) => backendForProvider(candidate) === selected.backend);
  return provider ? { ...selected, providerId: provider.id } : null;
};

function EvaluatorReport({ results, enabled }) {
  if (!enabled) return null;
  const evaluated = results.filter((result) => result.evaluation);
  const pending = results.filter((result) => !result.evaluation && !result.evaluationError).length;
  const average = evaluated.length
    ? Math.round(evaluated.reduce((sum, result) => sum + result.evaluation.overallScore, 0) / evaluated.length)
    : null;
  return (
    <div className="mt-6 text-left border-t border-port-border pt-5 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-port-accent" />
          <h4 className="font-medium text-white">Evaluator report</h4>
        </div>
        <span className="text-xs text-gray-500">
          {pending > 0 ? `${pending} still evaluating…` : `${evaluated.length}/${results.length} evaluated`}
          {average != null ? ` · ${average}% average` : ''}
        </span>
      </div>
      <p className="text-xs text-gray-500">
        The evaluator ran after each save, while the next prompt was available. Its score is separate from your self-score.
      </p>
      <div className="space-y-2">
        {results.map((result, index) => (
          <div key={result.id} className="rounded-lg bg-port-bg border border-port-border p-3">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-gray-500">Attempt {index + 1}</span>
              <span className="text-gray-500">self {result.rating}/5</span>
              {result.evaluation && <span className="ml-auto text-port-accent">AI {result.evaluation.overallScore}%</span>}
              {!result.evaluation && !result.evaluationError && <span className="ml-auto text-gray-500">working…</span>}
            </div>
            {result.evaluation
              ? <>
                <p className="mt-2 text-sm text-gray-300">{result.evaluation.summary}</p>
                <div className="mt-2 grid gap-1 sm:grid-cols-3">
                  {result.evaluation.dimensions.map((dimension) => (
                    <div key={dimension.id} className="text-[11px] text-gray-500">
                      <span className="text-gray-400">{dimension.id}</span> · {dimension.score}%
                      <span className="block text-gray-600">{dimension.feedback}</span>
                    </div>
                  ))}
                </div>
              </>
              : result.evaluationError && <p className="mt-2 text-xs text-amber-400">Evaluation unavailable: {result.evaluationError}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

function RhetoricEvaluatorConfig({
  config,
  providers,
  providerId,
  model,
  effort,
  availableModels,
  enabled,
  onProviderChange,
  onModelChange,
  onEffortChange,
  onEnabledChange,
  saving,
  error,
  onSave,
  localModelStatus,
}) {
  const saved = config?.rhetoricEvaluator?.enabled === true;
  return (
    <section className="bg-port-card border border-port-border rounded-xl p-5 space-y-4">
      <div className="flex items-start gap-3">
        <span className="rounded-lg p-2 bg-port-accent/15"><Sparkles size={18} className="text-port-accent" /></span>
        <div>
          <h3 className="font-semibold text-white">Optional AI evaluator</h3>
          <p className="mt-1 text-sm text-gray-400">
            Score each attempt in the background while you answer the next prompt. The completed round keeps the report and provider/model/effort provenance in POST training history.
          </p>
        </div>
      </div>
      <label htmlFor="rhetoric-evaluator-enabled" className="flex items-start gap-3 text-sm text-gray-300 cursor-pointer">
        <input
          id="rhetoric-evaluator-enabled"
          type="checkbox"
          checked={enabled}
          onChange={(event) => onEnabledChange(event.target.checked)}
          className="mt-0.5 accent-port-accent"
        />
        <span>
          Evaluate rhetoric attempts after save
          <span className="block text-xs text-gray-500 mt-0.5">Off by default. Saving this setting is the consent gate for background provider calls.</span>
        </span>
      </label>
      {localModelStatus.state === 'loading' && (
        <p className="text-xs text-gray-500" role="status">Checking which local models are loaded…</p>
      )}
      {localModelStatus.models.length > 0 && (
        <div className="rounded-lg border border-port-accent/30 bg-port-accent/5 px-3 py-2.5" role="status">
          <div className="text-xs font-medium text-port-accent">Loaded local models</div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-300">
            {localModelStatus.models.map((model) => (
              <span key={`${model.backend}:${model.id}`}>{model.name} · {model.backendLabel}</span>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-gray-500">A loaded model is preselected when there is no saved evaluator choice, avoiding a cold start.</p>
        </div>
      )}
      {localModelStatus.state === 'ready' && localModelStatus.models.length === 0 && localModelStatus.sourceErrors.length === 0 && (
        <p className="text-xs text-gray-500">No local models are loaded right now. Selecting one later may require a cold start.</p>
      )}
      {localModelStatus.sourceErrors.length > 0 && (
        <p className="text-xs text-amber-400" role="status">
          Couldn&apos;t verify residency for {localModelStatus.sourceErrors.map((backend) => LOCAL_MODEL_BACKENDS.find((entry) => entry.id === backend)?.label || backend).join(', ')}. Loaded-model information may be partial.
        </p>
      )}
      <ProviderModelSelector
        providers={providers}
        selectedProviderId={providerId}
        selectedModel={model}
        availableModels={availableModels}
        onProviderChange={onProviderChange}
        onModelChange={onModelChange}
        onEffortChange={onEffortChange}
        effort={effort}
        emptyProviderOption="Use active provider"
        emptyModelOption="Provider default"
        alwaysShowModel
        layout="stacked"
        disabled={saving}
      />
      {providers.length === 0 && <p className="text-xs text-gray-500">No enabled providers are available yet. You can save the active-provider choice and configure one later.</p>}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="inline-flex items-center gap-2 min-h-[44px] px-4 py-2 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
        >
          <Save size={15} /> {saving ? 'Saving…' : 'Save evaluator'}
        </button>
        {saved && !saving && <span className="text-xs text-emerald-400">Enabled for the next round</span>}
        {error && <span className="text-xs text-amber-400" role="alert">{error}</span>}
      </div>
    </section>
  );
}

export default function RhetoricTrainer({ mode, onSelectMode, onExitMode, onBack, onContinue, config, onConfigUpdate }) {
  const selectedMode = modeFor(mode);
  const [promptIndex, setPromptIndex] = useState(0);
  const [response, setResponse] = useState('');
  const [rating, setRating] = useState(null);
  const [results, setResults] = useState([]);
  const [saving, setSaving] = useState(false);
  const [evaluatorSaving, setEvaluatorSaving] = useState(false);
  const [evaluatorSaveError, setEvaluatorSaveError] = useState('');
  const [localModelStatus, setLocalModelStatus] = useState({ state: 'loading', models: [], sourceErrors: [] });
  const savedEvaluator = config?.rhetoricEvaluator || {};
  const hasSavedEvaluatorChoice = savedEvaluator.providerId != null || savedEvaluator.model != null;
  const [evaluatorEnabled, setEvaluatorEnabled] = useState(savedEvaluator.enabled === true);
  const [evaluatorEffort, setEvaluatorEffort] = useState(savedEvaluator.effort || '');
  const evaluatorSelectionTouchedRef = useRef(false);
  const evaluatorAutoSelectionRef = useRef(false);
  const {
    providers,
    activeProviderId: evaluatorActiveProviderId,
    selectedProviderId: evaluatorProviderId,
    selectedModel: evaluatorModel,
    availableModels: evaluatorModels,
    setSelectedProviderId: setEvaluatorProviderId,
    setSelectedModel: setEvaluatorModel,
  } = useProviderModels({ filter: evaluatorProviderFilter, allowDefault: true, silent: true, withEffort: true });
  const evaluatorBackend = backendForProvider(providers.find((provider) => provider.id === evaluatorProviderId));
  const evaluatorAvailableModels = useMemo(() => mergeModelLists(
    evaluatorModels,
    localModelStatus.models
      .filter((model) => model.backend === evaluatorBackend && isGenerationLoadedModel(model))
      .map((model) => model.id),
  ), [evaluatorBackend, evaluatorModels, localModelStatus.models]);
  const roundStart = useRef(Date.now());
  const promptStart = useRef(Date.now());
  const roundIdRef = useRef(newRoundId());
  const resultsByRoundRef = useRef(new Map([[roundIdRef.current, []]]));
  const evaluatorTailRef = useRef(Promise.resolve());
  const roundEvaluationPromisesRef = useRef([]);

  useEffect(() => {
    const nextRoundId = newRoundId();
    roundIdRef.current = nextRoundId;
    resultsByRoundRef.current.set(nextRoundId, []);
    roundEvaluationPromisesRef.current = [];
    setPromptIndex(0);
    setResponse('');
    setRating(null);
    setResults([]);
    setSaving(false);
    setEvaluatorSaveError('');
    roundStart.current = Date.now();
    promptStart.current = Date.now();
  }, [selectedMode?.id]);

  useEffect(() => {
    setEvaluatorEnabled(savedEvaluator.enabled === true);
    if (
      !evaluatorSelectionTouchedRef.current
      && (hasSavedEvaluatorChoice || !evaluatorAutoSelectionRef.current)
    ) {
      setEvaluatorProviderId(savedEvaluator.providerId || '');
      setEvaluatorModel(savedEvaluator.model || '');
    }
    setEvaluatorEffort(savedEvaluator.effort || '');
  }, [hasSavedEvaluatorChoice, savedEvaluator.enabled, savedEvaluator.providerId, savedEvaluator.model, savedEvaluator.effort]);

  useEffect(() => {
    if (selectedMode) return undefined;
    let canceled = false;
    setLocalModelStatus({ state: 'loading', models: [], sourceErrors: [] });
    getLoadedLlmModels({ silent: true })
      .then((status) => {
        if (canceled) return;
        const listsValid = LOCAL_MODEL_BACKENDS.every(({ id }) => Array.isArray(status?.[id]));
        const sourceErrors = Array.isArray(status?.sourceErrors)
          ? status.sourceErrors.filter((backend) => LOCAL_MODEL_BACKENDS.some((entry) => entry.id === backend))
          : [];
        setLocalModelStatus({
          state: listsValid ? 'ready' : 'unavailable',
          models: normalizeLoadedLocalModels(status, sourceErrors),
          sourceErrors: sourceErrors.length > 0
            ? sourceErrors
            : (listsValid ? [] : LOCAL_MODEL_BACKENDS.map(({ id }) => id)),
        });
      })
      .catch(() => {
        if (!canceled) setLocalModelStatus({ state: 'unavailable', models: [], sourceErrors: LOCAL_MODEL_BACKENDS.map(({ id }) => id) });
      });
    return () => { canceled = true; };
  }, [selectedMode?.id]);

  useEffect(() => {
    if (
      selectedMode
      || localModelStatus.state !== 'ready'
      || evaluatorSelectionTouchedRef.current
      || evaluatorAutoSelectionRef.current
      || hasSavedEvaluatorChoice
    ) return;
    const loaded = pickLoadedEvaluatorModel(
      localModelStatus.models,
      providers,
      evaluatorActiveProviderId,
      localModelStatus.sourceErrors,
    );
    if (!loaded) return;
    evaluatorAutoSelectionRef.current = true;
    setEvaluatorProviderId(loaded.providerId);
    setEvaluatorModel(loaded.id);
  }, [
    evaluatorActiveProviderId,
    localModelStatus,
    providers,
    hasSavedEvaluatorChoice,
    selectedMode,
    setEvaluatorModel,
    setEvaluatorProviderId,
  ]);

  const prompt = selectedMode?.prompts[promptIndex];
  const completed = results.length;
  const average = useMemo(() => completed
    ? Math.round(results.reduce((sum, result) => sum + result.rating, 0) / completed * 20)
    : 0, [completed, results]);

  function replaceRoundResults(roundId, nextResults) {
    resultsByRoundRef.current.set(roundId, nextResults);
    if (roundId === roundIdRef.current) {
      setResults(nextResults);
    }
  }

  function enqueueEvaluation(attempt, roundId) {
    const evaluator = config?.rhetoricEvaluator;
    if (evaluator?.enabled !== true) return null;
    const request = {
      attemptId: attempt.id,
      mode: selectedMode.id,
      prompt: attempt.prompt,
      response: attempt.response,
      ...(evaluator.providerId && { providerId: evaluator.providerId }),
      ...(evaluator.model && { model: evaluator.model }),
      ...(evaluator.effort && { effort: evaluator.effort }),
    };
    const queued = evaluatorTailRef.current.then(() => evaluateRhetoricAttempt(request, { silent: true }));
    // Keep the serial queue alive after one provider failure. The failed request
    // is shown on its own attempt, while the next answer still gets evaluated.
    evaluatorTailRef.current = queued.catch(() => null);
    roundEvaluationPromisesRef.current.push(queued);
    queued.then((result) => {
      const current = resultsByRoundRef.current.get(roundId) || [];
      replaceRoundResults(roundId, current.map((item) => item.id === attempt.id
        ? { ...item, evaluation: result.evaluation }
        : item));
    }).catch((error) => {
      const message = String(error?.message || error || 'Unknown evaluator error').slice(0, 500);
      const current = resultsByRoundRef.current.get(roundId) || [];
      replaceRoundResults(roundId, current.map((item) => item.id === attempt.id
        ? { ...item, evaluationError: message }
        : item));
    });
    return queued;
  }

  function resetRound() {
    const nextRoundId = newRoundId();
    roundIdRef.current = nextRoundId;
    resultsByRoundRef.current.set(nextRoundId, []);
    roundEvaluationPromisesRef.current = [];
    setPromptIndex(0);
    setResponse('');
    setRating(null);
    setResults([]);
    setSaving(false);
    setEvaluatorSaveError('');
    roundStart.current = Date.now();
    promptStart.current = Date.now();
  }

  function finishRound(roundId, nextResults, roundStartedAt) {
    const pendingEvaluations = roundEvaluationPromisesRef.current.slice();
    const roundTotalMs = Math.max(0, Date.now() - roundStartedAt);
    setSaving(true);
    Promise.allSettled(pendingEvaluations)
      .then(() => {
        const finalResults = resultsByRoundRef.current.get(roundId) || nextResults;
        return submitTrainingEntry({
          module: TRAINING_MODULE,
          drillType: TRAINING_TYPES[selectedMode.id],
          score: Math.round(finalResults.reduce((sum, result) => sum + result.rating, 0) / finalResults.length * 20),
          questionCount: finalResults.length,
          correctCount: finalResults.filter((result) => result.rating >= 4).length,
          totalMs: roundTotalMs,
          scorerProvenance: config?.rhetoricEvaluator?.enabled === true
            ? 'post-rhetoric-self+ai'
            : 'post-rhetoric-self',
          questions: finalResults.map((result) => ({
            id: result.id,
            prompt: result.prompt,
            response: result.response,
            responseMs: result.responseMs,
            selfRating: result.rating,
            score: result.rating * 20,
            correct: result.rating >= 4,
            ...(result.evaluation && { evaluation: result.evaluation }),
            ...(result.evaluationError && { evaluationError: result.evaluationError }),
          })),
        }, { silent: true });
      })
      .catch((error) => {
        if (roundId === roundIdRef.current) setEvaluatorSaveError(String(error?.message || error || 'Could not save this round').slice(0, 500));
      })
      .finally(() => {
        if (roundId === roundIdRef.current) setSaving(false);
      });
  }

  function submitResponse() {
    if (!response.trim() || rating == null) return;
    const roundId = roundIdRef.current;
    const attempt = {
      id: `${roundId}:${results.length + 1}`,
      prompt,
      response: response.trim(),
      rating,
      responseMs: Math.max(0, Date.now() - promptStart.current),
    };
    const nextResults = [...results, attempt];
    replaceRoundResults(roundId, nextResults);
    enqueueEvaluation(attempt, roundId);
    setResponse(''); setRating(null);
    if (nextResults.length >= ROUND_SIZE) finishRound(roundId, nextResults, roundStart.current);
    else {
      setPromptIndex((index) => index + 1);
      promptStart.current = Date.now();
    }
  }

  function saveEvaluator() {
    setEvaluatorSaving(true);
    setEvaluatorSaveError('');
    updatePostConfig({
      rhetoricEvaluator: {
        enabled: evaluatorEnabled,
        providerId: evaluatorProviderId || null,
        model: evaluatorModel || null,
        effort: evaluatorEffort || null,
      },
    }, { silent: true })
      .then((updated) => {
        onConfigUpdate?.(updated);
        toast.success('Rhetoric evaluator settings saved');
      })
      .catch((error) => setEvaluatorSaveError(String(error?.message || error || 'Could not save evaluator settings').slice(0, 500)))
      .finally(() => setEvaluatorSaving(false));
  }

  if (!selectedMode) {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <button type="button" onClick={onBack} className="flex items-center gap-2 text-sm text-gray-400 hover:text-white"><ArrowLeft size={16} /> POST launcher</button>
        <div>
          <div className="flex items-center gap-3"><Feather className="text-port-accent" size={28} /><h2 className="text-2xl font-bold text-white">Rhetoric practice</h2></div>
          <p className="mt-2 text-gray-400 max-w-2xl">Train the small structures that make language memorable. Each round gives you five prompts, a compact craft checklist, and space to make the attempt your own.</p>
        </div>
        <RhetoricEvaluatorConfig
          config={config}
          providers={providers}
          providerId={evaluatorProviderId}
          model={evaluatorModel}
          effort={evaluatorEffort}
          availableModels={evaluatorAvailableModels}
          enabled={evaluatorEnabled}
          onProviderChange={(value) => {
            evaluatorSelectionTouchedRef.current = true;
            setEvaluatorProviderId(value);
            setEvaluatorEffort('');
          }}
          onModelChange={(value) => {
            evaluatorSelectionTouchedRef.current = true;
            setEvaluatorModel(value);
          }}
          onEffortChange={setEvaluatorEffort}
          onEnabledChange={setEvaluatorEnabled}
          saving={evaluatorSaving}
          error={evaluatorSaveError}
          onSave={saveEvaluator}
          localModelStatus={localModelStatus}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          {RHETORIC_MODES.map((entry) => {
            const Icon = entry.icon;
            return <button key={entry.id} type="button" onClick={() => onSelectMode(entry.id)} className="text-left bg-port-card border border-port-border rounded-xl p-5 hover:border-port-accent/70 transition-colors">
              <div className="flex items-center gap-3"><span className={`rounded-lg p-2 ${entry.bgColor}`}><Icon size={20} className={entry.color} /></span><h3 className="font-semibold text-white">{entry.label}</h3></div>
              <p className="mt-3 text-sm text-gray-400">{entry.description}</p>
              <p className="mt-3 text-xs text-gray-500">Example: {entry.example}</p>
            </button>;
          })}
        </div>
      </div>
    );
  }

  const Icon = selectedMode.icon;
  const roundComplete = completed >= ROUND_SIZE;
  return <div className="max-w-3xl mx-auto space-y-5">
    <div className="flex items-center justify-between gap-3">
      <button type="button" onClick={onExitMode} className="flex items-center gap-2 text-sm text-gray-400 hover:text-white"><ArrowLeft size={16} /> All rhetoric exercises</button>
      <span className="text-xs text-gray-500">{completed}/{ROUND_SIZE} attempts</span>
    </div>
    <div className="bg-port-card border border-port-border rounded-xl p-5">
      <div className="flex items-start justify-between gap-4"><div><div className="flex items-center gap-2"><Icon size={18} className={selectedMode.color} /><h2 className="text-xl font-semibold text-white">{selectedMode.label}</h2></div><p className="mt-2 text-sm text-gray-400">{selectedMode.description}</p></div><div className="text-right text-xs text-gray-500">Self-score<br /><span className="text-white">{average}%</span></div></div>
      {!roundComplete ? <>
        <div className="mt-6 rounded-lg bg-port-bg border border-port-border p-4"><div className="text-xs uppercase tracking-wide text-port-accent mb-2">Prompt {promptIndex + 1}</div><p className="text-lg text-white">{prompt}</p></div>
        <label htmlFor="rhetoric-response" className="block mt-5 text-sm text-gray-300">Your attempt</label>
        <textarea id="rhetoric-response" value={response} onChange={(event) => setResponse(event.target.value)} maxLength={10000} rows={5} autoFocus placeholder="Write without over-editing. The first live version is useful data." className="mt-2 w-full bg-port-bg border border-port-border rounded-lg px-3 py-3 text-white placeholder-gray-600 focus:outline-none focus:border-port-accent resize-y" />
        <div className="mt-4"><p className="text-sm text-gray-400 mb-2">How well did it meet the craft goal?</p><div className="flex flex-wrap gap-2">{[1, 2, 3, 4, 5].map((value) => <button key={value} type="button" onClick={() => setRating(value)} aria-label={`Rate ${value} out of 5`} className={`px-4 py-2 rounded border text-sm ${rating === value ? 'border-port-accent bg-port-accent/20 text-white' : 'border-port-border text-gray-400 hover:text-white'}`}>{value}</button>)}</div></div>
        <div className="mt-5 border-t border-port-border pt-4"><p className="text-xs text-gray-500 mb-2">Quick check</p><ul className="grid gap-1 sm:grid-cols-3 text-xs text-gray-400">{selectedMode.checklist.map((item) => <li key={item}>· {item}</li>)}</ul></div>
        <button type="button" onClick={submitResponse} disabled={!response.trim() || rating == null} className="mt-5 w-full rounded-lg bg-port-accent hover:bg-port-accent/80 disabled:opacity-40 disabled:cursor-not-allowed text-white py-2.5 font-medium">Save attempt &amp; next</button>
      </> : <div className="mt-6 text-center py-8">
        <CheckCircle size={42} className="mx-auto text-port-success" />
        <h3 className="mt-3 text-xl font-semibold text-white">Round complete</h3>
        <p className="mt-2 text-gray-400">You rated this round {average}%. Notice which structure felt easiest to reach for.</p>
        <EvaluatorReport results={results} enabled={savedEvaluator.enabled === true} />
        {evaluatorSaveError && <p className="mt-3 text-xs text-amber-400" role="alert">{evaluatorSaveError}</p>}
        <div className="flex gap-3 justify-center mt-6 flex-wrap">
          <button type="button" onClick={resetRound} className="flex items-center gap-2 min-h-[44px] px-4 py-2 rounded-lg border border-port-border text-gray-300 hover:text-white"><RotateCcw size={16} /> New round</button>
          <button type="button" onClick={onContinue} disabled={saving} className="min-h-[44px] px-4 py-2 rounded-lg bg-port-accent text-white disabled:opacity-50">{saving ? 'Saving report…' : 'Continue POST'}</button>
        </div>
      </div>}
    </div>
  </div>;
}
