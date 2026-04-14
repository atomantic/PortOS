import { useState, useRef, useCallback } from 'react';
import { ArrowLeft, Link, Puzzle, BookOpen, Shuffle, CheckCircle, XCircle, ChevronRight } from 'lucide-react';
import { generatePostDrill, scorePostLlmDrill } from '../../../services/api';
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

export default function WordplayTrainer({ onBack, config }) {
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

  const providerId = config?.llmDrills?.providerId || null;
  const model = config?.llmDrills?.model || null;

  const prompts = getPrompts(drill);
  const totalPrompts = prompts.length;
  const currentPrompt = prompts[questionIndex];

  async function startMode(modeId) {
    setSelectedMode(modeId);
    setLoading(true);
    setDrill(null);
    setQuestionIndex(0);
    setInputValue('');
    setItems([]);
    setFeedback(null);
    setResults([]);

    const generated = await generatePostDrill(modeId, { count: 5 }, providerId, model).catch(() => null);
    setLoading(false);
    if (generated) {
      setDrill(generated);
      questionStartRef.current = Date.now();
      setTimeout(() => inputRef.current?.focus(), 100);
    }
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

    // Score immediately
    setFeedback({ scoring: true });
    const scored = await scorePostLlmDrill(
      selectedMode, drill, [responseObj], 120000, providerId, model
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
  }, [inputValue, items, currentPrompt, selectedMode, drill, providerId, model, questionIndex]);

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

