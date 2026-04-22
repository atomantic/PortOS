import { useState, useEffect } from 'react';
import { Loader } from 'lucide-react';
import { getDifficultyColor } from './constants';

const LOADING_MESSAGES = [
  'Crafting challenges...',
  'Picking interesting words...',
  'Building puzzles...',
  'Almost ready...',
];

export function AILoadingIndicator({ label, color = 'text-purple-400' }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);

  const msgIndex = Math.floor(elapsed / 3) % LOADING_MESSAGES.length;

  const pct = Math.min(90, elapsed * 6);

  return (
    <div className="flex flex-col items-center gap-4 py-8">
      <Loader size={28} className={`${color} animate-spin`} />
      <div className="text-center space-y-1">
        <span className="text-gray-300 text-sm">{label}</span>
        <div className="text-gray-500 text-xs">{LOADING_MESSAGES[msgIndex]}</div>
      </div>
      <div className="w-48 space-y-1">
        <div className="w-full h-1 bg-port-border rounded-full overflow-hidden">
          <div
            className="h-full bg-port-accent/50 rounded-full transition-all duration-1000"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="text-center text-xs text-gray-600">{elapsed}s</div>
      </div>
    </div>
  );
}

export function ProgressBar({ index, total }) {
  const pct = total > 0 ? ((index + 1) / total) * 100 : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-gray-500">
        <span>Challenge {index + 1} of {total}</span>
        <span>{Math.round(pct)}%</span>
      </div>
      <div className="w-full h-1.5 bg-port-border rounded-full overflow-hidden">
        <div className="h-full bg-port-accent/60 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function DifficultyBadge({ difficulty }) {
  if (!difficulty) return null;
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs ${getDifficultyColor(difficulty)}`}>{difficulty}</span>
  );
}

function ExampleHint({ example }) {
  if (!example) return null;
  return <div className="text-xs text-gray-600 mt-3 italic">e.g. &quot;{example}&quot;</div>;
}

export function MissedExamplesDisplay({ examples }) {
  if (!examples?.length) return null;
  return (
    <div className="pt-2 border-t border-port-border">
      <p className="text-xs text-gray-500 mb-1">You could also have said:</p>
      <div className="flex flex-wrap gap-1.5">
        {examples.map((ex, i) => (
          <span key={i} className="px-2 py-0.5 bg-port-accent/10 text-port-accent text-xs rounded">{ex}</span>
        ))}
      </div>
    </div>
  );
}

export function CompoundChainUI({ challenge, items, inputValue, setInputValue, onAddItem, onRemoveItem, onSubmit, inputRef, questionIndex, totalPrompts }) {
  const directionHint = challenge?.position === 'prefix'
    ? `e.g. ${challenge?.rootWord}house, ${challenge?.rootWord}work`
    : challenge?.position === 'suffix'
      ? `e.g. day${challenge?.rootWord}, flash${challenge?.rootWord}`
      : `e.g. ${challenge?.rootWord}house, flash${challenge?.rootWord}`;

  return (
    <>
      <div className="text-center py-4">
        <div className="text-sm text-gray-500 mb-2">List compound words or phrases using:</div>
        <div className="text-4xl font-bold text-white">{challenge?.rootWord}</div>
        <div className="text-sm text-gray-500 mt-2">
          {challenge?.position === 'prefix' ? 'Starts with this word' : challenge?.position === 'suffix' ? 'Ends with this word' : 'Either direction'}
          {challenge?.minExpected && ` · Target: ${challenge.minExpected}+`}
        </div>
        {items.length === 0 && (
          <div className="text-xs text-gray-600 mt-2 italic">{directionHint}</div>
        )}
      </div>

      <form onSubmit={onAddItem} className="flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          placeholder="Type the full compound or just the other half..."
          autoFocus
          className="flex-1 bg-port-bg border border-port-border rounded-lg px-4 py-2.5 text-white placeholder-gray-600 focus:border-port-accent focus:outline-none"
        />
        <button type="submit" disabled={!inputValue.trim()} className="px-4 py-2.5 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white font-medium rounded-lg transition-colors">
          Add
        </button>
      </form>

      {items.length > 0 && (
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <div className="text-sm text-gray-400 mb-2">Compounds ({items.length})</div>
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
        Done — Submit {items.length} compounds
      </button>
      <ProgressBar index={questionIndex} total={totalPrompts} />
    </>
  );
}

export function BridgeWordUI({ puzzle, inputValue, setInputValue, onSubmit, inputRef, questionIndex, totalPrompts }) {
  return (
    <>
      <div className="text-center py-4">
        <div className="text-sm text-gray-500 mb-3">Find the word that fills all blanks:</div>
        <div className="flex flex-col items-center gap-2">
          {(puzzle?.clues || []).map((clue, i) => (
            <span key={i} className="px-4 py-2 bg-purple-500/20 text-purple-300 rounded-lg text-lg font-mono">{clue}</span>
          ))}
        </div>
        <div className="text-xs text-gray-600 mt-3 italic">One word completes all the blanks above</div>
        {puzzle?.hint && <div className="text-sm text-gray-500 mt-2">Hint: {puzzle.hint}</div>}
        {puzzle?.difficulty && <DifficultyBadge difficulty={puzzle.difficulty} />}
      </div>
      <form onSubmit={onSubmit} className="space-y-3">
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          placeholder="The bridge word is..."
          autoFocus
          className="w-full bg-port-bg border border-port-border rounded-lg px-4 py-3 text-white text-center text-lg placeholder-gray-600 focus:border-port-accent focus:outline-none"
        />
        <button
          type="submit"
          disabled={!inputValue.trim()}
          className="w-full px-6 py-2.5 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white font-medium rounded-lg transition-colors"
        >
          Submit
        </button>
      </form>
      <ProgressBar index={questionIndex} total={totalPrompts} />
    </>
  );
}

export function DoubleMeaningUI({ challenge, inputValue, setInputValue, onSubmit, inputRef, questionIndex, totalPrompts, TextInput }) {
  const input = TextInput ? (
    <TextInput
      inputRef={inputRef}
      value={inputValue}
      onChange={setInputValue}
      onSubmit={onSubmit}
      placeholder="Write a sentence using both meanings..."
      buttonLabel="Next"
    />
  ) : (
    <form onSubmit={onSubmit} className="space-y-3">
      <textarea
        ref={inputRef}
        value={inputValue}
        onChange={e => setInputValue(e.target.value)}
        placeholder="Write a sentence using both meanings..."
        rows={3}
        autoFocus
        className="w-full bg-port-bg border border-port-border rounded-lg px-4 py-3 text-white placeholder-gray-600 focus:border-port-accent focus:outline-none resize-none"
      />
      <button
        type="submit"
        disabled={!inputValue.trim()}
        className="w-full px-6 py-2.5 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white font-medium rounded-lg transition-colors"
      >
        Submit
      </button>
    </form>
  );

  return (
    <>
      <div className="bg-port-card border border-port-border rounded-lg p-6 text-center">
        <div className="text-sm text-gray-500 mb-2">Use both meanings in one sentence:</div>
        <div className="text-3xl font-bold text-white mb-3">{challenge?.word}</div>
        <div className="flex flex-wrap justify-center gap-2">
          {(challenge?.meanings || []).map((m, i) => (
            <span key={i} className="px-3 py-1 bg-amber-500/20 text-amber-400 rounded-lg text-sm">{m}</span>
          ))}
        </div>
        <ExampleHint example={challenge?.example} />
        {challenge?.difficulty && <div className="mt-3"><DifficultyBadge difficulty={challenge.difficulty} /></div>}
      </div>
      {input}
      <ProgressBar index={questionIndex} total={totalPrompts} />
    </>
  );
}

export function IdiomTwistUI({ challenge, inputValue, setInputValue, onSubmit, inputRef, questionIndex, totalPrompts, TextInput }) {
  const input = TextInput ? (
    <TextInput
      inputRef={inputRef}
      value={inputValue}
      onChange={setInputValue}
      onSubmit={onSubmit}
      placeholder="Your twisted idiom..."
      buttonLabel="Next"
    />
  ) : (
    <form onSubmit={onSubmit} className="space-y-3">
      <textarea
        ref={inputRef}
        value={inputValue}
        onChange={e => setInputValue(e.target.value)}
        placeholder="Your twisted idiom..."
        rows={3}
        autoFocus
        className="w-full bg-port-bg border border-port-border rounded-lg px-4 py-3 text-white placeholder-gray-600 focus:border-port-accent focus:outline-none resize-none"
      />
      <button
        type="submit"
        disabled={!inputValue.trim()}
        className="w-full px-6 py-2.5 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white font-medium rounded-lg transition-colors"
      >
        Submit
      </button>
    </form>
  );

  return (
    <>
      <div className="bg-port-card border border-port-border rounded-lg p-6 text-center">
        <div className="text-sm text-gray-500 mb-3">Adapt this idiom to a new domain:</div>
        <p className="text-white text-lg leading-relaxed italic mb-3">"{challenge?.idiom}"</p>
        <div className="flex items-center justify-center gap-2">
          <span className="text-gray-500">New domain:</span>
          <span className="px-3 py-1 bg-cyan-500/20 text-cyan-400 rounded-lg font-medium">{challenge?.domain}</span>
        </div>
        <ExampleHint example={challenge?.example} />
        {challenge?.difficulty && <div className="mt-3"><DifficultyBadge difficulty={challenge.difficulty} /></div>}
      </div>
      {input}
      <ProgressBar index={questionIndex} total={totalPrompts} />
    </>
  );
}
