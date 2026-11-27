import { useState, useEffect, useRef, useCallback } from 'react';
import { Check, X } from 'lucide-react';
import useMounted from '../../../../hooks/useMounted';
import { shouldIgnoreGlobalKey } from '../../../../lib/a11yKeyboard.js';
import { buildCognitiveResult, scoreDigitSpanRecall } from '../cognitiveScoring';
import DrillHeader from './DrillHeader';

export default function DigitSpanRunner({ drill, drillIndex, drillCount, onComplete, isTraining }) {
  const sequences = drill.sequences || [];
  const direction = drill.config?.direction === 'backward' ? 'backward' : 'forward';
  const showMs = drill.config?.showMs || 1000;

  const [seqIdx, setSeqIdx] = useState(0);
  const [phase, setPhase] = useState('show'); // 'show' | 'recall'
  const [shownIdx, setShownIdx] = useState(-1); // which digit is visible (-1 blank)
  const [input, setInput] = useState('');
  const [feedback, setFeedback] = useState(null); // training-mode reveal
  const answersRef = useRef([]);
  const recallStartRef = useRef(0);
  const startedAtRef = useRef(Date.now());
  const mountedRef = useMounted();
  const inputRef = useRef(null);

  const finish = useCallback(() => {
    const questions = answersRef.current.filter(Boolean);
    onComplete(buildCognitiveResult({ type: 'digit-span', drill, questions, totalMs: Date.now() - startedAtRef.current }));
  }, [drill, onComplete]);

  const finishRef = useRef(finish);
  finishRef.current = finish;

  // Reveal the current sequence one digit at a time, then switch to recall.
  useEffect(() => {
    if (seqIdx >= sequences.length) { finishRef.current(); return; }
    setPhase('show');
    setInput('');
    setFeedback(null);
    setShownIdx(-1);
    const digits = sequences[seqIdx].digits || [];
    const gap = 200;
    const timers = [];
    let t = 600;
    digits.forEach((_, di) => {
      timers.push(setTimeout(() => { if (mountedRef.current) setShownIdx(di); }, t));
      t += showMs;
      timers.push(setTimeout(() => { if (mountedRef.current) setShownIdx(-1); }, t));
      t += gap;
    });
    timers.push(setTimeout(() => {
      if (!mountedRef.current) return;
      setPhase('recall');
      recallStartRef.current = Date.now();
    }, t));
    return () => timers.forEach(clearTimeout);
  }, [seqIdx]);

  useEffect(() => { if (phase === 'recall') inputRef.current?.focus(); }, [phase]);

  // Enter advances past the training reveal from here rather than from an
  // `autoFocus` on the Next button: the Enter that submitted the answer is still
  // down when that button mounts and takes focus, so the browser activates it
  // off the same keystroke (its keypress/keyup, or the first auto-repeat) and
  // the reveal is gone in the tick it appeared. `shouldIgnoreGlobalKey` drops
  // auto-repeat, so one press advances once.
  useEffect(() => {
    if (!feedback) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Enter' || shouldIgnoreGlobalKey(e)) return;
      e.preventDefault();
      setSeqIdx(i => i + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [feedback]);

  const advance = useCallback((answeredStr) => {
    const digits = sequences[seqIdx].digits || [];
    const { question, expected, answeredRaw } = scoreDigitSpanRecall({
      digits,
      direction,
      index: seqIdx,
      answeredStr,
      responseMs: Date.now() - recallStartRef.current,
    });
    answersRef.current[seqIdx] = question;
    if (isTraining) {
      setFeedback({ expected, answered: answeredRaw, correct: question.correct });
    } else {
      setSeqIdx(i => i + 1);
    }
  }, [sequences, seqIdx, direction, isTraining]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (phase !== 'recall' || feedback) return;
    advance(input);
  };

  const digits = sequences[seqIdx]?.digits || [];
  const progressPct = sequences.length > 0 ? (seqIdx / sequences.length) * 100 : 0;

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <DrillHeader type="digit-span" isTraining={isTraining} drillIndex={drillIndex} drillCount={drillCount} />

      <p className="text-center text-sm text-gray-400">
        Memorize the digits, then type them{' '}
        <span className="text-rose-400 font-semibold">{direction === 'backward' ? 'in reverse' : 'in order'}</span>.
      </p>

      <div className="text-center py-6 sm:py-10 min-h-[6rem] sm:min-h-[8rem] flex items-center justify-center">
        {phase === 'show' ? (
          // Reserve the slot with a non-breaking space in the blank gaps so the
          // digit's line box never collapses — otherwise the flex container
          // shrinks between flashes and the form below jumps up (issue: digit
          // flashing shifts layout).
          <div className="text-6xl sm:text-7xl font-mono font-bold text-white tabular-nums leading-none">
            {shownIdx >= 0 ? digits[shownIdx] : ' '}
          </div>
        ) : feedback ? (
          <div className="flex flex-col items-center gap-2">
            {feedback.correct
              ? <Check size={40} className="text-port-success" />
              : <X size={40} className="text-port-error" />}
            <div className="text-sm text-gray-400">Expected</div>
            <div className="text-2xl sm:text-3xl font-mono font-bold text-port-success tracking-widest">{feedback.expected}</div>
            {!feedback.correct && feedback.answered && (
              <div className="text-base sm:text-lg font-mono text-port-error line-through">{feedback.answered}</div>
            )}
          </div>
        ) : (
          <div className="text-lg sm:text-xl text-gray-500">Recall the {direction === 'backward' ? 'reversed ' : ''}sequence</div>
        )}
      </div>

      {phase === 'recall' && !feedback && (
        <form onSubmit={handleSubmit} className="flex gap-2 sm:gap-3 items-center">
          <input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={input}
            onChange={e => setInput(e.target.value.replace(/\D/g, ''))}
            placeholder="Digits"
            aria-label="Your answer"
            autoFocus
            className="flex-1 min-w-0 bg-port-bg border border-port-border rounded-lg px-3 py-2.5 sm:px-4 sm:py-3 text-xl sm:text-2xl font-mono text-white text-center tracking-widest placeholder-gray-600 focus:border-rose-400 focus:outline-none"
          />
          <button type="submit" className="shrink-0 px-4 py-2.5 sm:px-6 sm:py-3 bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/40 font-medium rounded-lg transition-colors">
            Enter
          </button>
        </form>
      )}

      {phase === 'recall' && !feedback && (
        <div className="text-center">
          <button type="button" onClick={() => advance('')} className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
            Skip
          </button>
        </div>
      )}

      {feedback && (
        <button
          type="button"
          onClick={() => setSeqIdx(i => i + 1)}
          className="w-full px-6 py-3 bg-port-accent-2 hover:bg-port-accent-2/80 text-port-on-accent-2 font-medium rounded-lg transition-colors"
        >
          Next
        </button>
      )}

      <div className="space-y-1">
        <div className="flex justify-between text-xs text-gray-500">
          <span>Round {Math.min(seqIdx + 1, sequences.length)} of {sequences.length}</span>
          <span>{Math.round(progressPct)}%</span>
        </div>
        <div className="w-full h-1.5 bg-port-border rounded-full overflow-hidden">
          <div className="h-full bg-rose-400/60 transition-all" style={{ width: `${progressPct}%` }} />
        </div>
      </div>
    </div>
  );
}
