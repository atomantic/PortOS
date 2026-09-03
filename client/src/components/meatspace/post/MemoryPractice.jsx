import { useState, useRef, useEffect, useMemo } from 'react';
import { ChevronLeft, Check, X, SkipForward, RotateCcw, Target, ChevronDown, Loader, ShieldCheck } from 'lucide-react';
import { submitMemoryPractice, getChunkMastery, getMemoryItem, attestMemoryMastery } from '../../../services/api';
import ProgressBar from '../../ui/ProgressBar';
import PostCompletionActions from './PostCompletionActions';
import { startRetryableSave } from './completionSave';

// Exported so the Practice Library (practiceCatalog.js) derives its study-mode
// rows from this list rather than re-typing them — a new mode shows up in the
// catalog for free, which is the whole point of that page.
export const MODES = [
  { id: 'learn', label: 'Learn', desc: 'Progressive reveal — read and absorb line by line' },
  { id: 'fill-blank', label: 'Fill in the Blank', desc: 'Fill missing words in partially shown lines' },
  { id: 'sequence', label: 'Sequence Recall', desc: 'Given a line, type what comes next' },
  { id: 'speed-run', label: 'Speed Run', desc: 'Recite the full sequence as fast as possible' },
  { id: 'spaced', label: 'Spaced Repetition', desc: 'Focus on your weakest chunks with graduated hints' },
];

// The routable practice modes (`/post/memory/:itemId/:mode`). PostTab validates
// the URL segment against this list and degrades an unknown one to the picker,
// mirroring MorseTrainer's MORSE_MODE_IDS (issue #3249).
export const MEMORY_PRACTICE_MODE_IDS = MODES.map(m => m.id);

/**
 * Route-facing entry point: resolves `itemId` to a memory item, then renders the
 * practice runner. `item` is an optional seed the caller already has in hand (a
 * fresh navigation from the list) — a cold deep link has none, so the item is
 * fetched. An id that doesn't resolve renders a not-found fallback rather than a
 * blank panel, per the deep-link contract in AGENTS.md.
 */
export default function MemoryPractice({ itemId, item: seedItem, mode, onSelectMode, onExitMode, onBack, onContinue }) {
  const [loadedItem, setLoadedItem] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const item = loadedItem || seedItem;

  useEffect(() => {
    if (!itemId) return;
    let cancelled = false;
    setLoadedItem(null);
    setNotFound(false);
    getMemoryItem(itemId)
      .then(data => { if (!cancelled) { if (data) setLoadedItem(data); else if (!seedItem) setNotFound(true); } })
      .catch(err => {
        console.warn(`⚠️ Failed to load memory item ${itemId}: ${err.message}`);
        if (!cancelled && !seedItem) setNotFound(true);
      });
    return () => { cancelled = true; };
  }, [itemId, seedItem]);

  function handleMasteryChange(nextMastery, nextSchedule) {
    setLoadedItem(current => ({
      ...(current || seedItem),
      mastery: nextMastery,
      ...(nextSchedule ? { schedule: nextSchedule } : {}),
    }));
  }

  if (notFound) {
    return (
      <div className="space-y-4 max-w-2xl">
        <div className="flex items-center gap-3">
          <button aria-label="Back" onClick={onBack} className="text-gray-400 hover:text-white transition-colors">
            <ChevronLeft size={20} />
          </button>
          <h2 className="text-xl font-bold text-white">Item not found</h2>
        </div>
        <p className="text-gray-400 text-sm">
          No memory item with id <span className="font-mono text-gray-300">{itemId}</span> — it may have been deleted.
        </p>
        <button
          onClick={onBack}
          className="px-4 py-2 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
        >
          Back to Memory Builder
        </button>
      </div>
    );
  }

  if (!item) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <Loader size={32} className="text-emerald-400 animate-spin" />
        <div className="text-gray-400">Loading item...</div>
      </div>
    );
  }

  return (
    <MemoryPracticeRunner
      item={item}
      mode={mode}
      onSelectMode={onSelectMode}
      onExitMode={onExitMode}
      onBack={onBack}
      onContinue={onContinue}
      onMasteryChange={handleMasteryChange}
    />
  );
}

// The practice runner itself. `mode` is URL-driven; PostTab keys this component
// on it, so every mode entry (and every return to the picker) mounts fresh —
// no manual per-run state reset is needed.
function MemoryPracticeRunner({ item, mode, onSelectMode, onExitMode, onBack, onContinue, onMasteryChange }) {
  const [results, setResults] = useState([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [answer, setAnswer] = useState('');
  const [showResult, setShowResult] = useState(null); // null | 'correct' | 'wrong'
  const [done, setDone] = useState(false);
  const [startTime] = useState(Date.now());
  const inputRef = useRef(null);
  const spacedSavesRef = useRef([]);
  const [mastery, setMastery] = useState(item.mastery || { overallPct: 0, chunks: {}, elements: {}, retention: { status: 'learning' } });
  const [attestConfirming, setAttestConfirming] = useState(false);
  const [attesting, setAttesting] = useState(false);
  const [attestError, setAttestError] = useState('');

  // The route renders its seed immediately, then replaces it with the
  // authoritative item from the server. Keep the runner's local display in
  // step so a stale navigation seed cannot resurrect an attestation or other
  // mastery change that was already persisted.
  useEffect(() => {
    setMastery(item.mastery || { overallPct: 0, chunks: {}, elements: {}, retention: { status: 'learning' } });
  }, [item.id, item.mastery]);

  // Spaced repetition state
  const [chunkMastery, setChunkMastery] = useState(null);
  const [spacedChunkIdx, setSpacedChunkIdx] = useState(0);
  const [spacedLineIdx, setSpacedLineIdx] = useState(0);

  const lines = item.content?.lines || [];
  const chunks = item.content?.chunks || [];
  const retention = mastery.retention || { status: 'learning' };
  const spotCheckTime = Date.parse(retention.spotCheckAt ?? '');
  const spotCheckDue = (retention.status === 'attested' || retention.status === 'mastered')
    && !retention.spotCheckCompletedAt
    && Number.isFinite(spotCheckTime)
    && spotCheckTime <= Date.now();

  async function confirmAttestation() {
    setAttesting(true);
    setAttestError('');
    const result = await attestMemoryMastery(item.id, { silent: true }).catch(() => null);
    setAttesting(false);
    if (result?.mastery) {
      setMastery(result.mastery);
      onMasteryChange(result.mastery, result.schedule);
      setAttestConfirming(false);
    } else setAttestError('Could not save mastery. Please try again.');
  }
  const fillBlankLine = lines[currentIdx] || null;
  const fillBlankText = fillBlankLine?.text || '';
  const fillBlankWords = fillBlankText.split(/\s+/).filter(Boolean);
  // Blank out ~40% of words — recompute when line text changes
  const blanks = useMemo(() => {
    if (mode !== 'fill-blank' || !fillBlankText) return new Set();
    const words = fillBlankText.split(/\s+/).filter(Boolean);
    const blankSet = new Set();
    const count = Math.max(1, Math.floor(words.length * 0.4));
    while (blankSet.size < count && blankSet.size < words.length) {
      blankSet.add(Math.floor(Math.random() * words.length));
    }
    return blankSet;
  }, [mode, fillBlankText]);

  useEffect(() => {
    if (mode && inputRef.current) inputRef.current.focus();
  }, [mode, currentIdx, spacedLineIdx]);

  // Load chunk mastery when entering spaced mode
  useEffect(() => {
    if (mode === 'spaced') {
      getChunkMastery(item.id).then(data => {
        setChunkMastery(data || []);
      }).catch(err => { console.warn('⚠️ Failed to load chunk mastery: ' + err.message); setChunkMastery([]); });
    }
  }, [mode, item.id]);

  // Drive terminal transitions from an effect, never during render. The render
  // fallbacks below (chunk exhausted, line exhausted, sequence exhausted) return null
  // for a frame while this effect advances or marks the session done. Spaced
  // chunks persist as they advance; other modes wait for the completion choice.
  useEffect(() => {
    if (done) return;
    if (mode === 'spaced') {
      if (!chunkMastery || chunkMastery.length === 0) return;
      const currentChunk = chunkMastery[spacedChunkIdx];
      if (!currentChunk) {
        setDone(true);
        return;
      }
      const [chunkStart, chunkEnd] = currentChunk.lineRange;
      const chunkLines = lines.slice(chunkStart, chunkEnd + 1).filter(l => l.text.trim());
      if (!chunkLines[spacedLineIdx]) {
        setSpacedChunkIdx(prev => prev + 1);
        setSpacedLineIdx(0);
        setAnswer('');
        setShowResult(null);
      }
    } else if (mode === 'sequence' && !lines[currentIdx + 1]) {
      finishSequence();
    }
  }, [mode, chunkMastery, spacedChunkIdx, spacedLineIdx, currentIdx, done]);

  // Back goes up exactly one level: from a running mode (or the results screen)
  // to the mode picker via `onExitMode`, and from the picker out to the item
  // list via `onBack` — matching how ElementsSong's sub-modes exit, and keeping
  // the button in step with the URL now that the mode is a route segment.
  if (!mode) {
    return (
      <div className="space-y-6 max-w-4xl">
        <div className="flex items-center gap-3">
          <button aria-label="Back" onClick={onBack} className="text-gray-400 hover:text-white transition-colors">
            <ChevronLeft size={20} />
          </button>
          <h2 className="text-xl font-bold text-white">{item.title}</h2>
        </div>

        <p className="text-gray-400 text-sm">Choose a practice mode:</p>

        <div className="bg-port-card border border-port-border rounded-lg p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-start gap-3">
            <ShieldCheck size={20} className={retention.status === 'lapsed' ? 'text-amber-400' : 'text-emerald-400'} />
            <div>
              <div className="text-sm font-medium text-white">
                {retention.status === 'attested' && 'Mastery attested'}
                {retention.status === 'mastered' && (retention.spotCheckCompletedAt ? 'Mastery verified permanently' : 'Mastery verified')}
                {retention.status === 'lapsed' && 'Review resumed'}
                {retention.status === 'learning' && 'Still learning'}
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                {retention.status === 'attested' && 'One future spot check will verify this permanently.'}
                {retention.status === 'mastered' && (retention.spotCheckCompletedAt ? 'No more time decay or scheduled reviews.' : 'One future spot check remains.')}
                {retention.status === 'lapsed' && 'A missed spot check returned this item to the routine.'}
                {retention.status === 'learning' && 'Already know it? Attest now and verify it once later.'}
              </div>
            </div>
          </div>
          {retention.status === 'learning' && (
            attestConfirming ? (
              <div className="flex items-center gap-2">
                <button onClick={() => setAttestConfirming(false)} disabled={attesting} className="min-h-11 px-3 text-sm text-gray-400 hover:text-white">Cancel</button>
                <button onClick={confirmAttestation} disabled={attesting} className="min-h-11 px-3 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg">
                  {attesting ? 'Saving...' : 'Yes, I know this'}
                </button>
              </div>
            ) : (
              <button onClick={() => setAttestConfirming(true)} className="shrink-0 min-h-11 px-3 text-sm border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 rounded-lg">
                I already know this
              </button>
            )
          )}
          {attestError && <div role="alert" className="text-xs text-port-error">{attestError}</div>}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {MODES.map(m => (
            <button
              key={m.id}
              onClick={() => onSelectMode(m.id)}
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
          <ChunkMasteryOverview item={{ ...item, mastery }} />
        )}
      </div>
    );
  }

  if (done) {
    const exposureOnly = mode === 'learn';
    const correct = results.filter(r => r.correct).length;
    const pct = results.length > 0 ? Math.round((correct / results.length) * 100) : 0;
    const scoreColor = pct >= 80 ? 'text-port-success' : pct >= 50 ? 'text-port-warning' : 'text-port-error';

    return (
      <div className="space-y-6 max-w-2xl">
        <div className="flex items-center gap-3">
          <button aria-label="Back" onClick={onExitMode} className="text-gray-400 hover:text-white transition-colors">
            <ChevronLeft size={20} />
          </button>
          <h2 className="text-xl font-bold text-white">Practice Complete</h2>
        </div>

        <div className="bg-port-card border border-port-border rounded-lg p-6 text-center">
          {exposureOnly ? (
            <>
              <div className="text-2xl font-semibold text-port-accent mb-2">Study complete</div>
              <div className="text-gray-400 text-sm">Exposure recorded; no retrieval score or mastery update.</div>
            </>
          ) : (
            <>
              <div className={`text-5xl font-bold font-mono ${scoreColor} mb-2`}>{pct}%</div>
              <div className="text-gray-400 text-sm">{correct} of {results.length} correct</div>
            </>
          )}
          <div className="text-gray-500 text-xs mt-1">
            {Math.round((Date.now() - startTime) / 1000)}s elapsed
          </div>
        </div>

        {/* Show wrong answers */}
        {!exposureOnly && results.filter(r => !r.correct).length > 0 && (
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

        <div className="space-y-3">
          <PostCompletionActions
            onSave={() => saveAndExit(false)}
            onContinue={() => saveAndExit(true)}
          />
          <button
            onClick={onExitMode}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-gray-400 hover:text-white transition-colors"
          >
            <RotateCcw size={16} />
            Practice Again
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
            <button aria-label="Back" onClick={onExitMode} className="text-gray-400 hover:text-white transition-colors">
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
      // All chunks done — the terminal-transition effect saves results and sets done.
      return null;
    }

    const [chunkStart, chunkEnd] = currentChunk.lineRange;
    const chunkLines = lines.slice(chunkStart, chunkEnd + 1).filter(l => l.text.trim());
    const currentLine = chunkLines[spacedLineIdx];

    if (!currentLine) {
      // Move to next chunk — handled by the terminal-transition effect.
      return null;
    }

    // Graduated hints based on hintLevel:
    // 0 = show first letter of each word, 1 = show first letters of some, 2 = show word count only, 3 = no hints
    const hintLevel = currentChunk.hintLevel;
    const hintText = generateHint(currentLine.text, hintLevel);

    return (
      <div className="space-y-6 max-w-2xl">
        <div className="flex items-center gap-3">
          <button aria-label="Back" onClick={onExitMode} className="text-gray-400 hover:text-white transition-colors">
            <ChevronLeft size={20} />
          </button>
          <h2 className="text-lg font-bold text-white">Spaced — {item.title}</h2>
          <span className="text-gray-500 text-sm ml-auto">
            Chunk {spacedChunkIdx + 1}/{chunkMastery.length} • Line {spacedLineIdx + 1}/{chunkLines.length}
          </span>
        </div>

        <PracticeProgress current={spacedChunkIdx * 10 + spacedLineIdx + 1} total={chunkMastery.length * 10} />

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
              aria-label="Your answer"
              ref={inputRef}
              value={answer}
              onChange={e => setAnswer(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleCheckSpacedAnswer(currentLine.text, currentChunk.id); } }}
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
                onClick={() => handleCheckSpacedAnswer(currentLine.text, currentChunk.id)}
                disabled={!answer.trim()}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                <Check size={16} />
                Check
              </button>
              <button
                aria-label="Skip"
                onClick={() => { setAnswer(''); handleCheckSpacedAnswer(currentLine.text, currentChunk.id, true); }}
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

  // LEARN mode — progressive reveal (reading view, widened for desktop)
  if (mode === 'learn') {
    return (
      <div className="space-y-6 max-w-4xl">
        <div className="flex items-center gap-3">
          <button aria-label="Back" onClick={onExitMode} className="text-gray-400 hover:text-white transition-colors">
            <ChevronLeft size={20} />
          </button>
          <h2 className="text-lg font-bold text-white">Learn — {item.title}</h2>
          <span className="text-gray-500 text-sm ml-auto">{currentIdx + 1} / {lines.length}</span>
        </div>

        <PracticeProgress current={currentIdx + 1} total={lines.length} />

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
              onClick={() => { setDone(true); setResults([]); }}
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
      // Saved + marked done by the terminal-transition effect.
      return null;
    }

    return (
      <div className="space-y-6 max-w-2xl">
        <div className="flex items-center gap-3">
          <button aria-label="Back" onClick={onExitMode} className="text-gray-400 hover:text-white transition-colors">
            <ChevronLeft size={20} />
          </button>
          <h2 className="text-lg font-bold text-white">Sequence — {item.title}</h2>
          <span className="text-gray-500 text-sm ml-auto">{currentIdx + 1} / {lines.length - 1}</span>
        </div>

        <PracticeProgress current={currentIdx + 1} total={lines.length - 1} />

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
              aria-label="Your answer"
              ref={inputRef}
              value={answer}
              onChange={e => setAnswer(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleCheckSequenceAnswer(expectedLine.text); } }}
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
                onClick={() => handleCheckSequenceAnswer(expectedLine.text)}
                disabled={!answer.trim()}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                <Check size={16} />
                Check
              </button>
              <button
                aria-label="Skip"
                onClick={() => { setAnswer(''); handleCheckSequenceAnswer(expectedLine.text, true); }}
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
          <button aria-label="Back" onClick={onExitMode} className="text-gray-400 hover:text-white transition-colors">
            <ChevronLeft size={20} />
          </button>
          <h2 className="text-lg font-bold text-white">Fill Blank — {item.title}</h2>
          <span className="text-gray-500 text-sm ml-auto">{currentIdx + 1} / {lines.length}</span>
        </div>

        <PracticeProgress current={currentIdx + 1} total={lines.length} />

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
                onKeyDown={e => { if (e.key === 'Enter') handleCheckFillBlank(blankWords); }}
                placeholder={`${blankWords.length} word${blankWords.length > 1 ? 's' : ''} missing...`}
                aria-label="Missing words"
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
                onClick={() => handleCheckFillBlank(blankWords)}
                disabled={!answer.trim()}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                <Check size={16} />
                Check
              </button>
              <button
                aria-label="Skip"
                onClick={() => { setAnswer(''); handleCheckFillBlank(blankWords, true); }}
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

  // SPEED RUN mode — show all lines, check how many you can recite (reading view, widened)
  if (mode === 'speed-run') {
    return (
      <div className="space-y-6 max-w-4xl">
        <div className="flex items-center gap-3">
          <button aria-label="Back" onClick={onExitMode} className="text-gray-400 hover:text-white transition-colors">
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
            onClick={() => setDone(true)}
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

  function handleCheckSequenceAnswer(expected, skipped = false) {
    const result = checkSequenceAnswer(answer, expected, skipped);
    setResults(prev => [...prev, result]);
    setShowResult(result.correct ? 'correct' : 'wrong');
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
    setDone(true);
  }

  function handleCheckFillBlank(blankWords, skipped = false) {
    const result = checkFillBlank(answer, blankWords, skipped);
    setResults(prev => [...prev, result]);
    setShowResult(result.correct ? 'correct' : 'wrong');
  }

  function nextFillBlank() {
    if (currentIdx + 1 >= lines.length) {
      setDone(true);
    } else {
      setCurrentIdx(prev => prev + 1);
      setAnswer('');
      setShowResult(null);
    }
  }

  function handleCheckSpacedAnswer(expected, chunkId, skipped = false) {
    const result = checkSpacedAnswer(answer, expected, chunkId, skipped);
    setResults(prev => [...prev, result]);
    setShowResult(result.correct ? 'correct' : 'wrong');
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
      // A due retention audit is scored over the WHOLE spaced run. Saving each
      // chunk here would let the first chunk permanently pass/fail the item.
      if (!spotCheckDue && chunkResults.length > 0) {
        const payload = {
          mode: 'sequence',
          chunkId: currentChunk.id,
          results: chunkResults.map(r => ({
            correct: r.correct,
            expected: r.expected,
            answered: r.answered,
          })),
          totalMs: Date.now() - startTime,
        };
        spacedSavesRef.current.push(startRetryableSave(() => submitMemoryPractice(item.id, payload)));
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
    if (practiceMode === 'learn') {
      await submitMemoryPractice(item.id, {
        mode: practiceMode,
        chunkId: null,
        results: [],
        totalMs: Date.now() - startTime,
      });
      return;
    }
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
    });
  }

  async function saveAndExit(continueDaily) {
    // Spaced repetition persists each completed chunk as the user advances;
    // the completion action waits for those writes and retries failures. A due
    // spot check instead submits one aggregate result at this explicit finish
    // boundary so no individual chunk can decide the whole audit.
    if (mode === 'spaced' && spotCheckDue) {
      await submitMemoryPractice(item.id, {
        mode: 'sequence',
        chunkId: null,
        results: results.map(result => ({
          correct: result.correct,
          expected: result.expected,
          answered: result.answered,
          chunkId: result.chunkId,
        })),
        totalMs: Date.now() - startTime,
      });
    } else if (mode === 'spaced') await Promise.all(spacedSavesRef.current.map(save => save()));
    else await savePractice(mode, results);
    if (continueDaily) onContinue();
    else onBack();
  }
}

/**
 * Generate graduated hints based on mastery level.
 * hintLevel 0: show first letter of each word + word length
 * hintLevel 1: show first letter of every other word
 * hintLevel 2: show word count only
 * hintLevel 3: no hints
 */
export function generateHint(text, hintLevel) {
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
            const accuracy = typeof stats?.masteredAt === 'string'
              ? 100
              : stats?.attempts > 0 ? Math.round((stats.correct / stats.attempts) * 100) : 0;
            const barTone = accuracy >= 80 ? 'success' : accuracy >= 40 ? 'warning' : 'muted';

            return (
              <div key={chunk.id} className="flex items-center gap-2">
                <span className="text-xs text-gray-500 w-16 truncate">{chunk.label}</span>
                <ProgressBar
                  percent={accuracy}
                  tone={barTone}
                  track="border"
                  className="flex-1"
                  label={`${chunk.label} mastery`}
                />
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
            <div className="flex gap-2 shrink-0">
              <button onClick={() => mark(true)} aria-label={`Mark line ${index + 1} correct`} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-port-success hover:bg-port-success/10 rounded"><Check size={14} /></button>
              <button onClick={() => mark(false)} aria-label={`Mark line ${index + 1} incorrect`} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-port-error hover:bg-port-error/10 rounded"><X size={14} /></button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// The name stays generic rather than "line 3 of 12": the spaced mode measures a
// synthetic chunk×line position, so only the percentage is meaningful across all
// four modes — and `aria-valuenow` already carries it.
function PracticeProgress({ current, total }) {
  return (
    <ProgressBar
      percent={Math.round((current / total) * 100)}
      track="border"
      label="Practice progress"
      duration={150}
    />
  );
}

export function fuzzyMatch(input, expected) {
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

export function findChunkForLine(item, lineIndex) {
  for (const chunk of item.content?.chunks || []) {
    const [start, end] = chunk.lineRange;
    if (lineIndex >= start && lineIndex <= end) return chunk.id;
  }
  return null;
}

// Pure comma-split answer checking for fill-blank mode: multiple acceptable
// words for the blanks are typed comma-separated and compared in order,
// case-insensitively. `answer` is passed explicitly (lifted from the
// component's `answer` state) so this stays free of any React closure —
// the component's handleCheckFillBlank wrapper is the only caller and owns
// the setResults/setShowResult side effects.
export function checkFillBlank(answer, blankWords, skipped = false) {
  const userWords = skipped ? [] : answer.split(',').map(w => w.trim().toLowerCase());
  const correct = blankWords.every((bw, i) => userWords[i] && userWords[i] === bw.toLowerCase());
  return {
    correct,
    expected: blankWords.join(', '),
    answered: skipped ? '' : answer,
  };
}

// Pure sequence-recall answer checking: fuzzy-matches the typed answer
// against the expected next line. `element` is always null here (kept for
// shape parity with the results list consumed elsewhere).
export function checkSequenceAnswer(answer, expected, skipped = false) {
  const isCorrect = !skipped && fuzzyMatch(answer, expected);
  return { correct: isCorrect, expected, answered: skipped ? '' : answer, element: null };
}

// Pure spaced-repetition answer checking: fuzzy-matches the typed answer
// against the expected line, tagging the result with its owning chunk id so
// per-chunk mastery can be recomputed on save.
export function checkSpacedAnswer(answer, expected, chunkId, skipped = false) {
  const isCorrect = !skipped && fuzzyMatch(answer, expected);
  return { correct: isCorrect, expected, answered: skipped ? '' : answer, chunkId };
}
