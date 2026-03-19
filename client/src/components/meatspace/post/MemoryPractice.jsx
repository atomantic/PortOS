import { useState, useRef, useEffect, useMemo } from 'react';
import { ChevronLeft, Check, X, SkipForward, RotateCcw, Target, ChevronDown } from 'lucide-react';
import { submitMemoryPractice, getChunkMastery } from '../../../services/api';

const MODES = [
  { id: 'learn', label: 'Learn', desc: 'Progressive reveal — read and absorb line by line' },
  { id: 'fill-blank', label: 'Fill in the Blank', desc: 'Fill missing words in partially shown lines' },
  { id: 'sequence', label: 'Sequence Recall', desc: 'Given a line, type what comes next' },
  { id: 'speed-run', label: 'Speed Run', desc: 'Recite the full sequence as fast as possible' },
  { id: 'spaced', label: 'Spaced Repetition', desc: 'Focus on your weakest chunks with graduated hints' },
];

export default function MemoryPractice({ item, onBack }) {
  const [mode, setMode] = useState(null);
  const [results, setResults] = useState([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [answer, setAnswer] = useState('');
  const [showResult, setShowResult] = useState(null); // null | 'correct' | 'wrong'
  const [done, setDone] = useState(false);
  const [startTime] = useState(Date.now());
  const inputRef = useRef(null);

  // Spaced repetition state
  const [chunkMastery, setChunkMastery] = useState(null);
  const [spacedChunkIdx, setSpacedChunkIdx] = useState(0);
  const [spacedLineIdx, setSpacedLineIdx] = useState(0);

  const lines = item.content?.lines || [];
  const chunks = item.content?.chunks || [];
  const fillBlankLine = lines[currentIdx] || null;
  const fillBlankWords = fillBlankLine?.text.split(/\s+/) || [];
  // Blank out ~40% of words — recompute when line changes
  const blanks = useMemo(() => {
    if (mode !== 'fill-blank' || !fillBlankWords.length) return new Set();
    const blankSet = new Set();
    const count = Math.max(1, Math.floor(fillBlankWords.length * 0.4));
    while (blankSet.size < count && blankSet.size < fillBlankWords.length) {
      blankSet.add(Math.floor(Math.random() * fillBlankWords.length));
    }
    return blankSet;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, currentIdx, fillBlankWords.length]);

  useEffect(() => {
    if (mode && inputRef.current) inputRef.current.focus();
  }, [mode, currentIdx, spacedLineIdx]);

  // Load chunk mastery when entering spaced mode
  useEffect(() => {
    if (mode === 'spaced') {
      getChunkMastery(item.id).then(data => {
        setChunkMastery(data || []);
      }).catch(() => setChunkMastery([]));
    }
  }, [mode, item.id]);

  if (!mode) {
    return (
      <div className="space-y-6 max-w-2xl">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-gray-400 hover:text-white transition-colors">
            <ChevronLeft size={20} />
          </button>
          <h2 className="text-xl font-bold text-white">{item.title}</h2>
        </div>

        <p className="text-gray-400 text-sm">Choose a practice mode:</p>

        <div className="space-y-3">
          {MODES.map(m => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              className="w-full bg-port-card border border-port-border rounded-lg p-4 text-left hover:border-port-accent/50 transition-colors"
            >
              <div className="flex items-center gap-2">
                <div className="text-white font-medium">{m.label}</div>
                {m.id === 'spaced' && <Target size={14} className="text-port-accent" />}
              </div>
              <div className="text-gray-500 text-sm mt-1">{m.desc}</div>
            </button>
          ))}
        </div>

        {/* Chunk mastery overview */}
        {chunks.length > 0 && (
          <ChunkMasteryOverview item={item} />
        )}
      </div>
    );
  }

  if (done) {
    const correct = results.filter(r => r.correct).length;
    const pct = results.length > 0 ? Math.round((correct / results.length) * 100) : 0;
    const scoreColor = pct >= 80 ? 'text-port-success' : pct >= 50 ? 'text-port-warning' : 'text-port-error';

    return (
      <div className="space-y-6 max-w-2xl">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-gray-400 hover:text-white transition-colors">
            <ChevronLeft size={20} />
          </button>
          <h2 className="text-xl font-bold text-white">Practice Complete</h2>
        </div>

        <div className="bg-port-card border border-port-border rounded-lg p-6 text-center">
          <div className={`text-5xl font-bold font-mono ${scoreColor} mb-2`}>{pct}%</div>
          <div className="text-gray-400 text-sm">{correct} of {results.length} correct</div>
          <div className="text-gray-500 text-xs mt-1">
            {Math.round((Date.now() - startTime) / 1000)}s elapsed
          </div>
        </div>

        {/* Show wrong answers */}
        {results.filter(r => !r.correct).length > 0 && (
          <div className="bg-port-card border border-port-border rounded-lg p-4">
            <h3 className="text-sm font-medium text-gray-400 mb-3">Review mistakes</h3>
            <div className="space-y-2">
              {results.filter(r => !r.correct).map((r, i) => (
                <div key={i} className="text-sm">
                  <div className="text-port-error">Your answer: {r.answered || '(skipped)'}</div>
                  <div className="text-port-success">Expected: {r.expected}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={() => { setMode(null); setResults([]); setCurrentIdx(0); setDone(false); setShowResult(null); setSpacedChunkIdx(0); setSpacedLineIdx(0); }}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-port-card border border-port-border rounded-lg text-gray-300 hover:text-white transition-colors"
          >
            <RotateCcw size={16} />
            Try Again
          </button>
          <button
            onClick={onBack}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  // SPACED REPETITION mode — focus on weakest chunks with graduated hints
  if (mode === 'spaced') {
    if (!chunkMastery) {
      return (
        <div className="space-y-6 max-w-2xl">
          <div className="text-gray-400 text-sm">Loading chunk mastery...</div>
        </div>
      );
    }

    if (chunkMastery.length === 0) {
      return (
        <div className="space-y-6 max-w-2xl">
          <div className="flex items-center gap-3">
            <button onClick={onBack} className="text-gray-400 hover:text-white transition-colors">
              <ChevronLeft size={20} />
            </button>
            <h2 className="text-lg font-bold text-white">Spaced Repetition — {item.title}</h2>
          </div>
          <div className="bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-500">
            No chunks available for spaced practice.
          </div>
        </div>
      );
    }

    const currentChunk = chunkMastery[spacedChunkIdx];
    if (!currentChunk) {
      // All chunks done
      savePractice('spaced', results);
      setDone(true);
      return null;
    }

    const [chunkStart, chunkEnd] = currentChunk.lineRange;
    const chunkLines = lines.slice(chunkStart, chunkEnd + 1).filter(l => l.text.trim());
    const currentLine = chunkLines[spacedLineIdx];

    if (!currentLine) {
      // Move to next chunk
      setSpacedChunkIdx(prev => prev + 1);
      setSpacedLineIdx(0);
      setAnswer('');
      setShowResult(null);
      return null;
    }

    // Graduated hints based on hintLevel:
    // 0 = show first letter of each word, 1 = show first letters of some, 2 = show word count only, 3 = no hints
    const hintLevel = currentChunk.hintLevel;
    const hintText = generateHint(currentLine.text, hintLevel);

    return (
      <div className="space-y-6 max-w-2xl">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-gray-400 hover:text-white transition-colors">
            <ChevronLeft size={20} />
          </button>
          <h2 className="text-lg font-bold text-white">Spaced — {item.title}</h2>
          <span className="text-gray-500 text-sm ml-auto">
            Chunk {spacedChunkIdx + 1}/{chunkMastery.length} • Line {spacedLineIdx + 1}/{chunkLines.length}
          </span>
        </div>

        <ProgressBar current={spacedChunkIdx * 10 + spacedLineIdx + 1} total={chunkMastery.length * 10} />

        {/* Chunk info */}
        <div className="flex items-center gap-3 text-xs">
          <span className="text-gray-500">{currentChunk.label}</span>
          <span className={`font-mono ${currentChunk.accuracy >= 80 ? 'text-port-success' : currentChunk.accuracy >= 40 ? 'text-port-warning' : 'text-gray-500'}`}>
            {currentChunk.accuracy}% mastery
          </span>
          <span className="text-gray-600">
            Hint level: {['Full', 'Partial', 'Minimal', 'None'][hintLevel]}
          </span>
        </div>

        <div className="bg-port-card border border-port-border rounded-lg p-6">
          {/* Show previous lines in chunk as context */}
          {spacedLineIdx > 0 && (
            <div className="mb-4 space-y-1">
              {chunkLines.slice(0, spacedLineIdx).map((l, i) => (
                <div key={i} className="text-gray-500 text-sm">{l.text}</div>
              ))}
            </div>
          )}

          <div className="text-gray-400 text-xs mb-2 uppercase tracking-wide">Recall this line:</div>
          {hintText && <div className="text-gray-600 text-sm font-mono mb-3">{hintText}</div>}

          {showResult ? (
            <div className="space-y-2">
              <div className={`text-sm p-3 rounded ${showResult === 'correct' ? 'bg-port-success/10 text-port-success' : 'bg-port-error/10 text-port-error'}`}>
                {showResult === 'correct' ? 'Correct!' : `Your answer: ${answer}`}
              </div>
              {showResult === 'wrong' && (
                <div className="text-sm p-3 rounded bg-port-success/10 text-port-success">
                  Expected: {currentLine.text}
                </div>
              )}
            </div>
          ) : (
            <textarea
              ref={inputRef}
              value={answer}
              onChange={e => setAnswer(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); checkSpacedAnswer(currentLine.text, currentChunk.id); } }}
              placeholder="Type the line..."
              className="w-full bg-port-bg border border-port-border rounded-lg px-4 py-3 text-white placeholder-gray-600 focus:border-port-accent focus:outline-none resize-none"
              rows={2}
            />
          )}
        </div>

        <div className="flex gap-3">
          {showResult ? (
            <button
              onClick={advanceSpaced}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
            >
              Next
            </button>
          ) : (
            <>
              <button
                onClick={() => checkSpacedAnswer(currentLine.text, currentChunk.id)}
                disabled={!answer.trim()}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                <Check size={16} />
                Check
              </button>
              <button
                onClick={() => { setAnswer(''); checkSpacedAnswer(currentLine.text, currentChunk.id, true); }}
                className="px-4 py-2.5 bg-port-card border border-port-border rounded-lg text-gray-400 hover:text-white transition-colors"
              >
                <SkipForward size={16} />
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // LEARN mode — progressive reveal
  if (mode === 'learn') {
    return (
      <div className="space-y-6 max-w-2xl">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-gray-400 hover:text-white transition-colors">
            <ChevronLeft size={20} />
          </button>
          <h2 className="text-lg font-bold text-white">Learn — {item.title}</h2>
          <span className="text-gray-500 text-sm ml-auto">{currentIdx + 1} / {lines.length}</span>
        </div>

        <ProgressBar current={currentIdx + 1} total={lines.length} />

        <div className="bg-port-card border border-port-border rounded-lg p-6">
          <div className="space-y-2">
            {lines.slice(0, currentIdx + 1).map((line, i) => (
              <div
                key={i}
                className={`text-sm leading-relaxed transition-all ${
                  i === currentIdx ? 'text-white font-medium text-base' : 'text-gray-500'
                }`}
              >
                {line.text}
              </div>
            ))}
          </div>
        </div>

        <div className="flex gap-3">
          {currentIdx > 0 && (
            <button
              onClick={() => setCurrentIdx(prev => prev - 1)}
              className="px-4 py-2.5 bg-port-card border border-port-border rounded-lg text-gray-300 hover:text-white transition-colors"
            >
              Previous
            </button>
          )}
          {currentIdx < lines.length - 1 ? (
            <button
              onClick={() => setCurrentIdx(prev => prev + 1)}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
            >
              Next Line
            </button>
          ) : (
            <button
              onClick={() => { setDone(true); setResults([{ correct: true, expected: 'learn mode', answered: 'learn mode' }]); savePractice('learn', [{ correct: true }]); }}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-port-success hover:bg-port-success/80 text-white rounded-lg transition-colors"
            >
              <Check size={16} />
              Complete
            </button>
          )}
        </div>
      </div>
    );
  }

  // SEQUENCE mode — given a line, type the next one
  if (mode === 'sequence') {
    const promptLine = lines[currentIdx];
    const expectedLine = lines[currentIdx + 1];

    if (!expectedLine) {
      finishSequence();
      return null;
    }

    return (
      <div className="space-y-6 max-w-2xl">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-gray-400 hover:text-white transition-colors">
            <ChevronLeft size={20} />
          </button>
          <h2 className="text-lg font-bold text-white">Sequence — {item.title}</h2>
          <span className="text-gray-500 text-sm ml-auto">{currentIdx + 1} / {lines.length - 1}</span>
        </div>

        <ProgressBar current={currentIdx + 1} total={lines.length - 1} />

        <div className="bg-port-card border border-port-border rounded-lg p-6">
          <div className="text-gray-400 text-xs mb-2 uppercase tracking-wide">Current line:</div>
          <div className="text-white text-lg leading-relaxed mb-6">{promptLine.text}</div>

          <div className="text-gray-400 text-xs mb-2 uppercase tracking-wide">What comes next?</div>
          {showResult ? (
            <div className="space-y-2">
              <div className={`text-sm p-3 rounded ${showResult === 'correct' ? 'bg-port-success/10 text-port-success' : 'bg-port-error/10 text-port-error'}`}>
                {showResult === 'correct' ? 'Correct!' : `Your answer: ${answer}`}
              </div>
              {showResult === 'wrong' && (
                <div className="text-sm p-3 rounded bg-port-success/10 text-port-success">
                  Expected: {expectedLine.text}
                </div>
              )}
            </div>
          ) : (
            <textarea
              ref={inputRef}
              value={answer}
              onChange={e => setAnswer(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); checkSequenceAnswer(expectedLine.text); } }}
              placeholder="Type the next line..."
              className="w-full bg-port-bg border border-port-border rounded-lg px-4 py-3 text-white placeholder-gray-600 focus:border-port-accent focus:outline-none resize-none"
              rows={2}
            />
          )}
        </div>

        <div className="flex gap-3">
          {showResult ? (
            <button
              onClick={nextSequenceQuestion}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
            >
              {currentIdx + 1 < lines.length - 1 ? 'Next' : 'Finish'}
            </button>
          ) : (
            <>
              <button
                onClick={() => checkSequenceAnswer(expectedLine.text)}
                disabled={!answer.trim()}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                <Check size={16} />
                Check
              </button>
              <button
                onClick={() => { setAnswer(''); checkSequenceAnswer(expectedLine.text, true); }}
                className="px-4 py-2.5 bg-port-card border border-port-border rounded-lg text-gray-400 hover:text-white transition-colors"
              >
                <SkipForward size={16} />
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // FILL-IN-THE-BLANK mode

  if (mode === 'fill-blank') {
    const line = fillBlankLine;
    const words = fillBlankWords;

    const blankWords = [...blanks].sort((a, b) => a - b).map(i => words[i]?.replace(/[,.]$/, ''));
    const displayText = words.map((w, i) => blanks.has(i) ? '____' : w).join(' ');

    return (
      <div className="space-y-6 max-w-2xl">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-gray-400 hover:text-white transition-colors">
            <ChevronLeft size={20} />
          </button>
          <h2 className="text-lg font-bold text-white">Fill Blank — {item.title}</h2>
          <span className="text-gray-500 text-sm ml-auto">{currentIdx + 1} / {lines.length}</span>
        </div>

        <ProgressBar current={currentIdx + 1} total={lines.length} />

        <div className="bg-port-card border border-port-border rounded-lg p-6">
          <div className="text-white text-lg leading-relaxed mb-4 font-mono">{displayText}</div>

          {showResult ? (
            <div className="space-y-2">
              <div className="text-sm text-gray-400">Full line:</div>
              <div className="text-port-success text-sm">{line.text}</div>
            </div>
          ) : (
            <div>
              <div className="text-gray-400 text-xs mb-2">Fill the blanks (comma-separated):</div>
              <input
                ref={inputRef}
                type="text"
                value={answer}
                onChange={e => setAnswer(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') checkFillBlank(blankWords); }}
                placeholder={`${blankWords.length} word${blankWords.length > 1 ? 's' : ''} missing...`}
                className="w-full bg-port-bg border border-port-border rounded px-4 py-2.5 text-white placeholder-gray-600 focus:border-port-accent focus:outline-none"
              />
            </div>
          )}
        </div>

        <div className="flex gap-3">
          {showResult ? (
            <button
              onClick={nextFillBlank}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
            >
              {currentIdx + 1 < lines.length ? 'Next' : 'Finish'}
            </button>
          ) : (
            <>
              <button
                onClick={() => checkFillBlank(blankWords)}
                disabled={!answer.trim()}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                <Check size={16} />
                Check
              </button>
              <button
                onClick={() => { setAnswer(''); checkFillBlank(blankWords, true); }}
                className="px-4 py-2.5 bg-port-card border border-port-border rounded-lg text-gray-400 hover:text-white transition-colors"
              >
                <SkipForward size={16} />
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // SPEED RUN mode — show all lines, check how many you can recite
  if (mode === 'speed-run') {
    return (
      <div className="space-y-6 max-w-2xl">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-gray-400 hover:text-white transition-colors">
            <ChevronLeft size={20} />
          </button>
          <h2 className="text-lg font-bold text-white">Speed Run — {item.title}</h2>
        </div>

        <div className="bg-port-card border border-port-border rounded-lg p-6">
          <p className="text-gray-400 text-sm mb-4">
            Try to recite the full text from memory. Tap each line to reveal it and check yourself.
          </p>
          <div className="space-y-1">
            {lines.map((line, i) => (
              <SpeedRunLine key={i} line={line} index={i} onResult={(correct) => {
                setResults(prev => [...prev, { correct, expected: line.text, answered: correct ? line.text : '(wrong)' }]);
              }} />
            ))}
          </div>
        </div>

        {results.length === lines.length && (
          <button
            onClick={() => { savePractice('speed-run', results); setDone(true); }}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-port-success hover:bg-port-success/80 text-white rounded-lg transition-colors"
          >
            <Check size={16} />
            Finish ({results.filter(r => r.correct).length}/{results.length} correct)
          </button>
        )}
      </div>
    );
  }

  return null;

  // --- Helpers ---

  function checkSequenceAnswer(expected, skipped = false) {
    const isCorrect = !skipped && fuzzyMatch(answer, expected);
    setResults(prev => [...prev, { correct: isCorrect, expected, answered: skipped ? '' : answer, element: null }]);
    setShowResult(isCorrect ? 'correct' : 'wrong');
  }

  function nextSequenceQuestion() {
    if (currentIdx + 1 >= lines.length - 1) {
      finishSequence();
    } else {
      setCurrentIdx(prev => prev + 1);
      setAnswer('');
      setShowResult(null);
    }
  }

  function finishSequence() {
    savePractice('sequence', results);
    setDone(true);
  }

  function checkFillBlank(blankWords, skipped = false) {
    const userWords = skipped ? [] : answer.split(',').map(w => w.trim().toLowerCase());
    const correct = blankWords.every((bw, i) =>
      userWords[i] && userWords[i] === bw.toLowerCase()
    );
    setResults(prev => [...prev, {
      correct,
      expected: blankWords.join(', '),
      answered: skipped ? '' : answer,
    }]);
    setShowResult(correct ? 'correct' : 'wrong');
  }

  function nextFillBlank() {
    if (currentIdx + 1 >= lines.length) {
      savePractice('fill-blank', results);
      setDone(true);
    } else {
      setCurrentIdx(prev => prev + 1);
      setAnswer('');
      setShowResult(null);
    }
  }

  function checkSpacedAnswer(expected, chunkId, skipped = false) {
    const isCorrect = !skipped && fuzzyMatch(answer, expected);
    setResults(prev => [...prev, { correct: isCorrect, expected, answered: skipped ? '' : answer, chunkId }]);
    setShowResult(isCorrect ? 'correct' : 'wrong');
  }

  function advanceSpaced() {
    const currentChunk = chunkMastery[spacedChunkIdx];
    const [chunkStart, chunkEnd] = currentChunk.lineRange;
    const chunkLines = lines.slice(chunkStart, chunkEnd + 1).filter(l => l.text.trim());

    if (spacedLineIdx + 1 < chunkLines.length) {
      setSpacedLineIdx(prev => prev + 1);
    } else {
      // Save practice for this chunk, move to next
      const chunkResults = results.filter(r => r.chunkId === currentChunk.id);
      if (chunkResults.length > 0) {
        submitMemoryPractice(item.id, {
          mode: 'sequence',
          chunkId: currentChunk.id,
          results: chunkResults.map(r => ({
            correct: r.correct,
            expected: r.expected,
            answered: r.answered,
          })),
          totalMs: Date.now() - startTime,
        }).catch(() => {});
      }

      if (spacedChunkIdx + 1 < chunkMastery.length) {
        setSpacedChunkIdx(prev => prev + 1);
        setSpacedLineIdx(0);
      } else {
        setDone(true);
      }
    }
    setAnswer('');
    setShowResult(null);
  }

  async function savePractice(practiceMode, practiceResults) {
    const chunkId = findChunkForLine(item, currentIdx);
    await submitMemoryPractice(item.id, {
      mode: practiceMode,
      chunkId,
      results: practiceResults.map(r => ({
        correct: r.correct,
        word: r.expected?.split(' ')[0],
        element: r.element || null,
        expected: r.expected,
        answered: r.answered,
      })),
      totalMs: Date.now() - startTime,
    }).catch(() => {});
  }
}

/**
 * Generate graduated hints based on mastery level.
 * hintLevel 0: show first letter of each word + word length
 * hintLevel 1: show first letter of every other word
 * hintLevel 2: show word count only
 * hintLevel 3: no hints
 */
function generateHint(text, hintLevel) {
  if (hintLevel >= 3) return null;

  const words = text.split(/\s+/);

  if (hintLevel === 0) {
    // Full hints: first letter + underscores for length
    return words.map(w => {
      const clean = w.replace(/[,.\-!?'"]/g, '');
      if (clean.length <= 1) return w;
      return w[0] + '_'.repeat(clean.length - 1) + w.slice(clean.length);
    }).join(' ');
  }

  if (hintLevel === 1) {
    // Partial: first letter of every other word
    return words.map((w, i) => {
      if (i % 2 === 0) {
        const clean = w.replace(/[,.\-!?'"]/g, '');
        return clean.length > 1 ? w[0] + '___' : w;
      }
      return '____';
    }).join(' ');
  }

  // Minimal: word count only
  return `(${words.length} words)`;
}

function ChunkMasteryOverview({ item }) {
  const [expanded, setExpanded] = useState(false);
  const chunks = item.content?.chunks || [];
  if (!chunks.length) return null;

  return (
    <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-3 text-left hover:bg-port-bg/50 transition-colors"
      >
        <span className="text-gray-400 text-xs font-medium">Chunk Mastery</span>
        <ChevronDown size={14} className={`text-gray-500 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-1.5">
          {chunks.map(chunk => {
            const stats = item.mastery?.chunks?.[chunk.id];
            const accuracy = stats?.attempts > 0 ? Math.round((stats.correct / stats.attempts) * 100) : 0;
            const barColor = accuracy >= 80 ? 'bg-port-success' : accuracy >= 40 ? 'bg-port-warning' : 'bg-gray-600';

            return (
              <div key={chunk.id} className="flex items-center gap-2">
                <span className="text-xs text-gray-500 w-16 truncate">{chunk.label}</span>
                <div className="flex-1 h-1.5 bg-port-border rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${barColor}`} style={{ width: `${accuracy}%` }} />
                </div>
                <span className="text-xs font-mono text-gray-500 w-10 text-right">{accuracy}%</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SpeedRunLine({ line, index, onResult }) {
  const [revealed, setRevealed] = useState(false);
  const [marked, setMarked] = useState(null);

  function reveal() {
    if (!revealed) setRevealed(true);
  }

  function mark(correct) {
    setMarked(correct);
    onResult(correct);
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-gray-600 text-xs w-6 text-right shrink-0">{index + 1}</span>
      {!revealed ? (
        <button
          onClick={reveal}
          className="flex-1 text-left px-3 py-1.5 bg-port-bg border border-port-border rounded text-gray-600 hover:text-gray-400 hover:border-port-accent/30 transition-colors text-sm"
        >
          Tap to reveal...
        </button>
      ) : (
        <div className="flex-1 flex items-center gap-2">
          <span className={`text-sm flex-1 ${marked === true ? 'text-port-success' : marked === false ? 'text-port-error' : 'text-white'}`}>
            {line.text}
          </span>
          {marked === null && (
            <div className="flex gap-1 shrink-0">
              <button onClick={() => mark(true)} className="p-1 text-port-success hover:bg-port-success/10 rounded"><Check size={14} /></button>
              <button onClick={() => mark(false)} className="p-1 text-port-error hover:bg-port-error/10 rounded"><X size={14} /></button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProgressBar({ current, total }) {
  const pct = Math.round((current / total) * 100);
  return (
    <div className="w-full h-1.5 bg-port-border rounded-full overflow-hidden">
      <div className="h-full bg-port-accent rounded-full transition-all" style={{ width: `${pct}%` }} />
    </div>
  );
}

function fuzzyMatch(input, expected) {
  const normalize = s => s.toLowerCase().replace(/[,.\-!?'"]/g, '').replace(/\s+/g, ' ').trim();
  const a = normalize(input);
  const b = normalize(expected);
  if (a === b) return true;
  // Allow 80% word match
  const aWords = a.split(' ');
  const bWords = b.split(' ');
  const matches = bWords.filter(w => aWords.includes(w)).length;
  return matches / bWords.length >= 0.8;
}

function findChunkForLine(item, lineIndex) {
  for (const chunk of item.content?.chunks || []) {
    const [start, end] = chunk.lineRange;
    if (lineIndex >= start && lineIndex <= end) return chunk.id;
  }
  return null;
}
