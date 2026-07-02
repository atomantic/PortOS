import { useState, useEffect, useRef, useCallback } from 'react';
import { Brain, Check, X } from 'lucide-react';
import { DRILL_LABELS } from './constants';

/**
 * Interactive runner for deterministic cognitive drills (n-back, digit-span,
 * stroop). Unlike the math/memory PostDrillRunner (single prompt → typed
 * answer), these are timed, stimulus-driven flows, so each type has its own
 * sub-runner. Every sub-runner assembles a full drill result — `{ module,
 * type, config, drillData, questions, score, totalMs }` — and hands it to
 * `onComplete`. The client score is a local estimate for the immediate results
 * view; the server recomputes it deterministically from `drillData` on save
 * (server/services/meatspacePostCognitive.js). NO provider calls anywhere.
 */
export default function PostCognitiveDrillRunner({ drill, drillIndex, drillCount, onComplete, isTraining }) {
  if (!drill) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading drill...</div>
      </div>
    );
  }

  const shared = { drill, drillIndex, drillCount, onComplete, isTraining };
  switch (drill.type) {
    case 'n-back':
      return <NBackRunner {...shared} />;
    case 'digit-span':
      return <DigitSpanRunner {...shared} />;
    case 'stroop':
      return <StroopRunner {...shared} />;
    default:
      return <div className="text-port-error text-center py-8">Unsupported cognitive drill: {drill.type}</div>;
  }
}

// Shared header: drill label + position within the session.
function DrillHeader({ type, isTraining, drillIndex, drillCount }) {
  return (
    <div className="flex items-center justify-between text-sm text-gray-400">
      <span className="flex items-center gap-1.5 text-rose-400">
        <Brain size={14} />
        {DRILL_LABELS[type] || type}
        {isTraining && ' — Training'}
      </span>
      <span>Drill {drillIndex + 1} of {drillCount}</span>
    </div>
  );
}

export function localAccuracyScore(questions) {
  if (!questions.length) return 0;
  const correct = questions.filter(q => q.correct).length;
  return Math.round((correct / questions.length) * 100);
}

// Shared result-assembly shape every sub-runner hands to `onComplete`. The
// server rescores deterministically from `drillData`/`questions` on save
// (server/services/meatspacePostCognitive.js) — this is the client-side
// mirror, and its `index`/`answered`/`responseMs` fields are what that
// rescoring depends on.
export function buildCognitiveResult({ type, drill, questions, totalMs }) {
  return {
    module: 'cognitive',
    type,
    config: drill.config,
    drillData: drill,
    questions,
    score: localAccuracyScore(questions),
    totalMs,
  };
}

// N-BACK — pure result assembly: given the full letter sequence, the lag `n`,
// and the parallel `answers` array (index-aligned with `seq`, each entry
// `{ answered: 'match'|null, responseMs }`), build the scored `questions[]`.
// Only positions `i >= n` have a defined target (there's no "n back" before
// that), so the first `n` letters are excluded — the off-by-one this guards
// against is including/excluding the boundary position `i === n` itself.
export function buildNBackQuestions(seq, n, answers) {
  return seq
    .map((letter, i) => ({ letter, i }))
    .filter(({ i }) => i >= n)
    .map(({ letter, i }) => {
      const a = answers[i] || {};
      const isTarget = seq[i] === seq[i - n];
      const answeredMatch = a.answered === 'match';
      return {
        prompt: letter,
        index: i,
        answered: a.answered ?? null,
        correct: answeredMatch === isTarget,
        responseMs: a.responseMs || 0,
      };
    });
}

// DIGIT SPAN — pure scoring for one recalled sequence. `direction` decides
// whether the expected answer is the digits in shown order ('forward') or
// reversed ('backward') — the bug this guards against is comparing the
// typed answer against the wrong ordering. Returns both the persisted
// `question` (what `finish()` assembles into the result) and the raw
// `expected`/`answeredRaw` strings the training-mode feedback UI displays.
export function scoreDigitSpanRecall({ digits, direction, index, answeredStr, responseMs }) {
  const ordered = direction === 'backward' ? [...digits].reverse() : digits;
  const expected = ordered.join('');
  const answeredRaw = (answeredStr || '').replace(/\D/g, '');
  return {
    question: {
      prompt: `${digits.length}-digit (${direction})`,
      index,
      answered: answeredRaw.length ? answeredRaw : null,
      correct: answeredRaw.length > 0 && answeredRaw === expected,
      responseMs,
      length: digits.length,
    },
    expected,
    answeredRaw,
  };
}

// STROOP — pure scoring for one trial: correct iff the picked color name
// matches the word's INK color (`trial.inkColor`), not the word text itself
// — the bug this guards against is accidentally grading against the word.
export function scoreStroopTrial({ trial, index, colorName, responseMs }) {
  return {
    prompt: trial.word,
    index,
    answered: colorName,
    correct: colorName === trial.inkColor,
    responseMs,
  };
}

// =============================================================================
// N-BACK — a letter stream; signal when the current letter matches N steps back
// =============================================================================
function NBackRunner({ drill, drillIndex, drillCount, onComplete, isTraining }) {
  const seq = drill.sequence || [];
  const n = drill.config?.n ?? 2;
  const stimulusMs = drill.config?.stimulusMs || 2500;

  const [pos, setPos] = useState(-1); // -1 = pre-roll
  const [pressed, setPressed] = useState(false); // current stimulus registered a Match press
  const answersRef = useRef(seq.map(() => ({ answered: null, responseMs: 0 })));
  const stimStartRef = useRef(0);
  const startedAtRef = useRef(Date.now());
  const mountedRef = useRef(true);
  const timeoutRef = useRef(null);

  const finish = useCallback(() => {
    const questions = buildNBackQuestions(seq, n, answersRef.current);
    onComplete(buildCognitiveResult({ type: 'n-back', drill, questions, totalMs: Date.now() - startedAtRef.current }));
  }, [drill, seq, n, onComplete]);

  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    mountedRef.current = true;
    let i = 0;
    const step = () => {
      if (!mountedRef.current) return;
      if (i >= seq.length) { finishRef.current(); return; }
      const cur = i;
      setPos(cur);
      setPressed(false);
      stimStartRef.current = Date.now();
      timeoutRef.current = setTimeout(() => { i = cur + 1; step(); }, stimulusMs);
    };
    timeoutRef.current = setTimeout(step, 800);
    return () => { mountedRef.current = false; clearTimeout(timeoutRef.current); };
  }, []);

  const registerMatch = useCallback(() => {
    setPos(curPos => {
      if (curPos < n) return curPos;
      const a = answersRef.current[curPos];
      if (a && a.answered !== 'match') {
        a.answered = 'match';
        a.responseMs = Date.now() - stimStartRef.current;
        setPressed(true);
      }
      return curPos;
    });
  }, [n]);

  // Spacebar / Enter registers a match for the current stimulus.
  useEffect(() => {
    const onKey = (e) => {
      if (e.code === 'Space' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        registerMatch();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [registerMatch]);

  const decisionTotal = Math.max(0, seq.length - n);
  const decisionDone = pos >= n ? pos - n : 0;
  const progressPct = decisionTotal > 0 ? Math.min(100, (decisionDone / decisionTotal) * 100) : 0;
  const active = pos >= 0 && pos < seq.length;

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <DrillHeader type="n-back" isTraining={isTraining} drillIndex={drillIndex} drillCount={drillCount} />

      <p className="text-center text-sm text-gray-400">
        Press <span className="text-white font-medium">Match</span> (or Space) when the letter matches the one{' '}
        <span className="text-rose-400 font-semibold">{n}</span> step{n !== 1 ? 's' : ''} back.
      </p>

      <div className="text-center py-10">
        {pos < 0 ? (
          <div className="text-xl text-gray-500">Get ready…</div>
        ) : (
          <div className={`text-7xl font-mono font-bold transition-colors ${pressed ? 'text-rose-400' : 'text-white'}`}>
            {seq[pos]}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={registerMatch}
        disabled={!active || pos < n}
        className="w-full px-6 py-4 bg-rose-500/20 hover:bg-rose-500/30 disabled:opacity-40 disabled:cursor-not-allowed text-rose-300 border border-rose-500/40 font-semibold rounded-lg transition-colors"
      >
        Match
      </button>

      <div className="space-y-1">
        <div className="flex justify-between text-xs text-gray-500">
          <span>{decisionDone} / {decisionTotal} decisions</span>
          <span>{Math.round(progressPct)}%</span>
        </div>
        <div className="w-full h-1.5 bg-port-border rounded-full overflow-hidden">
          <div className="h-full bg-rose-400/60 transition-all" style={{ width: `${progressPct}%` }} />
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// DIGIT SPAN — memorize a shown sequence, then recall it forward/backward
// =============================================================================
function DigitSpanRunner({ drill, drillIndex, drillCount, onComplete, isTraining }) {
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
  const mountedRef = useRef(true);
  const inputRef = useRef(null);

  const finish = useCallback(() => {
    const questions = answersRef.current.filter(Boolean);
    onComplete(buildCognitiveResult({ type: 'digit-span', drill, questions, totalMs: Date.now() - startedAtRef.current }));
  }, [drill, onComplete]);

  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

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

      <div className="text-center py-10 min-h-[8rem] flex items-center justify-center">
        {phase === 'show' ? (
          <div className="text-7xl font-mono font-bold text-white tabular-nums">
            {shownIdx >= 0 ? digits[shownIdx] : ''}
          </div>
        ) : feedback ? (
          <div className="flex flex-col items-center gap-2">
            {feedback.correct
              ? <Check size={40} className="text-port-success" />
              : <X size={40} className="text-port-error" />}
            <div className="text-sm text-gray-400">Expected</div>
            <div className="text-3xl font-mono font-bold text-port-success tracking-widest">{feedback.expected}</div>
            {!feedback.correct && feedback.answered && (
              <div className="text-lg font-mono text-port-error line-through">{feedback.answered}</div>
            )}
          </div>
        ) : (
          <div className="text-xl text-gray-500">Recall the {direction === 'backward' ? 'reversed ' : ''}sequence</div>
        )}
      </div>

      {phase === 'recall' && !feedback && (
        <form onSubmit={handleSubmit} className="flex gap-3">
          <input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={input}
            onChange={e => setInput(e.target.value.replace(/\D/g, ''))}
            placeholder="Digits"
            autoFocus
            className="flex-1 bg-port-bg border border-port-border rounded-lg px-4 py-3 text-2xl font-mono text-white text-center tracking-widest placeholder-gray-600 focus:border-rose-400 focus:outline-none"
          />
          <button type="submit" className="px-6 py-3 bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/40 font-medium rounded-lg transition-colors">
            Enter
          </button>
        </form>
      )}

      {phase === 'recall' && !feedback && (
        <div className="text-center">
          <button onClick={() => advance('')} className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
            Skip
          </button>
        </div>
      )}

      {feedback && (
        <button
          onClick={() => setSeqIdx(i => i + 1)}
          autoFocus
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

// =============================================================================
// STROOP — name the INK color of a color-word (ignore what the word says)
// =============================================================================
function StroopRunner({ drill, drillIndex, drillCount, onComplete, isTraining }) {
  const trials = drill.trials || [];
  const options = drill.options || [];

  const [trialIdx, setTrialIdx] = useState(0);
  const [feedback, setFeedback] = useState(null); // { correct } training reveal
  const answersRef = useRef([]);
  const trialStartRef = useRef(Date.now());
  const startedAtRef = useRef(Date.now());
  const advancingRef = useRef(false);

  const finish = useCallback(() => {
    const questions = answersRef.current.filter(Boolean);
    onComplete(buildCognitiveResult({ type: 'stroop', drill, questions, totalMs: Date.now() - startedAtRef.current }));
  }, [drill, onComplete]);

  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => { trialStartRef.current = Date.now(); advancingRef.current = false; }, [trialIdx]);

  const answer = useCallback((colorName) => {
    if (advancingRef.current || feedback) return;
    const trial = trials[trialIdx];
    if (!trial) return;
    const question = scoreStroopTrial({ trial, index: trialIdx, colorName, responseMs: Date.now() - trialStartRef.current });
    answersRef.current[trialIdx] = question;
    const isLast = trialIdx + 1 >= trials.length;
    if (isTraining) {
      setFeedback({ correct: question.correct, expected: trial.inkColor, isLast });
    } else {
      advancingRef.current = true;
      if (isLast) finishRef.current(); else setTrialIdx(i => i + 1);
    }
  }, [feedback, trials, trialIdx, isTraining]);

  const acknowledge = useCallback(() => {
    const isLast = feedback?.isLast;
    setFeedback(null);
    if (isLast) finishRef.current(); else setTrialIdx(i => i + 1);
  }, [feedback]);

  // Number keys 1..N pick the matching option.
  useEffect(() => {
    const onKey = (e) => {
      if (feedback) { if (e.key === 'Enter') { e.preventDefault(); acknowledge(); } return; }
      const idx = parseInt(e.key, 10) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < options.length) {
        e.preventDefault();
        answer(options[idx].name);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [feedback, options, answer, acknowledge]);

  const trial = trials[trialIdx];
  const progressPct = trials.length > 0 ? (trialIdx / trials.length) * 100 : 0;

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <DrillHeader type="stroop" isTraining={isTraining} drillIndex={drillIndex} drillCount={drillCount} />

      <p className="text-center text-sm text-gray-400">
        Tap the <span className="text-white font-medium">ink color</span> of the word — not what it spells.
      </p>

      <div className="text-center py-12 min-h-[8rem] flex items-center justify-center">
        {trial ? (
          <div className="text-6xl font-bold uppercase tracking-wide" style={{ color: trial.inkHex }}>
            {trial.word}
          </div>
        ) : (
          <div className="text-gray-500">Done</div>
        )}
      </div>

      {feedback ? (
        <div className="space-y-4">
          <div className={`flex items-center justify-center gap-2 ${feedback.correct ? 'text-port-success' : 'text-port-error'}`}>
            {feedback.correct ? <Check size={24} /> : <X size={24} />}
            <span className="text-sm">{feedback.correct ? 'Correct' : `Ink was ${feedback.expected}`}</span>
          </div>
          <button
            onClick={acknowledge}
            autoFocus
            className="w-full px-6 py-3 bg-port-accent-2 hover:bg-port-accent-2/80 text-port-on-accent-2 font-medium rounded-lg transition-colors"
          >
            Next
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {options.map((opt, i) => (
            <button
              key={opt.name}
              onClick={() => answer(opt.name)}
              className="flex items-center justify-center gap-2 px-4 py-4 bg-port-card hover:bg-port-bg border border-port-border rounded-lg text-white font-medium capitalize transition-colors"
            >
              <span className="w-4 h-4 rounded-full" style={{ backgroundColor: opt.hex }} aria-hidden="true" />
              {opt.name}
              <span className="text-xs text-gray-600">{i + 1}</span>
            </button>
          ))}
        </div>
      )}

      <div className="space-y-1">
        <div className="flex justify-between text-xs text-gray-500">
          <span>Trial {Math.min(trialIdx + 1, trials.length)} of {trials.length}</span>
          <span>{Math.round(progressPct)}%</span>
        </div>
        <div className="w-full h-1.5 bg-port-border rounded-full overflow-hidden">
          <div className="h-full bg-rose-400/60 transition-all" style={{ width: `${progressPct}%` }} />
        </div>
      </div>
    </div>
  );
}
