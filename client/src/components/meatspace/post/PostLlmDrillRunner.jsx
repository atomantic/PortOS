import { useState, useEffect, useRef, useCallback } from 'react';

const DRILL_LABELS = {
  'word-association': 'Word Association',
  'story-recall': 'Story Recall',
  'verbal-fluency': 'Verbal Fluency',
  'wit-comeback': 'Wit & Comeback',
  'pun-wordplay': 'Pun & Wordplay'
};

export default function PostLlmDrillRunner({ drill, timeLimitSec, drillIndex, drillCount, onComplete }) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [responses, setResponses] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [timeLeft, setTimeLeft] = useState(0);
  const [phase, setPhase] = useState('active'); // active | reading | recall
  const [items, setItems] = useState([]); // for verbal-fluency
  const inputRef = useRef(null);
  const timerRef = useRef(null);
  const questionStartRef = useRef(Date.now());
  const drillStartRef = useRef(Date.now());
  const responsesRef = useRef([]);
  const questionIndexRef = useRef(0);

  const timeLimitMs = (timeLimitSec || 120) * 1000;
  const drillType = drill?.type;

  // Get the list of prompts depending on drill type
  const prompts = getPrompts(drill);
  const totalPrompts = prompts.length;
  const currentPrompt = prompts[questionIndex];

  useEffect(() => {
    drillStartRef.current = Date.now();
    questionStartRef.current = Date.now();
    setPhase(drillType === 'story-recall' ? 'reading' : 'active');

    const startTime = Date.now();
    const limit = timeLimitMs;
    setTimeLeft(limit);

    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, limit - elapsed);
      setTimeLeft(remaining);
      if (remaining <= 0) {
        clearInterval(timerRef.current);
        handleTimeExpired();
      }
    }, 100);

    return () => clearInterval(timerRef.current);
  }, [drill]);

  // Keep refs in sync with state for use in interval callbacks
  useEffect(() => { responsesRef.current = responses; }, [responses]);
  useEffect(() => { questionIndexRef.current = questionIndex; }, [questionIndex]);

  useEffect(() => {
    setInputValue('');
    setItems([]);
    inputRef.current?.focus();
  }, [questionIndex, phase]);

  function handleTimeExpired() {
    // Submit whatever we have so far (use refs to avoid stale closures in interval callback)
    const currentResponses = responsesRef.current;
    const currentIndex = questionIndexRef.current;
    const remaining = prompts.slice(currentIndex).map(() => ({
      response: '',
      responseMs: 0
    }));
    const finalResponses = [...currentResponses, ...remaining];
    finishDrill(finalResponses);
  }

  function finishDrill(finalResponses) {
    clearInterval(timerRef.current);
    const totalMs = Date.now() - drillStartRef.current;
    onComplete({
      module: 'llm-drills',
      type: drillType,
      config: drill.config,
      drillData: drill,
      responses: finalResponses,
      totalMs
    });
  }

  const handleSubmit = useCallback((e) => {
    e?.preventDefault();
    const responseMs = Date.now() - questionStartRef.current;

    let responseObj;
    if (drillType === 'story-recall') {
      // Submit all recall answers at once
      responseObj = {
        answers: items.length > 0 ? items : [inputValue.trim()],
        responseMs
      };
    } else if (drillType === 'verbal-fluency') {
      responseObj = {
        items: items,
        responseMs
      };
    } else {
      responseObj = {
        prompt: currentPrompt?.prompt || currentPrompt?.setup || currentPrompt?.category || '',
        response: inputValue.trim(),
        responseMs
      };
    }

    const newResponses = [...responses, responseObj];
    setResponses(newResponses);

    if (questionIndex + 1 >= totalPrompts) {
      finishDrill(newResponses);
    } else {
      setQuestionIndex(questionIndex + 1);
      questionStartRef.current = Date.now();
      if (drillType === 'story-recall') {
        setPhase('reading');
        setItems([]);
      }
    }
  }, [inputValue, items, responses, questionIndex, totalPrompts, drillType, currentPrompt]);

  // Story recall: transition from reading to answering
  function handleStartRecall() {
    setPhase('recall');
    setItems([]);
    questionStartRef.current = Date.now();
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  // Verbal fluency: add item to list
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

  // Verbal fluency: remove item
  function handleRemoveItem(index) {
    setItems(prev => prev.filter((_, i) => i !== index));
  }

  // Story recall: add recall answer
  function handleAddRecallAnswer(e) {
    e?.preventDefault();
    const val = inputValue.trim();
    if (!val) return;
    setItems(prev => [...prev, val]);
    setInputValue('');
    inputRef.current?.focus();
  }

  const timePct = timeLimitMs > 0 ? (timeLeft / timeLimitMs) * 100 : 0;
  let timerColor = 'bg-port-accent';
  if (timePct <= 10) timerColor = 'bg-port-error';
  else if (timePct <= 25) timerColor = 'bg-port-warning';

  return (
    <div className="max-w-lg mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between text-sm text-gray-400">
        <span>{DRILL_LABELS[drillType] || drillType}</span>
        <span>Drill {drillIndex + 1} of {drillCount}</span>
      </div>

      {/* Timer bar */}
      <div className="w-full h-2 bg-port-border rounded-full overflow-hidden">
        <div className={`h-full ${timerColor} transition-all duration-100`} style={{ width: `${timePct}%` }} />
      </div>
      <div className="text-center text-sm text-gray-500">{Math.ceil(timeLeft / 1000)}s remaining</div>

      {/* Drill-specific UI */}
      {drillType === 'word-association' && (
        <WordAssociationUI
          prompt={currentPrompt}
          inputValue={inputValue}
          setInputValue={setInputValue}
          onSubmit={handleSubmit}
          inputRef={inputRef}
          questionIndex={questionIndex}
          totalPrompts={totalPrompts}
        />
      )}

      {drillType === 'story-recall' && (
        <StoryRecallUI
          exercise={currentPrompt}
          phase={phase}
          onStartRecall={handleStartRecall}
          items={items}
          inputValue={inputValue}
          setInputValue={setInputValue}
          onAddAnswer={handleAddRecallAnswer}
          onSubmit={handleSubmit}
          inputRef={inputRef}
          questionIndex={questionIndex}
          totalPrompts={totalPrompts}
        />
      )}

      {drillType === 'verbal-fluency' && (
        <VerbalFluencyUI
          category={currentPrompt}
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

      {drillType === 'wit-comeback' && (
        <WitComebackUI
          scenario={currentPrompt}
          inputValue={inputValue}
          setInputValue={setInputValue}
          onSubmit={handleSubmit}
          inputRef={inputRef}
          questionIndex={questionIndex}
          totalPrompts={totalPrompts}
        />
      )}

      {drillType === 'pun-wordplay' && (
        <PunWordplayUI
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
    case 'word-association': return drill.questions || [];
    case 'story-recall': return drill.exercises || [];
    case 'verbal-fluency': return drill.categories || [];
    case 'wit-comeback': return drill.scenarios || [];
    case 'pun-wordplay': return drill.challenges || [];
    default: return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DRILL-SPECIFIC UI COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

function ProgressBar({ index, total }) {
  const pct = total > 0 ? ((index + 1) / total) * 100 : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-gray-500">
        <span>Prompt {index + 1} of {total}</span>
        <span>{Math.round(pct)}%</span>
      </div>
      <div className="w-full h-1.5 bg-port-border rounded-full overflow-hidden">
        <div className="h-full bg-port-accent/60 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function TextInput({ inputRef, value, onChange, onSubmit, placeholder, buttonLabel = 'Submit' }) {
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <textarea
        ref={inputRef}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
        autoFocus
        className="w-full bg-port-bg border border-port-border rounded-lg px-4 py-3 text-white placeholder-gray-600 focus:border-port-accent focus:outline-none resize-none"
      />
      <button
        type="submit"
        disabled={!value.trim()}
        className="w-full px-6 py-2.5 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white font-medium rounded-lg transition-colors"
      >
        {buttonLabel}
      </button>
    </form>
  );
}

function WordAssociationUI({ prompt, inputValue, setInputValue, onSubmit, inputRef, questionIndex, totalPrompts }) {
  return (
    <>
      <div className="text-center py-6">
        <div className="text-sm text-gray-500 mb-2">What comes to mind?</div>
        <div className="text-4xl font-bold text-white">{prompt?.prompt}</div>
        {prompt?.hints && <div className="text-sm text-gray-500 mt-2">{prompt.hints}</div>}
      </div>
      <TextInput
        inputRef={inputRef}
        value={inputValue}
        onChange={setInputValue}
        onSubmit={onSubmit}
        placeholder="Type your associations..."
        buttonLabel="Next"
      />
      <ProgressBar index={questionIndex} total={totalPrompts} />
    </>
  );
}

function StoryRecallUI({ exercise, phase, onStartRecall, items, inputValue, setInputValue, onAddAnswer, onSubmit, inputRef, questionIndex, totalPrompts }) {
  if (phase === 'reading') {
    return (
      <>
        <div className="bg-port-card border border-port-border rounded-lg p-6">
          <div className="text-sm text-gray-500 mb-3">Read carefully — you'll be asked questions about this:</div>
          <p className="text-white text-lg leading-relaxed">{exercise?.paragraph}</p>
        </div>
        <button
          onClick={onStartRecall}
          className="w-full px-6 py-3 bg-port-accent hover:bg-port-accent/80 text-white font-medium rounded-lg transition-colors"
        >
          I'm Ready — Show Questions
        </button>
        <ProgressBar index={questionIndex} total={totalPrompts} />
      </>
    );
  }

  const recallQuestions = exercise?.questions || [];
  return (
    <>
      <div className="space-y-4">
        <div className="text-sm text-gray-400">Answer from memory:</div>
        {recallQuestions.map((q, i) => (
          <div key={i} className="bg-port-card border border-port-border rounded-lg p-4">
            <div className="text-white text-sm mb-2">{q.question}</div>
            {items[i] !== undefined ? (
              <div className="text-port-accent text-sm font-mono">{items[i]}</div>
            ) : (
              <form onSubmit={onAddAnswer} className="flex gap-2">
                <input
                  ref={i === items.length ? inputRef : undefined}
                  type="text"
                  value={i === items.length ? inputValue : ''}
                  onChange={e => i === items.length && setInputValue(e.target.value)}
                  disabled={i !== items.length}
                  placeholder="Your answer..."
                  autoFocus={i === items.length}
                  className="flex-1 bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:border-port-accent focus:outline-none disabled:opacity-50"
                />
                {i === items.length && (
                  <button type="submit" disabled={!inputValue.trim()} className="px-3 py-1.5 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white text-sm rounded transition-colors">
                    Answer
                  </button>
                )}
              </form>
            )}
          </div>
        ))}
      </div>
      {items.length >= recallQuestions.length && (
        <button onClick={onSubmit} className="w-full px-6 py-2.5 bg-port-success hover:bg-port-success/80 text-white font-medium rounded-lg transition-colors">
          Submit All Answers
        </button>
      )}
      <ProgressBar index={questionIndex} total={totalPrompts} />
    </>
  );
}

function VerbalFluencyUI({ category, items, inputValue, setInputValue, onAddItem, onRemoveItem, onSubmit, inputRef, questionIndex, totalPrompts }) {
  return (
    <>
      <div className="text-center py-4">
        <div className="text-sm text-gray-500 mb-2">Name as many as you can:</div>
        <div className="text-3xl font-bold text-white">{category?.category}</div>
        {category?.minExpected && (
          <div className="text-sm text-gray-500 mt-2">Target: {category.minExpected}+</div>
        )}
      </div>

      <form onSubmit={onAddItem} className="flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          placeholder="Type an item and press Enter..."
          autoFocus
          className="flex-1 bg-port-bg border border-port-border rounded-lg px-4 py-2.5 text-white placeholder-gray-600 focus:border-port-accent focus:outline-none"
        />
        <button type="submit" disabled={!inputValue.trim()} className="px-4 py-2.5 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white font-medium rounded-lg transition-colors">
          Add
        </button>
      </form>

      {items.length > 0 && (
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <div className="flex items-center justify-between text-sm text-gray-400 mb-2">
            <span>Items ({items.length})</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {items.map((item, i) => (
              <span key={i} className="inline-flex items-center gap-1 px-2 py-1 bg-port-bg border border-port-border rounded text-sm text-white">
                {item}
                <button onClick={() => onRemoveItem(i)} className="text-gray-500 hover:text-port-error ml-1">&times;</button>
              </span>
            ))}
          </div>
        </div>
      )}

      <button
        onClick={onSubmit}
        disabled={items.length === 0}
        className="w-full px-6 py-2.5 bg-port-success hover:bg-port-success/80 disabled:opacity-50 text-white font-medium rounded-lg transition-colors"
      >
        Done — Submit {items.length} items
      </button>
      <ProgressBar index={questionIndex} total={totalPrompts} />
    </>
  );
}

function WitComebackUI({ scenario, inputValue, setInputValue, onSubmit, inputRef, questionIndex, totalPrompts }) {
  return (
    <>
      <div className="bg-port-card border border-port-border rounded-lg p-6 text-center">
        <div className="text-sm text-gray-500 mb-3">
          {scenario?.difficulty && <span className={`inline-block px-2 py-0.5 rounded text-xs mr-2 ${
            scenario.difficulty === 'hard' ? 'bg-port-error/20 text-port-error' :
            scenario.difficulty === 'medium' ? 'bg-port-warning/20 text-port-warning' :
            'bg-port-success/20 text-port-success'
          }`}>{scenario.difficulty}</span>}
          Respond with wit
        </div>
        <p className="text-white text-lg leading-relaxed">"{scenario?.setup}"</p>
        {scenario?.context && <p className="text-gray-500 text-sm mt-2">{scenario.context}</p>}
      </div>
      <TextInput
        inputRef={inputRef}
        value={inputValue}
        onChange={setInputValue}
        onSubmit={onSubmit}
        placeholder="Your witty response..."
        buttonLabel="Next"
      />
      <ProgressBar index={questionIndex} total={totalPrompts} />
    </>
  );
}

function PunWordplayUI({ challenge, inputValue, setInputValue, onSubmit, inputRef, questionIndex, totalPrompts }) {
  return (
    <>
      <div className="bg-port-card border border-port-border rounded-lg p-6 text-center">
        <div className="text-sm text-gray-500 mb-3">
          {challenge?.type && <span className="inline-block px-2 py-0.5 rounded text-xs mr-2 bg-purple-500/20 text-purple-400">{challenge.type}</span>}
          Create wordplay
        </div>
        <p className="text-white text-lg leading-relaxed">{challenge?.prompt}</p>
        {challenge?.topic && <p className="text-gray-500 text-sm mt-2">Topic: {challenge.topic}</p>}
      </div>
      <TextInput
        inputRef={inputRef}
        value={inputValue}
        onChange={setInputValue}
        onSubmit={onSubmit}
        placeholder="Your pun or wordplay..."
        buttonLabel="Next"
      />
      <ProgressBar index={questionIndex} total={totalPrompts} />
    </>
  );
}
