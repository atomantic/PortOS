import { useState, useRef, useCallback, useEffect } from 'react';
import { ArrowLeft, Link, Puzzle, BookOpen, Shuffle, CheckCircle, XCircle, ChevronRight, Sparkles } from 'lucide-react';
import {
  generatePostDrill, scorePostLlmDrill, getPostDrillCacheStatus, fillPostDrillCache, updatePostConfig,
} from '../../../services/api';
import { enabledApiProviderFilter } from '../../../utils/providers';
import useProviderModels from '../../../hooks/useProviderModels';
import ProviderModelSelector from '../../ProviderModelSelector';
import Modal from '../../ui/Modal';
import toast from '../../ui/Toast';
import { AILoadingIndicator, MissedExamplesDisplay, CompoundChainUI, BridgeWordUI, DoubleMeaningUI, IdiomTwistUI, ProgressBar } from './WordplayDrillUI';

const GAME_MODES = [
  {
    id: 'compound-chain',
    label: 'Compound Chain',
    icon: Link,
    color: 'text-purple-400',
    bgColor: 'bg-purple-500/20',
    description: 'List compound words using a root word',
    example: 'fire → firehouse, firewall, campfire...',
  },
  {
    id: 'bridge-word',
    label: 'Bridge Word',
    icon: Puzzle,
    color: 'text-cyan-400',
    bgColor: 'bg-cyan-500/20',
    description: 'Find the word connecting multiple phrases',
    example: 'news___, ___back, ___weight → paper',
  },
  {
    id: 'double-meaning',
    label: 'Double Meaning',
    icon: BookOpen,
    color: 'text-amber-400',
    bgColor: 'bg-amber-500/20',
    description: 'Use both meanings of a word in one sentence',
    example: 'bark: tree covering + dog sound',
  },
  {
    id: 'idiom-twist',
    label: 'Idiom Twist',
    icon: Shuffle,
    color: 'text-green-400',
    bgColor: 'bg-green-500/20',
    description: 'Adapt idioms to new domains with wordplay',
    example: '"Don\'t put all eggs in one basket" → programming',
  },
];

export default function WordplayTrainer({ onBack, config, onConfigUpdate }) {
  const [selectedMode, setSelectedMode] = useState(null);
  const [drill, setDrill] = useState(null);
  const [loading, setLoading] = useState(false);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [inputValue, setInputValue] = useState('');
  const [items, setItems] = useState([]);
  const [feedback, setFeedback] = useState(null);
  const [results, setResults] = useState([]);
  const inputRef = useRef(null);
  const questionStartRef = useRef(Date.now());

  // Cache-fill consent: PortOS never issues background LLM calls a user
  // hasn't asked for. A mode whose drill cache is cold (0 cached) prompts
  // for provider/model + explicit consent before any bulk generation runs.
  // Modes primed this session (either filled or explicitly skipped) don't
  // re-prompt even if the server-side count is still catching up.
  const [cacheStatus, setCacheStatus] = useState(null);
  const [primedModes, setPrimedModes] = useState(() => new Set());
  const [pendingMode, setPendingMode] = useState(null);
  const {
    providers, selectedProviderId: fillProviderId, selectedModel: fillModel,
    availableModels: fillModels, setSelectedProviderId: setFillProviderId, setSelectedModel: setFillModel,
  } = useProviderModels({ filter: enabledApiProviderFilter, allowDefault: true, silent: true });

  useEffect(() => {
    getPostDrillCacheStatus().then(setCacheStatus).catch(() => setCacheStatus({}));
  }, []);

  // providers loads asynchronously (useProviderModels' mount-time fetch). If
  // the user opens the consent modal before it resolves, startMode's one-shot
  // seed below falls back to "System Default" even when the saved provider
  // would have been selectable. Re-seed reactively once providers arrives
  // while the modal is still open, so a fast click doesn't permanently miss
  // pre-filling a valid saved default.
  useEffect(() => {
    if (!pendingMode || !providers.length) return;
    const savedProviderId = config?.llmDrills?.providerId || '';
    if (providers.some(p => p.id === savedProviderId)) {
      setFillProviderId(savedProviderId);
      setFillModel(config?.llmDrills?.model || '');
    }
  }, [providers, pendingMode]);

  const providerId = config?.llmDrills?.providerId || null;
  const model = config?.llmDrills?.model || null;

  // The provider/model that generated the CURRENT drill — tracked separately
  // from the config-derived providerId/model above. handleConfirmFill saves
  // a newly-chosen provider to config asynchronously and doesn't await it
  // before calling runMode; if the user answers before that save (and the
  // resulting config prop update) lands, scoring must still use the provider
  // that actually generated this drill, not whatever config currently holds.
  const [activeProviderId, setActiveProviderId] = useState(null);
  const [activeModel, setActiveModel] = useState(null);

  const prompts = getPrompts(drill);
  const totalPrompts = prompts.length;
  const currentPrompt = prompts[questionIndex];

  async function runMode(modeId, useProviderId, useModel) {
    setSelectedMode(modeId);
    setLoading(true);
    setDrill(null);
    setQuestionIndex(0);
    setInputValue('');
    setItems([]);
    setFeedback(null);
    setResults([]);
    setActiveProviderId(useProviderId);
    setActiveModel(useModel);

    const generated = await generatePostDrill(modeId, { count: 5 }, useProviderId, useModel).catch(() => null);
    setLoading(false);
    if (generated) {
      setDrill(generated);
      questionStartRef.current = Date.now();
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }

  function startMode(modeId) {
    // Default to cold when the status fetch hasn't resolved yet — never skip
    // consent on an assumption the cache is already warm.
    const isCold = cacheStatus?.[modeId]?.cold ?? true;
    if (isCold && !primedModes.has(modeId)) {
      // Only pre-select the saved default if it's actually one of the modal's
      // options. The modal's provider list is API-only (enabledApiProviderFilter
      // excludes slow TUI/CLI providers — the whole point of the consent step),
      // so a saved default of e.g. "claude-code-tui" would otherwise leave the
      // <select> holding a value with no matching <option> — appearing blank
      // while silently carrying that provider through if the user just clicks
      // "Fill Cache & Play" without noticing.
      const savedProviderId = config?.llmDrills?.providerId || '';
      const savedIsSelectable = providers.some(p => p.id === savedProviderId);
      setFillProviderId(savedIsSelectable ? savedProviderId : '');
      setFillModel(savedIsSelectable ? (config?.llmDrills?.model || '') : '');
      setPendingMode(modeId);
      return;
    }
    runMode(modeId, providerId, model);
  }

  // Both consent-modal resolutions dismiss the modal and mark the mode as
  // primed (so it won't re-prompt this session) before diverging.
  function closePendingMode() {
    const modeId = pendingMode;
    setPendingMode(null);
    setPrimedModes(prev => new Set(prev).add(modeId));
    return modeId;
  }

  function handleSkipFill() {
    runMode(closePendingMode(), providerId, model);
  }

  async function handleConfirmFill() {
    const modeId = closePendingMode();
    const chosenProviderId = fillProviderId || null;
    const chosenModel = fillModel || null;
    if (chosenProviderId !== providerId || chosenModel !== model) {
      // Persist as the new default for future modes/sessions, but don't gate
      // the actions below on this round-trip — runMode and handleSubmit both
      // use the explicit chosen/active provider for this drill regardless of
      // whether this save has landed yet.
      updatePostConfig({ llmDrills: { providerId: chosenProviderId, model: chosenModel } })
        .then(updated => onConfigUpdate?.(updated))
        .catch(() => {});
    }
    // Generate the user's immediate drill FIRST, then kick off the bulk
    // background fill. Starting both at once would fire two concurrent
    // generateLlmDrill calls against the same provider (the cold cache
    // guarantees the drill request also misses and generates on demand) —
    // exactly the concurrent-LLM-calls problem this consent flow exists to
    // prevent, and especially bad for a single-session TUI provider.
    await runMode(modeId, chosenProviderId, chosenModel);
    const providerLabel = providers.find(p => p.id === chosenProviderId)?.name || 'the default provider';
    toast(`Filling ${modeId.replace(/-/g, ' ')} cache in the background using ${providerLabel}`);
    fillPostDrillCache([modeId], chosenProviderId, chosenModel).catch(() => {});
  }

  function handleBackToModes() {
    setSelectedMode(null);
    setDrill(null);
    setFeedback(null);
    setResults([]);
  }

  const handleSubmit = useCallback(async (e) => {
    e?.preventDefault();
    const responseMs = Date.now() - questionStartRef.current;

    let responseObj;
    if (selectedMode === 'compound-chain') {
      responseObj = { questionIndex, items, responseMs };
    } else {
      responseObj = {
        questionIndex,
        prompt: currentPrompt?.rootWord || currentPrompt?.word || currentPrompt?.idiom || '',
        response: inputValue.trim(),
        responseMs,
      };
    }

    // Score immediately, with the provider/model that generated THIS drill
    // (activeProviderId/activeModel) — not the config-derived providerId/model,
    // which may still be lagging an in-flight config save from a just-confirmed
    // provider switch (see handleConfirmFill).
    setFeedback({ scoring: true });
    const scored = await scorePostLlmDrill(
      selectedMode, drill, [responseObj], 120000, activeProviderId, activeModel
    ).catch(() => null);
    const fb = scored?.evaluation?.scores?.[0] || {};
    setFeedback({
      scoring: false,
      score: fb.score ?? scored?.score ?? 0,
      feedback: fb.feedback || scored?.evaluation?.summary || 'No feedback available',
      validCount: fb.validCount,
      invalidItems: fb.invalidItems,
      missedExamples: fb.missedExamples,
    });
    setResults(prev => [...prev, {
      ...responseObj,
      score: fb.score ?? scored?.score ?? 0,
      feedback: fb.feedback || '',
    }]);
  }, [inputValue, items, currentPrompt, selectedMode, drill, activeProviderId, activeModel, questionIndex]);

  const handleNext = useCallback(() => {
    setFeedback(null);
    setInputValue('');
    setItems([]);
    if (questionIndex + 1 >= totalPrompts) {
      setFeedback({ complete: true });
    } else {
      setQuestionIndex(questionIndex + 1);
      questionStartRef.current = Date.now();
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [questionIndex, totalPrompts]);

  function handleAddItem(e) {
    e?.preventDefault();
    const val = inputValue.trim();
    if (!val) return;
    if (!items.some(item => item.toLowerCase() === val.toLowerCase())) {
      setItems(prev => [...prev, val]);
    }
    setInputValue('');
    inputRef.current?.focus();
  }

  function handleRemoveItem(index) {
    setItems(prev => prev.filter((_, i) => i !== index));
  }

  // Mode selection screen
  if (!selectedMode) {
    return (
      <div className="max-w-2xl mx-auto space-y-6 px-4">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="p-1.5 hover:bg-port-card rounded-lg transition-colors">
            <ArrowLeft size={20} className="text-gray-400" />
          </button>
          <h2 className="text-xl font-bold text-white">Wordplay Training</h2>
        </div>
        <p className="text-gray-400 text-sm">Train verbal association, puns, and creative wordplay. Pick a game mode to start.</p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {GAME_MODES.map(mode => {
            const Icon = mode.icon;
            return (
              <button
                key={mode.id}
                onClick={() => startMode(mode.id)}
                className="bg-port-card border border-port-border rounded-lg p-4 text-left hover:border-port-accent transition-colors group"
              >
                <div className="flex items-center gap-3 mb-2">
                  <div className={`p-2 rounded-lg ${mode.bgColor}`}>
                    <Icon size={20} className={mode.color} />
                  </div>
                  <span className="text-white font-medium group-hover:text-port-accent transition-colors">{mode.label}</span>
                  <ChevronRight size={16} className="text-gray-600 ml-auto group-hover:text-port-accent transition-colors" />
                </div>
                <p className="text-sm text-gray-400 mb-1">{mode.description}</p>
                <p className="text-xs text-gray-600 font-mono">{mode.example}</p>
              </button>
            );
          })}
        </div>

        <CacheFillConsentModal
          pendingMode={pendingMode}
          modeInfo={GAME_MODES.find(m => m.id === pendingMode)}
          providers={providers}
          fillProviderId={fillProviderId}
          setFillProviderId={setFillProviderId}
          fillModel={fillModel}
          setFillModel={setFillModel}
          fillModels={fillModels}
          onCancel={() => setPendingMode(null)}
          onSkip={handleSkipFill}
          onConfirm={handleConfirmFill}
        />
      </div>
    );
  }

  const modeInfo = GAME_MODES.find(m => m.id === selectedMode);

  // Loading state
  if (loading) {
    return (
      <div className="max-w-lg mx-auto space-y-6">
        <ModeHeader modeInfo={modeInfo} onBack={handleBackToModes} />
        <AILoadingIndicator
          label={`Generating ${modeInfo?.label} challenges...`}
          color={modeInfo?.color || 'text-purple-400'}
        />
      </div>
    );
  }

  // Complete summary
  if (feedback?.complete) {
    const avgScore = results.length > 0
      ? Math.round(results.reduce((sum, r) => sum + (r.score || 0), 0) / results.length)
      : 0;
    const scoreColor = avgScore >= 70 ? 'text-port-success' : avgScore >= 40 ? 'text-port-warning' : 'text-port-error';

    return (
      <div className="max-w-lg mx-auto space-y-6">
        <ModeHeader modeInfo={modeInfo} onBack={handleBackToModes} />
        <div className="text-center py-6">
          <div className={`text-5xl font-mono font-bold ${scoreColor}`}>{avgScore}</div>
          <div className="text-gray-400 text-sm mt-1">Average Score</div>
        </div>
        <div className="space-y-2">
          {results.map((r, i) => (
            <div key={i} className="bg-port-card border border-port-border rounded-lg p-3 flex items-center justify-between">
              <span className="text-sm text-gray-300 truncate flex-1">{r.response || (r.items || []).join(', ') || 'No response'}</span>
              <span className={`text-sm font-mono ml-3 ${(r.score || 0) >= 70 ? 'text-port-success' : (r.score || 0) >= 40 ? 'text-port-warning' : 'text-port-error'}`}>{r.score}</span>
            </div>
          ))}
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => startMode(selectedMode)}
            className="flex-1 px-4 py-2.5 bg-port-accent hover:bg-port-accent/80 text-white font-medium rounded-lg transition-colors"
          >
            Play Again
          </button>
          <button
            onClick={handleBackToModes}
            className="flex-1 px-4 py-2.5 bg-port-card border border-port-border hover:border-port-accent text-white font-medium rounded-lg transition-colors"
          >
            Pick Mode
          </button>
        </div>
      </div>
    );
  }

  // Feedback overlay
  if (feedback && !feedback.complete) {
    if (feedback.scoring) {
      return (
        <div className="max-w-lg mx-auto space-y-6">
          <ModeHeader modeInfo={modeInfo} onBack={handleBackToModes} />
          <AILoadingIndicator
            label="Evaluating your response..."
            color={modeInfo?.color || 'text-purple-400'}
          />
        </div>
      );
    }

    const fbScoreColor = (feedback.score || 0) >= 70 ? 'text-port-success' :
      (feedback.score || 0) >= 40 ? 'text-port-warning' : 'text-port-error';
    const FbIcon = (feedback.score || 0) >= 70 ? CheckCircle : XCircle;

    return (
      <div className="max-w-lg mx-auto space-y-6">
        <ModeHeader modeInfo={modeInfo} onBack={handleBackToModes} />
        <div className="text-center py-6">
          <FbIcon size={40} className={fbScoreColor} />
          <div className={`text-3xl font-mono font-bold mt-2 ${fbScoreColor}`}>{feedback.score}</div>
        </div>
        <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-2">
          <p className="text-sm text-gray-300">{feedback.feedback}</p>
          {feedback.validCount != null && (
            <p className="text-xs text-gray-500">Valid items: {feedback.validCount}</p>
          )}
          {feedback.invalidItems?.length > 0 && (
            <p className="text-xs text-port-error">Invalid: {feedback.invalidItems.join(', ')}</p>
          )}
          <MissedExamplesDisplay examples={feedback.missedExamples} />
        </div>
        <button
          onClick={handleNext}
          autoFocus
          className={`w-full px-6 py-3 ${modeInfo?.bgColor?.replace('/20', '') || 'bg-purple-600'} hover:opacity-80 text-white font-medium rounded-lg transition-colors`}
        >
          {questionIndex + 1 >= totalPrompts ? 'See Results' : 'Next'}
        </button>
        <ProgressBar index={questionIndex} total={totalPrompts} />
      </div>
    );
  }

  // No drill loaded
  if (!drill) {
    return (
      <div className="max-w-lg mx-auto space-y-6">
        <ModeHeader modeInfo={modeInfo} onBack={handleBackToModes} />
        <div className="text-center py-8 text-gray-500">Failed to generate challenges. Check your AI provider config.</div>
        <button onClick={handleBackToModes} className="w-full px-4 py-2.5 bg-port-card border border-port-border text-white rounded-lg">Back</button>
      </div>
    );
  }

  // Active drill UI
  return (
    <div className="max-w-lg mx-auto space-y-6">
      <ModeHeader modeInfo={modeInfo} onBack={handleBackToModes} />

      {selectedMode === 'compound-chain' && (
        <CompoundChainUI
          challenge={currentPrompt}
          items={items}
          inputValue={inputValue}
          setInputValue={setInputValue}
          onAddItem={handleAddItem}
          onRemoveItem={handleRemoveItem}
          onSubmit={handleSubmit}
          inputRef={inputRef}
          questionIndex={questionIndex}
          totalPrompts={totalPrompts}
        />
      )}

      {selectedMode === 'bridge-word' && (
        <BridgeWordUI
          puzzle={currentPrompt}
          inputValue={inputValue}
          setInputValue={setInputValue}
          onSubmit={handleSubmit}
          inputRef={inputRef}
          questionIndex={questionIndex}
          totalPrompts={totalPrompts}
        />
      )}

      {selectedMode === 'double-meaning' && (
        <DoubleMeaningUI
          challenge={currentPrompt}
          inputValue={inputValue}
          setInputValue={setInputValue}
          onSubmit={handleSubmit}
          inputRef={inputRef}
          questionIndex={questionIndex}
          totalPrompts={totalPrompts}
        />
      )}

      {selectedMode === 'idiom-twist' && (
        <IdiomTwistUI
          challenge={currentPrompt}
          inputValue={inputValue}
          setInputValue={setInputValue}
          onSubmit={handleSubmit}
          inputRef={inputRef}
          questionIndex={questionIndex}
          totalPrompts={totalPrompts}
        />
      )}
    </div>
  );
}

function getPrompts(drill) {
  if (!drill) return [];
  switch (drill.type) {
    case 'compound-chain': return drill.challenges || [];
    case 'bridge-word': return drill.puzzles || [];
    case 'double-meaning': return drill.challenges || [];
    case 'idiom-twist': return drill.challenges || [];
    default: return [];
  }
}

function ModeHeader({ modeInfo, onBack }) {
  const Icon = modeInfo?.icon || Link;
  return (
    <div className="flex items-center gap-3">
      <button onClick={onBack} className="p-1.5 hover:bg-port-card rounded-lg transition-colors">
        <ArrowLeft size={20} className="text-gray-400" />
      </button>
      <div className={`p-1.5 rounded-lg ${modeInfo?.bgColor || 'bg-purple-500/20'}`}>
        <Icon size={18} className={modeInfo?.color || 'text-purple-400'} />
      </div>
      <span className="text-white font-medium">{modeInfo?.label || 'Wordplay'}</span>
    </div>
  );
}

// Cache for this mode is cold (never filled). PortOS never runs background
// LLM calls without asking first — this is the ask. The user can pick a
// provider/model and warm the cache, or skip it and just generate one drill
// on demand (no background batch).
function CacheFillConsentModal({
  pendingMode, modeInfo, providers, fillProviderId, setFillProviderId,
  fillModel, setFillModel, fillModels, onCancel, onSkip, onConfirm,
}) {
  return (
    <Modal open={!!pendingMode} onClose={onCancel} size="sm" ariaLabel="Fill drill cache">
      <div className="bg-port-card border border-port-border rounded-lg p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Sparkles size={18} className="text-port-accent-2" />
          <h3 className="text-white font-medium">Warm up {modeInfo?.label || 'this'} drills?</h3>
        </div>
        <p className="text-sm text-gray-400">
          This is the first time you're playing {modeInfo?.label || 'this mode'}. PortOS can use an AI
          provider to pre-generate a batch of drills so future rounds load instantly. Pick a provider
          and model, or skip and generate just one drill for this round.
        </p>

        <ProviderModelSelector
          providers={providers}
          selectedProviderId={fillProviderId}
          selectedModel={fillModel}
          availableModels={fillModels}
          onProviderChange={setFillProviderId}
          onModelChange={setFillModel}
          emptyProviderOption="System Default"
          emptyModelOption="Provider Default"
          alwaysShowModel
        />

        <div className="flex gap-3 pt-1">
          <button
            onClick={onSkip}
            className="flex-1 px-4 py-2 bg-port-card border border-port-border hover:border-port-accent text-white text-sm font-medium rounded-lg transition-colors"
          >
            Just Play Once
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 px-4 py-2 bg-port-accent-2 hover:bg-port-accent-2/80 text-port-on-accent-2 text-sm font-medium rounded-lg transition-colors"
          >
            Fill Cache &amp; Play
          </button>
        </div>
      </div>
    </Modal>
  );
}

